import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blockKeysInNodeTls, spkiHash } from './tls';

/** A local server with a test certificate the client trusts (fixtures/localhost.*). */
const key = readFileSync(join(import.meta.dirname, 'fixtures', 'localhost.key'));
const cert = readFileSync(join(import.meta.dirname, 'fixtures', 'localhost.pem'));
const ownKey = spkiHash(new X509Certificate(cert));

let server: https.Server;
let port: number;
let blocked: ReadonlySet<string> = new Set();
const original = tls.checkServerIdentity;

beforeAll(async () => {
  server = https.createServer({ key, cert }, (_req, res) => res.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  blockKeysInNodeTls(() => blocked);
});

afterAll(async () => {
  tls.checkServerIdentity = original;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

/** One request on a new connection, trusting the test certificate. */
function get(): Promise<string> {
  return new Promise((resolve) => {
    https
      .get(
        {
          host: 'localhost',
          port,
          ca: cert,
          agent: false,
          lookup: (_h, _o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(`HTTP ${res.statusCode}`));
        },
      )
      .on('error', (err) => resolve(err.message));
  });
}

describe('blockKeysInNodeTls', () => {
  it('lets connections through while their keys are not blocked', async () => {
    blocked = new Set(['AAAA']);
    expect(await get()).toBe('HTTP 200');
  });

  it('refuses a chain with a blocked key, from the next connection on', async () => {
    blocked = new Set([ownKey]);
    expect(await get()).toMatch(/Blocked certificate authority in the chain: .*CN=localhost/);
  });

  it("still runs Node's own checks", async () => {
    blocked = new Set();
    const wrongHost = await new Promise<string>((resolve) => {
      https
        .get({ host: '127.0.0.1', port, ca: cert, agent: false }, () => resolve('connected'))
        .on('error', (err) => resolve(err.message));
    });
    expect(wrongHost).toMatch(/IP: 127.0.0.1 is not in the cert's list/);
  });
});
