/**
 * DNS rebinding against the SSRF guard (`research/fetch.ts`): a name that resolves to a public
 * address when the guard asks and to a private one when the connection is opened. The default
 * fetch checks the addresses its socket really uses, so the request is refused at connect time.
 * Both resolvers are fakes: no real DNS, and the private address is never connected to.
 */
import { describe, expect, it, vi } from 'vitest';
import { type BlockedRequest, fetchPublic } from '../src/research/fetch';

const connectLookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:dns')>()),
  lookup: connectLookup,
}));

describe('a name that rebinds between the check and the connection', () => {
  it('is refused at connect time and reported as blocked', async () => {
    // The connection's lookup: the attacker's server now answers with the loopback.
    connectLookup.mockImplementation((_host, _options, callback) =>
      callback(null, [{ address: '127.0.0.1', family: 4 }]),
    );
    const blocked: BlockedRequest[] = [];
    const attempt = fetchPublic(new URL('http://rebind.example/admin'), {
      signal: AbortSignal.timeout(5_000),
      headers: {},
      // The guard's own lookup: a public address.
      resolveHost: async () => [{ address: '93.184.216.34' }],
      onBlocked: (request) => blocked.push(request),
    });
    await expect(attempt).rejects.toMatchObject({
      code: 'blocked',
      message: 'Blocked: rebind.example resolves to a private address',
    });
    expect(connectLookup).toHaveBeenCalled();
    expect(blocked).toEqual([
      expect.objectContaining({
        method: 'GET',
        message: expect.stringContaining('rebind.example'),
      }),
    ]);
  });

  it('refuses an empty answer at connect time too', async () => {
    connectLookup.mockImplementation((_host, _options, callback) => callback(null, []));
    await expect(
      fetchPublic(new URL('http://empty.example/'), {
        signal: AbortSignal.timeout(5_000),
        headers: {},
        resolveHost: async () => [{ address: '93.184.216.34' }],
      }),
    ).rejects.toMatchObject({ code: 'blocked' });
  });
});
