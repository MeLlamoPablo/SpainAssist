import dns from 'node:dns';
import { createServer } from 'node:http';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { isLoopbackHost, NetworkGuardError } from './helpers/no-network';

describe('offline test network guard', () => {
  it('refuses a real host before any packet is sent, for fetch, TCP and DNS', async () => {
    await expect(fetch('https://sede.seg-social.gob.es/')).rejects.toBeInstanceOf(
      NetworkGuardError,
    );
    // Documentation addresses (TEST-NET): nothing could answer even if the guard failed.
    expect(() => net.connect({ host: '203.0.113.9', port: 80 })).toThrow(NetworkGuardError);
    expect(() => net.connect(80, '203.0.113.9')).toThrow(NetworkGuardError);
    expect(() => net.connect(443, 'llm.spainassist.es')).toThrow(NetworkGuardError);
    expect(() => dns.lookup('example.com', () => {})).toThrow(NetworkGuardError);
  });

  it('refuses https and http clients too (they go through net)', async () => {
    const http = await import('node:http');
    expect(() => http.request({ hostname: '203.0.113.7', port: 80 }).end()).toThrow(
      NetworkGuardError,
    );
  });

  it('allows the loopback interface', async () => {
    const server = createServer((_req, res) => res.end('hi'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('hi');
    expect(await (await fetch(`http://localhost:${port}/`)).text()).toBe('hi');
    server.closeAllConnections();
    server.close();
  });

  it('knows what loopback is', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('127.0.0.1.evil.example')).toBe(false);
    expect(isLoopbackHost('10.0.0.1')).toBe(false);
  });
});
