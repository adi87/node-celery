# Celery client for Node.js

[![NPM Version](https://img.shields.io/npm/v/node-celery.svg)](https://img.shields.io/npm/v/node-celery.svg)
[![Downloads](https://img.shields.io/npm/dm/node-celery.svg)](https://img.shields.io/npm/dm/node-celery.svg)

Celery is an asynchronous task/job queue based on distributed
message passing. node-celery allows to queue tasks from Node.js.
If you are new to Celery check out http://celeryproject.org/

## Usage

Simple example, included as [examples/hello-world.js](https://github.com/mher/node-celery/blob/master/examples/hello-world.js):

```javascript
var celery = require('node-celery'),
	client = celery.createClient({
		CELERY_BROKER_URL: 'amqp://guest:guest@localhost:5672//',
		CELERY_RESULT_BACKEND: 'amqp://'
	});

client.on('error', function(err) {
	console.log(err);
});

client.on('connect', function() {
	client.call('tasks.echo', ['Hello World!'], function(result) {
		console.log(result);
		client.end();
	});
});
```

**Note:** When using AMQP as result backend with celery prior to version
3.1.7 the result queue needs to be non durable or it will fail with a:
Queue.declare: (406) PRECONDITION_FAILED.

```javascript
var celery = require('node-celery'),
	client = celery.createClient({
		CELERY_TASK_RESULT_DURABLE: false
	});
```

For RabbitMQ backends, the entire broker options can be passed as an object that is handed off to AMQP.
This allows you to specify parameters such as SSL keyfiles, vhost, and connection timeout among others.

```javascript
var celery = require('node-celery'),
	client = celery.createClient({
		CELERY_BROKER_OPTIONS: {
			host: 'localhost',
			port: '5672',
			login: 'guest',
			password: 'guest',
			authMechanism: 'AMQPLAIN',
			vhost: '/',
			ssl: {
				enabled: true,
				keyFile: '/path/to/keyFile.pem',
				certFile: '/path/to/certFile.pem',
				caFile: '/path/to/caFile.pem'
			}
		},
		CELERY_RESULT_BACKEND: 'amqp'
	});
```

### ETA

The ETA (estimated time of arrival) lets you set a specific date and time that is the earliest time at which your task will be executed:

```javascript
var celery = require('node-celery'),
	client = celery.createClient({
		CELERY_BROKER_URL: 'amqp://guest:guest@localhost:5672//',
	});

client.on('connect', function() {
	client.call('send-email', {
		to: 'to@example.com',
		title: 'sample email'
	}, {
		eta: new Date(Date.now() + 60 * 60 * 1000) // an hour later
	});
});
```

### Expiration

The expires argument defines an optional expiry time, a specific date and time using Date:

```javascript
var celery = require('node-celery'),
	client = celery.createClient({
		CELERY_BROKER_URL: 'amqp://guest:guest@localhost:5672//',
	});

client.on('connect', function() {
	client.call('tasks.sleep', [2 * 60 * 60], null, {
		expires: new Date(Date.now() + 60 * 60 * 1000) // expires in an hour
	});
});
```

### Backends

The backend is used to store task results. Currently AMQP (RabbitMQ) and Redis backends are supported.

#### Message compression

Set `CELERY_MESSAGE_COMPRESSION` to `gzip` (or `zlib`) to compress task bodies.
Off by default.

```javascript
var client = celery.createClient({
    CELERY_BROKER_URL: 'redis://localhost/0',
    CELERY_RESULT_BACKEND: 'redis://localhost/0',
    CELERY_MESSAGE_COMPRESSION: 'gzip'
});
```

This matters most on a redis broker, which holds every queued message in RAM
(unlike rabbitmq, which pages large messages to disk). On a batch of 200
real-world listing objects, `redis MEMORY USAGE` for the queued message drops
from **2.34 MB to 0.22 MB** — 10.7x — for about 13 ms of deflate on the
publisher and 1 ms of inflate on the worker.

Two implementation details, both easy to get wrong:

* kombu decides whether to decompress from the message's **`headers.compression`**
  value, not from `content-encoding`.
* kombu registers `application/x-gzip` against python's `zlib.compress` /
  `zlib.decompress` — the zlib format (RFC 1950), **not** the gzip file format
  (RFC 1952). Bodies are therefore produced with `zlib.deflate`; using
  `zlib.gzip` would make the worker fail to decompress.

`bzip2`, `lzma` and `brotli` are rejected with a clear error rather than
silently sending an uncompressed body: Celery workers accept those codecs, but
node has no built-in encoder for them, so a typo would otherwise go unnoticed
until someone looked at memory use.

#### Redis client versions

Any of `redis@2`, `redis@3`, `redis@4` or `redis@5` works. The differences
between the callback-era clients (2.x/3.x) and the promise-era rewrite (4.x/5.x)
are handled in `redis-compat.js`:

* 4.x/5.x return a *disconnected* client that has to be `connect()`ed, whereas
  2.x/3.x connect themselves;
* commands are camelCase and promise-based in 4.x/5.x (`lPush`, `pSubscribe`)
  versus lower-case and callback-based in 2.x/3.x (`lpush`, `psubscribe`);
* pattern messages arrive through a listener passed to `pSubscribe` in 4.x/5.x
  instead of a `pmessage` event.

Note the dependency is declared as a range rather than `*`. With `*`, npm
installs whatever the current major is, which is how projects ended up on a
client the library could not drive.

The broker and the result backend may point at different Redis databases — they
get separate connections.

```javascript
var celery = require('node-celery'),
	client = celery.createClient({
		CELERY_BROKER_URL: 'amqp://guest:guest@localhost:5672//',
		CELERY_RESULT_BACKEND: 'redis://localhost/0'
	});

client.on('connect', function() {
	var result = client.call('tasks.add', [1, 2]);
	setTimeout(function() {
		result.get(function(data) {
			console.log(data); // data will be null if the task is not finished
		});
	}, 2000);
});
```

AMQP backend allows to subscribe to the task result and get it immediately, without polling:

```javascript
var celery = require('node-celery'),
	client = celery.createClient({
		CELERY_BROKER_URL: 'amqp://guest:guest@localhost:5672//',
		CELERY_RESULT_BACKEND: 'amqp'
	});

client.on('connect', function() {
	var result = client.call('tasks.add', [1, 2]);
	result.on('ready', function(data) {
		console.log(data);
	});
});
```

### Routing

The simplest way to route tasks to different queues is using CELERY_ROUTES configuration option:

```javascript
var celery = require('node-celery'),
	client = celery.createClient({
		CELERY_BROKER_URL: 'amqp://guest:guest@localhost:5672//',
		CELERY_ROUTES: {
			'tasks.send_mail': {
				queue: 'mail'
			}
		}
	}),
	send_mail = client.createTask('tasks.send_mail'),
	calculate_rating = client.createTask('tasks.calculate_rating');

client.on('error', function(err) {
	console.log(err);
});

client.on('connect', function() {
	send_mail.call([], {
		to: 'to@example.com',
		title: 'hi'
	}); // sends a task to the mail queue
	calculate_rating.call([], {
		item: 1345
	}); // sends a task to the default queue
});
```

