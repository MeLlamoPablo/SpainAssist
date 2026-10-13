import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPublic, publicLookup } from '../src/research/fetch';

// Offline DNS, scripted per test: each lookup takes the next answer.
const answers: string[][] = [];
const lookups: string[] = [];
vi.mock('node:dns/promises', () => ({
  lookup: async (host: string) => {
    lookups.push(host);
    return (answers.shift() ?? ['93.184.216.34']).map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    }));
  },
}));

let server: Server;
let port: number;
let hits = 0;

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++;
    res.end('internal');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  answers.length = 0;
  lookups.length = 0;
  hits = 0;
});

function lookupOnce(
  host: string,
  options: { all?: boolean; family?: number },
): Promise<{ error: Error | null; address: unknown; family?: number }> {
  return new Promise((resolve) => {
    (publicLookup as unknown as (...args: unknown[]) => void)(
      host,
      options,
      (error: Error | null, address: unknown, family?: number) =>
        resolve({ error, address, family }),
    );
  });
}

describe('DNS pinning', () => {
  it('hands the socket exactly the addresses it checked', async () => {
    answers.push(['93.184.216.34', '2606:2800:220:1::1']);
    expect(await lookupOnce('example.es', { all: true })).toMatchObject({
      error: null,
      address: [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1::1', family: 6 },
      ],
    });
    answers.push(['93.184.216.34']);
    expect(await lookupOnce('example.es', {})).toEqual({
      error: null,
      address: '93.184.216.34',
      family: 4,
    });
  });

  it('refuses a name with any private address', async () => {
    answers.push(['93.184.216.34', '10.0.0.1']);
    const { error } = await lookupOnce('mixed.example', { all: true });
    expect(error?.message).toBe('Blocked: mixed.example resolves to a private address');
  });

  it('refuses a rebinding name at connect time, without connecting', async () => {
    // The pre-check sees a public address; the connection's own lookup sees loopback.
    answers.push(['93.184.216.34'], ['127.0.0.1']);
    await expect(
      fetchPublic(new URL(`http://rebind.example:${port}/`), {
        signal: AbortSignal.timeout(5000),
        headers: {},
      }),
    ).rejects.toMatchObject({
      code: 'blocked',
      message: 'Blocked: rebind.example resolves to a private address',
    });
    expect(lookups).toEqual(['rebind.example', 'rebind.example']);
    expect(hits).toBe(0);
  });
});
