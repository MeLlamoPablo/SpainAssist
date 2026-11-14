import { describe, expect, it } from 'vitest';
import { silentLogger } from '../core/logger';
import { FakeBrowser } from '../testing/fakes';
import { REOPENED_HEADED_NOTE, RoutedBrowser } from './routed';

/** A fake whose storage state is a known string, and that records what it imports. */
class StatefulBrowser extends FakeBrowser {
  imported: string[] = [];
  override async exportState() {
    return '{"cookies":[{"name":"session"}],"origins":[]}';
  }
  override async importState(_procedureId: string, state: string) {
    this.imported.push(state);
  }
}

function setup() {
  const headless = new StatefulBrowser();
  const headed = new StatefulBrowser();
  let created = 0;
  const router = new RoutedBrowser(
    headless,
    () => {
      created++;
      return headed;
    },
    silentLogger,
  );
  return { headless, headed, router, created: () => created };
}

describe('RoutedBrowser', () => {
  it('runs every procedure headless until it is moved', async () => {
    const { headless, router, created } = setup();
    await router.open('p1', 'https://sede.example.gob.es/');
    await router.click('p1', 'e1');
    expect(headless.calls.map((c) => c.method)).toEqual(['open', 'click']);
    expect(router.isHeaded('p1')).toBe(false);
    expect(created()).toBe(0);
  });

  it('never opens the headed browser as a first attempt', async () => {
    const { router, created } = setup();
    await expect(router.reopenHeaded('p1')).rejects.toThrow(/normal browser first/);
    expect(created()).toBe(0);
  });

  it('moves a procedure with its cookies, certificate and page', async () => {
    const { headless, headed, router } = setup();
    await router.open('p1', 'https://sede.example.gob.es/cita');
    const certificate = { origins: ['https://sede.example.gob.es'], identity: {} } as never;
    await router.useClientCertificate('p1', certificate);

    const observation = await router.reopenHeaded('p1');

    expect(headless.isOpen('p1')).toBe(false);
    expect(headed.imported).toEqual(['{"cookies":[{"name":"session"}],"origins":[]}']);
    expect(headed.certificates).toEqual([{ origin: 'https://sede.example.gob.es' }]);
    expect(headed.calls.find((c) => c.method === 'open')?.args[0]).toBe(
      'https://sede.example.gob.es/cita',
    );
    expect(observation.notes).toContain(REOPENED_HEADED_NOTE);
    expect(router.isHeaded('p1')).toBe(true);

    // Later calls go to the headed browser; other procedures stay headless.
    await router.snapshot('p1');
    await router.open('p2', 'https://other.example.gob.es/');
    expect(headed.calls.at(-1)?.method).toBe('snapshot');
    expect(headless.calls.at(-1)).toMatchObject({ method: 'open', procedureId: 'p2' });
  });

  it('says so when the procedure is already headed', async () => {
    const { router } = setup();
    await router.open('p1', 'https://sede.example.gob.es/');
    await router.reopenHeaded('p1');
    const again = await router.reopenHeaded('p1');
    expect(again.notes).toContain('The browser of this procedure is already visible.');
  });

  it('keeps every procedure on a browser that is already headed', async () => {
    const headed = new FakeBrowser();
    const router = new RoutedBrowser(headed, undefined, silentLogger);
    await router.open('p1', 'https://sede.example.gob.es/');
    expect(router.isHeaded('p1')).toBe(true);
    const observation = await router.reopenHeaded('p1');
    expect(observation.notes).toContain('The browser of this procedure is already visible.');
  });

  it('closes both browsers and forgets the moves', async () => {
    const { headless, headed, router } = setup();
    await router.open('p1', 'https://sede.example.gob.es/');
    await router.reopenHeaded('p1');
    await router.closeAll();
    expect(headless.calls.at(-1)?.method).toBe('closeAll');
    expect(headed.calls.at(-1)?.method).toBe('closeAll');
    expect(router.isHeaded('p1')).toBe(false);
  });
});
