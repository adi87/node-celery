/**
 * Message body compression, matching what kombu expects on the consuming side.
 *
 * Two details matter and are easy to get wrong:
 *
 *   1. kombu decides whether to decompress from the message's
 *      `headers.compression` value -- NOT from content-encoding.
 *   2. kombu registers 'application/x-gzip' against python's zlib.compress /
 *      zlib.decompress, which is the zlib format (RFC 1950), not the gzip file
 *      format (RFC 1952). So the body has to be produced with zlib.deflate,
 *      not zlib.gzip, or the worker fails to decompress it.
 *
 * Celery's own setting is CELERY_MESSAGE_COMPRESSION, so that is the option
 * name here too.
 */

var zlib = require('zlib');

// alias -> kombu content type
var CONTENT_TYPES = {
    'gzip': 'application/x-gzip',
    'zlib': 'application/x-gzip',
    'application/x-gzip': 'application/x-gzip',
};

var UNSUPPORTED = {
    'bzip2': 'application/x-bz2',
    'bzip': 'application/x-bz2',
    'application/x-bz2': 'application/x-bz2',
    'lzma': 'application/x-lzma',
    'xz': 'application/x-lzma',
    'brotli': 'application/x-brotli',
};

/**
 * Resolves a CELERY_MESSAGE_COMPRESSION value to the kombu content type, or
 * null when compression is off. Throws on a value node cannot produce, rather
 * than silently sending an uncompressed body the worker would still accept --
 * that would hide the misconfiguration until someone looked at memory use.
 */
function contentTypeFor(compression) {
    if (!compression) {
        return null;
    }
    var key = String(compression).toLowerCase();
    if (CONTENT_TYPES[key]) {
        return CONTENT_TYPES[key];
    }
    if (UNSUPPORTED[key]) {
        throw new Error(
            'CELERY_MESSAGE_COMPRESSION=' + compression + ' is not supported by node: ' +
            'only gzip/zlib are available. Celery workers accept it, but node has no ' +
            'built-in encoder for ' + UNSUPPORTED[key] + '.');
    }
    throw new Error('Unknown CELERY_MESSAGE_COMPRESSION: ' + compression);
}

/**
 * Compresses a message body. Returns a Buffer in the zlib format kombu's
 * 'application/x-gzip' decoder expects.
 */
function compress(body, contentType) {
    if (contentType !== 'application/x-gzip') {
        throw new Error('Unsupported compression content type: ' + contentType);
    }
    return zlib.deflateSync(Buffer.from(body));
}

module.exports = {
    contentTypeFor: contentTypeFor,
    compress: compress,
    CONTENT_TYPES: CONTENT_TYPES,
};
