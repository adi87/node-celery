var assert = require('assert'),
    events = require('events'),
    util = require('util'),
    compat = require('../redis-compat');

// A stand-in for redis@2/@3: connects itself, callback commands, lower-case
// names, pattern messages delivered as a 'pmessage' event.
function LegacyClient() {
    events.EventEmitter.call(this);
    this.calls = [];
    var self = this;
    process.nextTick(function() { self.emit('connect'); });
}
util.inherits(LegacyClient, events.EventEmitter);
LegacyClient.prototype.lpush = function(k, v) { this.calls.push(['lpush', k, v]); };
LegacyClient.prototype.get = function(k, cb) { this.calls.push(['get', k]); cb(null, '{"ok":1}'); };
LegacyClient.prototype.expire = function(k, s) { this.calls.push(['expire', k, s]); };
LegacyClient.prototype.psubscribe = function(p, cb) { this.calls.push(['psubscribe', p]); if (cb) cb(); };
LegacyClient.prototype.duplicate = function() { return new LegacyClient(); };
LegacyClient.prototype.quit = function() { this.calls.push(['quit']); };

// A stand-in for redis@4/@5: created disconnected, promise commands, camelCase
// names, pSubscribe takes the listener.
function ModernClient() {
    events.EventEmitter.call(this);
    this.calls = [];
    this.isOpen = false;
    this.listener = null;
}
util.inherits(ModernClient, events.EventEmitter);
ModernClient.prototype.connect = function() {
    var self = this;
    this.calls.push(['connect']);
    return Promise.resolve().then(function() { self.isOpen = true; });
};
ModernClient.prototype.lPush = function(k, v) { this.calls.push(['lPush', k, v]); return Promise.resolve(1); };
ModernClient.prototype.get = function(k) { this.calls.push(['get', k]); return Promise.resolve('{"ok":1}'); };
ModernClient.prototype.expire = function(k, s) { this.calls.push(['expire', k, s]); return Promise.resolve(1); };
ModernClient.prototype.pSubscribe = function(p, listener) {
    this.calls.push(['pSubscribe', p]);
    this.listener = listener;
    return Promise.resolve();
};
ModernClient.prototype.duplicate = function() { return new ModernClient(); };
ModernClient.prototype.quit = function() { this.calls.push(['quit']); return Promise.resolve(); };


describe('redis-compat', function() {
    describe('client detection', function() {
        it('treats a callback-style client as legacy', function() {
            assert.strictEqual(compat.isModern(new LegacyClient()), false);
        });
        it('treats a promise-style client as modern', function() {
            assert.strictEqual(compat.isModern(new ModernClient()), true);
        });
    });

    describe('legacy clients (redis@2 / redis@3)', function() {
        it('emits connect without connect() being needed', function(done) {
            var f = compat.wrap(new LegacyClient());
            f.on('connect', function() { done(); });
            f.connect(); // must not double-emit or throw
        });

        it('uses the lower-case command names', function() {
            var c = new LegacyClient(), f = compat.wrap(c);
            f.lpush('q', 'payload');
            f.expire('k', 60);
            assert.deepStrictEqual(c.calls[0], ['lpush', 'q', 'payload']);
            assert.deepStrictEqual(c.calls[1], ['expire', 'k', 60]);
        });

        it('passes get() straight through to the callback', function(done) {
            var f = compat.wrap(new LegacyClient());
            f.get('celery-task-meta-1', function(err, reply) {
                assert.strictEqual(err, null);
                assert.strictEqual(reply, '{"ok":1}');
                done();
            });
        });

        it('re-emits pmessage from the client event', function(done) {
            var c = new LegacyClient(), f = compat.wrap(c);
            f.on('pmessage', function(pattern, channel, data) {
                assert.strictEqual(pattern, 'celery-task-meta-*');
                assert.strictEqual(channel, 'celery-task-meta-1');
                assert.strictEqual(data, '{"status":"SUCCESS"}');
                done();
            });
            f.psubscribe('celery-task-meta-*');
            c.emit('pmessage', 'celery-task-meta-*', 'celery-task-meta-1', '{"status":"SUCCESS"}');
        });
    });

    describe('modern clients (redis@4 / redis@5)', function() {
        it('connects explicitly and then emits connect', function(done) {
            var c = new ModernClient(), f = compat.wrap(c);
            f.on('connect', function() {
                assert.deepStrictEqual(c.calls[0], ['connect']);
                done();
            });
            f.connect();
        });

        it('emits connect for a client that is already open', function(done) {
            var c = new ModernClient();
            c.isOpen = true;
            var f = compat.wrap(c);
            f.on('connect', function() {
                assert.deepStrictEqual(c.calls, [], 'should not reconnect an open client');
                done();
            });
            f.connect();
        });

        it('maps lpush onto lPush', function() {
            var c = new ModernClient(), f = compat.wrap(c);
            f.lpush('q', 'payload');
            assert.deepStrictEqual(c.calls[0], ['lPush', 'q', 'payload']);
        });

        it('adapts promise get() to a callback', function(done) {
            var f = compat.wrap(new ModernClient());
            f.get('celery-task-meta-1', function(err, reply) {
                assert.strictEqual(err, null);
                assert.strictEqual(reply, '{"ok":1}');
                done();
            });
        });

        it('turns pSubscribe listener args into a pmessage event', function(done) {
            var c = new ModernClient(), f = compat.wrap(c);
            f.on('pmessage', function(pattern, channel, data) {
                assert.strictEqual(pattern, 'celery-task-meta-*');
                assert.strictEqual(channel, 'celery-task-meta-1');
                assert.strictEqual(data, '{"status":"SUCCESS"}');
                done();
            });
            f.psubscribe('celery-task-meta-*', function() {
                // redis@4 hands the listener (message, channel), the reverse of
                // the order celery.js expects.
                c.listener('{"status":"SUCCESS"}', 'celery-task-meta-1');
            });
        });

        it('does not quit a client that never opened', function() {
            var c = new ModernClient(), f = compat.wrap(c);
            f.quit();
            assert.deepStrictEqual(c.calls, []);
        });

        it('duplicate() returns a facade that still needs connecting', function(done) {
            var f = compat.wrap(new ModernClient()).duplicate();
            assert.strictEqual(typeof f.connect, 'function');
            f.on('connect', function() { done(); });
            f.connect();
        });
    });
});
