var assert = require('assert'),
    zlib = require('zlib'),
    compression = require('../compression');

describe('compression', function() {
    describe('contentTypeFor', function() {
        it('is off when unset', function() {
            assert.strictEqual(compression.contentTypeFor(null), null);
            assert.strictEqual(compression.contentTypeFor(undefined), null);
            assert.strictEqual(compression.contentTypeFor(''), null);
        });

        it('maps the gzip aliases to what kombu registers', function() {
            // kombu registers 'application/x-gzip' with aliases gzip and zlib
            assert.strictEqual(compression.contentTypeFor('gzip'), 'application/x-gzip');
            assert.strictEqual(compression.contentTypeFor('zlib'), 'application/x-gzip');
            assert.strictEqual(compression.contentTypeFor('GZIP'), 'application/x-gzip');
            assert.strictEqual(compression.contentTypeFor('application/x-gzip'), 'application/x-gzip');
        });

        it('rejects codecs node cannot produce, rather than sending plain', function() {
            // Celery accepts these, but node has no built-in encoder, and
            // silently sending an uncompressed body would hide the mistake.
            assert.throws(function() { compression.contentTypeFor('bzip2'); }, /not supported by node/);
            assert.throws(function() { compression.contentTypeFor('lzma'); }, /not supported by node/);
            assert.throws(function() { compression.contentTypeFor('brotli'); }, /not supported by node/);
        });

        it('rejects an unknown value', function() {
            assert.throws(function() { compression.contentTypeFor('snappy'); }, /Unknown/);
        });
    });

    describe('compress', function() {
        it('produces the zlib format python zlib.decompress reads', function() {
            var out = compression.compress('{"a":1}', 'application/x-gzip');
            assert.ok(Buffer.isBuffer(out));
            // zlib (RFC1950) header, not the gzip (RFC1952) 0x1f 0x8b magic
            assert.strictEqual(out[0], 0x78);
            assert.notStrictEqual(out[0], 0x1f);
            // and it round-trips through inflate
            assert.strictEqual(zlib.inflateSync(out).toString(), '{"a":1}');
        });

        it('actually shrinks a realistic body', function() {
            var body = JSON.stringify({ args: [new Array(200).fill({ a: 'x'.repeat(50), b: 12345 })] });
            var out = compression.compress(body, 'application/x-gzip');
            assert.ok(out.length < body.length / 5, 'expected at least 5x, got ' + (body.length / out.length).toFixed(1) + 'x');
        });

        it('refuses a content type it did not resolve', function() {
            assert.throws(function() { compression.compress('x', 'application/x-bz2'); }, /Unsupported/);
        });
    });
});
