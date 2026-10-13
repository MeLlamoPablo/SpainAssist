import { describe, expect, it, vi } from 'vitest';
import type { BridgeTransport } from '../src/bridge/client';
import { createHostPolicy } from '../src/tools/hosts';

function bridgeAnswering(approved: boolean | (() => Promise<boolean>)) {
  const call = vi.fn(async () => ({
    kind: 'confirm' as const,
    approved: typeof approved === 'boolean' ? approved : await approved(),
  }));
  return { bridge: { call } as unknown as BridgeTransport, call };
}

describe('host policy', () => {
  it('lets official hosts through without asking', async () => {
    const { bridge, call } = bridgeAnswering(false);
    const hosts = createHostPolicy({ bridge });
    for (const url of [
      'https://sede.agenciatributaria.gob.es/x',
      'https://datos.gob.es/apidata',
      'https://www.boe.es/datosabiertos/api',
      'https://ec.europa.eu/eurostat',
      'https://www.ine.es/jaxiT3/',
    ]) {
      expect(await hosts.approve(new URL(url))).toBe(true);
    }
    expect(call).not.toHaveBeenCalled();
  });

  it('asks once per other host, showing the host and the address', async () => {
    const { bridge, call } = bridgeAnswering(true);
    const hosts = createHostPolicy({ bridge, language: 'en' });
    expect(await hosts.approve(new URL('https://api.example.com/a?q=1'))).toBe(true);
    expect(await hosts.approve(new URL('https://API.example.com./b'))).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      'prompt.confirm',
      expect.objectContaining({
        confirmKind: 'action',
        title: 'Let the assistant read api.example.com?',
        details: [
          { label: 'Website', value: 'api.example.com' },
          { label: 'Address', value: 'https://api.example.com/a?q=1' },
        ],
      }),
      expect.anything(),
    );
    // Look-alikes are other hosts.
    await hosts.approve(new URL('https://evilgob.es/'));
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('asks separately to read a site and to browse it', async () => {
    const { bridge, call } = bridgeAnswering(true);
    const hosts = createHostPolicy({ bridge, language: 'en' });
    await hosts.approve(new URL('https://example.com/'));
    await hosts.approve(new URL('https://example.com/form'), undefined, 'browse');
    await hosts.approve(new URL('https://example.com/other'), undefined, 'browse');
    expect(call).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenLastCalledWith(
      'prompt.confirm',
      expect.objectContaining({ title: 'Let the assistant use example.com?' }),
      expect.anything(),
    );
  });

  it('remembers a refusal and shares one prompt between waiting requests', async () => {
    let answer: (value: boolean) => void = () => {};
    const { bridge, call } = bridgeAnswering(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const hosts = createHostPolicy({ bridge });
    const waiting = [1, 2, 3].map((i) => hosts.approve(new URL(`https://evil.example/${i}`)));
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    answer(false);
    expect(await Promise.all(waiting)).toEqual([false, false, false]);
    expect(await hosts.approve(new URL('https://evil.example/again'))).toBe(false);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('asks again after a failed prompt', async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(new Error('bridge down'))
      .mockResolvedValueOnce({ kind: 'confirm', approved: true });
    const hosts = createHostPolicy({ bridge: { call } as unknown as BridgeTransport });
    await expect(hosts.approve(new URL('https://x.example/'))).rejects.toThrow('bridge down');
    expect(await hosts.approve(new URL('https://x.example/'))).toBe(true);
    expect(call).toHaveBeenCalledTimes(2);
  });
});
