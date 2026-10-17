import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib';

const MAX_DECODED_BYTES = 256 * 1024 * 1024;

/**
 * Decodes a body with its `content-encoding`, for hashing and reading only: the meter forwards
 * the original bytes. pi compresses Codex requests with zstd.
 */
export function decodeBody(body: Buffer, contentEncoding: string | undefined): Buffer {
  if (!contentEncoding) return body;
  const encodings = contentEncoding
    .split(',')
    .map((encoding) => encoding.trim().toLowerCase())
    .filter(Boolean)
    .reverse();
  const options = { maxOutputLength: MAX_DECODED_BYTES };
  let out = body;
  for (const encoding of encodings) {
    switch (encoding) {
      case 'identity':
        break;
      case 'gzip':
      case 'x-gzip':
        out = gunzipSync(out, options);
        break;
      case 'deflate':
        out = inflateSync(out, options);
        break;
      case 'br':
        out = brotliDecompressSync(out, options);
        break;
      case 'zstd':
        out = zstdDecompressSync(out, options);
        break;
      default:
        throw new Error(`Unsupported content-encoding ${encoding}`);
    }
  }
  return out;
}
