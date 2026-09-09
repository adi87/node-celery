/**
 * Normalises the differences between redis client generations so celery.js can
 * talk to any of them.
 *
 * redis@2 and redis@3 connect as soon as createClient() returns, use
 * callback-style commands and lower-case names (lpush, psubscribe), and deliver
 * pattern messages as a 'pmessage' event.
 *
 * redis@4 and redis@5 return a *disconnected* client that you must connect()
 * yourself, resolve commands as promises, name them in camelCase (lPush,
 * pSubscribe), and take the pattern-message handler as an argument to
 * pSubscribe rather than emitting an event.
 *
 * Everything here is additive: on redis@2/@3 the facade forwards straight to
 * the underlying client, so existing projects behave exactly as before.
 */

var events = require('events');
var util = require('util');

function noop() {}

/**
 * redis@4+ clients are the ones that need connecting by hand. Both markers are
 * checked because a v3 client has neither, and a user-supplied client factory
 * could hand us anything.
 */
function isModern(client) {
    return !!client
        && typeof client.connect === 'function'
        && typeof client.pSubscribe === 'function';
}

/**
 * Wraps a redis client in a uniform interface:
 *
 *   connect()                        - resolves/emits 'connect' when usable
 *   lpush(key, value)                - fire and forget
 *   get(key, cb)                     - cb(err, reply)
 *   expire(key, seconds)             - fire and forget
 *   psubscribe(pattern, onSubscribed)- emits 'pmessage' (pattern, channel, data)
 *   duplicate()                      - a second facade, not yet connected
 *   quit()                           - closes the connection
 *
 * and re-emits 'error' and 'end'.
 */
function RedisFacade(client) {
    events.EventEmitter.call(this);

    var self = this;
    self.client = client;
    self.modern = isModern(client);
    self.connected = false;

    client.on('error', function(err) {
        self.emit('error', err);
    });
    client.on('end', function() {
        self.connected = false;
        self.emit('end');
    });

    // A redis@2/@3 client is already on its way up and will announce itself.
    // Guard against a double 'connect' if connect() is also called.
    if (!self.modern) {
        client.on('connect', function() {
            if (!self.connected) {
                self.connected = true;
                self.emit('connect');
            }
        });
    }
}
util.inherits(RedisFacade, events.EventEmitter);

RedisFacade.prototype.connect = function() {
    var self = this;

    if (!self.modern) {
        // Nothing to do: the client connects itself and emits 'connect'.
        return;
    }

    // isOpen covers a client handed to us already connected, e.g. from a
    // user-supplied createClient factory.
    if (self.client.isOpen) {
        self.connected = true;
        process.nextTick(function() { self.emit('connect'); });
        return;
    }

    self.client.connect().then(function() {
        self.connected = true;
        self.emit('connect');
    }, function(err) {
        self.emit('error', err);
    });
};

RedisFacade.prototype.lpush = function(key, value) {
    var self = this;
    if (!self.modern) {
        return self.client.lpush(key, value);
    }
    return self.client.lPush(key, value).catch(function(err) {
        self.emit('error', err);
    });
};

RedisFacade.prototype.get = function(key, cb) {
    var self = this;
    cb = cb || noop;
    if (!self.modern) {
        return self.client.get(key, cb);
    }
    return self.client.get(key).then(function(reply) {
        cb(null, reply);
    }, function(err) {
        cb(err);
    });
};

RedisFacade.prototype.expire = function(key, seconds) {
    var self = this;
    if (!self.modern) {
        return self.client.expire(key, seconds);
    }
    return self.client.expire(key, seconds).catch(noop);
};

RedisFacade.prototype.psubscribe = function(pattern, onSubscribed) {
    var self = this;
    onSubscribed = onSubscribed || noop;

    if (!self.modern) {
        self.client.on('pmessage', function(pat, channel, data) {
            self.emit('pmessage', pat, channel, data);
        });
        return self.client.psubscribe(pattern, onSubscribed);
    }

    return self.client.pSubscribe(pattern, function(message, channel) {
        // redis@4+ hands over (message, channel); celery.js wants the
        // (pattern, channel, data) shape redis@3 emitted.
        self.emit('pmessage', pattern, channel, message);
    }).then(function() {
        onSubscribed();
    }, function(err) {
        self.emit('error', err);
    });
};

RedisFacade.prototype.duplicate = function() {
    return new RedisFacade(this.client.duplicate());
};

RedisFacade.prototype.quit = function() {
    var self = this;
    if (!self.modern) {
        return self.client.quit();
    }
    // quit() rejects if the client was never connected, which is a normal way
    // to end a client that failed to come up.
    if (!self.client.isOpen) {
        return;
    }
    return self.client.quit().catch(noop);
};

module.exports = {
    RedisFacade: RedisFacade,
    isModern: isModern,
    wrap: function(client) {
        return new RedisFacade(client);
    },
};
