/**
 * Optional OpenSSL CLI used as an independent verifier. macOS ships LibreSSL as `openssl`, which
 * lacks parts of `cms` and `pkcs12 -legacy`; we only use a real OpenSSL 3.x and skip otherwise.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function findOpenssl(): string | null {
  const candidates = [
    process.env.OPENSSL_BIN,
    '/opt/homebrew/bin/openssl',
    '/usr/local/opt/openssl@3/bin/openssl',
    '/opt/homebrew/opt/openssl@3/bin/openssl',
    'openssl',
  ].filter((c): c is string => !!c);
  for (const bin of candidates) {
    const r = spawnSync(bin, ['version'], { encoding: 'utf8' });
    if (r.status === 0 && /^OpenSSL 3\./.test(r.stdout)) return bin;
  }
  return null;
}

export const OPENSSL = findOpenssl();

export function hasLegacyProvider(): boolean {
  if (!OPENSSL) return false;
  const r = spawnSync(OPENSSL, ['list', '-providers', '-provider', 'legacy'], { encoding: 'utf8' });
  return r.status === 0 && /legacy/i.test(r.stdout);
}

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-signer-'));
}

export function openssl(args: string[], input?: Buffer): Buffer {
  if (!OPENSSL) throw new Error('OpenSSL 3 not available');
  return execFileSync(OPENSSL, args, { input, stdio: ['pipe', 'pipe', 'pipe'] });
}

export function toPem(der: Buffer, label = 'CERTIFICATE'): string {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN ${label}-----\n${b64}${b64.endsWith('\n') ? '' : '\n'}-----END ${label}-----\n`;
}
