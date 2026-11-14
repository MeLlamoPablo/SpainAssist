import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BridgeClient, BridgeError, defaultBridgeTimeoutMs } from '../src/bridge/client';
import { createFakeBridge, type FakeBridge, FakeBridgeError, hang } from './helpers/fake-bridge';

describe('BridgeClient', () => {
  let bridge: FakeBridge | undefined;
  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  it('posts JSON with the bearer token and returns the result', async () => {
    bridge = await createFakeBridge({
      'vault.save': (params) => ({ saved: (params.items as { key: string }[]).map((i) => i.key) }),
    });
    const client = new BridgeClient({ url: bridge.url, token: bridge.token });
    const result = await client.call('vault.save', { items: [{ key: 'email', value: 'a@b.es' }] });
    expect(result).toEqual({ saved: ['email'] });
    expect(bridge.calls[0]?.authorization).toBe(`Bearer ${bridge.token}`);
    expect(bridge.calls[0]?.params).toEqual({ items: [{ key: 'email', value: 'a@b.es' }] });
    client.close();
  });

  it('maps error envelopes to BridgeError codes', async () => {
    bridge = await createFakeBridge({
      'browser.loginClave': () => {
        throw new FakeBridgeError('policy_denied', 'Not an allowed domain for Cl@ve', 403);
      },
    });
    const client = new BridgeClient({ url: bridge.url, token: bridge.token });
    const error = await client
      .call('browser.loginClave', { usernameRef: 'e1', passwordRef: 'e2' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeError);
    expect((error as BridgeError).code).toBe('policy_denied');
    expect((error as BridgeError).status).toBe(403);
    expect((error as BridgeError).message).toContain('allowed domain');
  });

  it('reports unauthorized when the token is wrong', async () => {
    bridge = await createFakeBridge({ 'workflows.list': () => ({}) });
    const client = new BridgeClient({ url: bridge.url, token: 'wrong' });
    await expect(client.call('workflows.list', {})).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('propagates aborts: the request is cancelled and the app sees the connection close', async () => {
    bridge = await createFakeBridge({ 'prompt.confirm': hang });
    const client = new BridgeClient({ url: bridge.url, token: bridge.token });
    const controller = new AbortController();
    const pending = client.call(
      'prompt.confirm',
      { confirmKind: 'action', title: 'Enviar', message: '¿Envío la solicitud?' },
      { signal: controller.signal },
    );
    const call = await bridge.waitForCall('prompt.confirm');
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    await bridge.waitForAbort(call);
    expect(call.aborted).toBe(true);
  });

  it('applies timeouts except to methods that wait for the user', async () => {
    expect(defaultBridgeTimeoutMs('prompt.confirm')).toBe(0);
    expect(defaultBridgeTimeoutMs('browser.fillFromUser')).toBe(0);
    expect(defaultBridgeTimeoutMs('procs.update')).toBeGreaterThan(0);
    bridge = await createFakeBridge({ 'workflows.list': hang });
    const client = new BridgeClient({ url: bridge.url, token: bridge.token });
    await expect(client.call('workflows.list', {}, { timeoutMs: 100 })).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('sends a call again when the app reset the idle connection it reused', async () => {
    // The app answers once per connection, then resets it when the next request arrives on it,
    // as when its keep-alive timeout closes an idle socket just as the client reuses it.
    const served = new WeakSet<Socket>();
    let answered = 0;
    let resets = 0;
    const server = createServer((req, res) => {
      if (served.has(req.socket)) {
        resets++;
        req.socket.resetAndDestroy();
        return;
      }
      served.add(req.socket);
      answered++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: { n: answered } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const client = new BridgeClient({ url, token: 't' });
      expect(await client.call('workflows.list', {})).toEqual({ n: 1 });
      expect(await client.call('workflows.list', {})).toEqual({ n: 2 });
      expect(resets).toBe(1);
      client.close();
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('reports network errors when the app is unreachable', async () => {
    const client = new BridgeClient({ url: 'http://127.0.0.1:9', token: 't' });
    await expect(client.call('workflows.list', {})).rejects.toMatchObject({ code: 'network' });
  });
});
