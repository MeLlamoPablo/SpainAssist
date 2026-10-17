import './helpers/no-network';
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeBody } from '../../src/llm/wire';

const text = JSON.stringify({ model: 'm', input: 'hola ñ 🇪🇸' });
const body = Buffer.from(text);

describe('request body decoding', () => {
  it('decodes zstd (pi compresses Codex requests), gzip, deflate and brotli', () => {
    expect(decodeBody(zstdCompressSync(body), 'zstd').toString()).toBe(text);
    expect(decodeBody(gzipSync(body), 'gzip').toString()).toBe(text);
    expect(decodeBody(gzipSync(body), 'x-gzip').toString()).toBe(text);
    expect(decodeBody(deflateSync(body), 'deflate').toString()).toBe(text);
    expect(decodeBody(brotliCompressSync(body), 'br').toString()).toBe(text);
  });

  it('passes identity and absent encodings through untouched', () => {
    expect(decodeBody(body, undefined)).toBe(body);
    expect(decodeBody(body, 'identity')).toEqual(body);
  });

  it('undoes stacked encodings in reverse order', () => {
    const stacked = gzipSync(zstdCompressSync(body));
    expect(decodeBody(stacked, 'zstd, gzip').toString()).toBe(text);
  });

  it('refuses what it cannot decode', () => {
    expect(() => decodeBody(body, 'compress')).toThrow(/Unsupported content-encoding compress/);
    expect(() => decodeBody(Buffer.from('not zstd'), 'zstd')).toThrow();
  });
});
