import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureLoopbackNoProxy } from '../../src/net/proxy-env';

describe('ensureLoopbackNoProxy', () => {
  const names = ['127.0.0.1', 'localhost', '::1', '[::1]'];

  it('puts the loopback names in NO_PROXY and no_proxy', () => {
    const env: NodeJS.ProcessEnv = {};
    ensureLoopbackNoProxy(env);
    expect(env.NO_PROXY?.split(',')).toEqual(names);
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });

  it('keeps what is there, and does not repeat what is', () => {
    const env: NodeJS.ProcessEnv = {
      NO_PROXY: 'corp.example, localhost ,.intranet',
      no_proxy: '10.0.0.0/8',
    };
    ensureLoopbackNoProxy(env);
    expect(env.NO_PROXY?.split(',')).toEqual([
      'corp.example',
      'localhost',
      '.intranet',
      '127.0.0.1',
      '::1',
      '[::1]',
    ]);
    expect(env.no_proxy?.split(',')).toEqual(['10.0.0.0/8', ...names]);
    const once = { ...env };
    ensureLoopbackNoProxy(env);
    expect(env).toEqual(once);
  });

  it('leaves `*` alone: nothing goes through a proxy already', () => {
    const env: NodeJS.ProcessEnv = { NO_PROXY: '*' };
    ensureLoopbackNoProxy(env);
    expect(env.NO_PROXY).toBe('*');
  });
});

describe('a process with an environment proxy', () => {
  let proxy: http.Server;
  let proxied: string[];
  let proxyPort: number;
  beforeAll(async () => {
    proxied = [];
    proxy = http.createServer((req, res) => {
      proxied.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
      res.writeHead(502).end();
    });
    proxy.on('connect', (req, socket) => {
      proxied.push(`CONNECT ${req.url}`);
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    proxyPort = (proxy.address() as AddressInfo).port;
  });
  afterAll(async () => {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  });

  const run = (mode: string): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        ['--import', 'tsx', join(import.meta.dirname, 'helpers', 'loopback-fetch-child.mts'), mode],
        {
          cwd: join(import.meta.dirname, '..', '..'),
          env: {
            PATH: process.env.PATH,
            NODE_USE_ENV_PROXY: '1',
            HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
            http_proxy: `http://127.0.0.1:${proxyPort}`,
          },
          timeout: 25_000,
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
      );
    });

  it('sends a request to loopback through the proxy, key and all (the control)', async () => {
    expect(await run('unguarded')).toMatch(/^failed:/);
    expect(proxied.length).toBeGreaterThan(0);
  }, 30_000);

  it('sends it straight to the loopback server once the harness has done its part', async () => {
    proxied.length = 0;
    expect(await run('guarded')).toBe('status 200: target Bearer voucher-key');
    expect(proxied).toEqual([]);
  }, 30_000);
});
