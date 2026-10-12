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
      'browser.fillFromVault': () => {
        throw new FakeBridgeError('policy_denied', 'Not an allowed domain for Cl@ve', 403);
      },
    });
    const client = new BridgeClient({ url: bridge.url, token: bridge.token });
    const error = await client
      .call('browser.fillFromVault', {
        ref: 'e1',
        value: { source: 'credential', credentialId: 'c1', field: 'password' },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeError);
    expect((error as BridgeError).code).toBe('policy_denied');
    expect((error as BridgeError).status).toBe(403);
    expect((error as BridgeError).message).toContain('allowed domain');
  });

  it('reports unauthorized when the token is wrong', async () => {
    bridge = await createFakeBridge({ 'procedure.get': () => ({}) });
    const client = new BridgeClient({ url: bridge.url, token: 'wrong' });
    await expect(client.call('procedure.get', {})).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('propagates aborts: the request is cancelled and the app sees the connection close', async () => {
    bridge = await createFakeBridge({ 'prompt.form': hang });
    const client = new BridgeClient({ url: bridge.url, token: bridge.token });
    const controller = new AbortController();
    const pending = client.call(
      'prompt.form',
      { title: 'Datos', fields: [{ key: 'a', label: 'A', type: 'text' }] },
      { signal: controller.signal },
    );
    const call = await bridge.waitForCall('prompt.form');
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    await bridge.waitForAbort(call);
    expect(call.aborted).toBe(true);
  });

  it('applies timeouts except to methods that wait for the user', async () => {
    expect(defaultBridgeTimeoutMs('prompt.form')).toBe(0);
    expect(defaultBridgeTimeoutMs('browser.fillFromUser')).toBe(0);
    expect(defaultBridgeTimeoutMs('procedure.update')).toBeGreaterThan(0);
    bridge = await createFakeBridge({ 'procedure.get': hang });
    const client = new BridgeClient({ url: bridge.url, token: bridge.token });
    await expect(client.call('procedure.get', {}, { timeoutMs: 100 })).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('reports network errors when the app is unreachable', async () => {
    const client = new BridgeClient({ url: 'http://127.0.0.1:9', token: 't' });
    await expect(client.call('procedure.get', {})).rejects.toMatchObject({ code: 'network' });
  });
});
