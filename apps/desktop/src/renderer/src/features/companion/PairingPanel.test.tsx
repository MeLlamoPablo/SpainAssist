import type { CompanionStatus } from '@sa/shared';
import { DEFAULT_SETTINGS } from '@sa/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PairingPanel } from './PairingPanel';

// Server rendering reads a zustand store's initial state: give components a plain one instead.
vi.mock('../../store/app', () => {
  const state = { settings: DEFAULT_SETTINGS };
  return {
    useAppStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state,
      setState: () => {},
    }),
  };
});

const render = (status: CompanionStatus) => renderToStaticMarkup(<PairingPanel status={status} />);

describe('PairingPanel', () => {
  it('says why the pairing ended on its own, and offers to pair again', () => {
    const html = render({ state: 'off', reason: 'expired' });
    expect(html).toContain('data-testid="companion-ended"');
    expect(html).toContain('data-reason="expired"');
    expect(html).toContain(
      'La vinculación ha caducado (dura 72 horas). Vuelve a escanear el código.',
    );
    expect(html).toContain('Volver a vincular');
    expect(html).not.toContain('companion-qr');
    expect(render({ state: 'off', reason: 'phone_unpaired' })).toContain(
      'Se ha desvinculado desde el móvil.',
    );
    expect(render({ state: 'off', reason: 'relay_refused' })).toContain(
      'El servidor de enlace ha rechazado la conexión. Inténtalo de nuevo más tarde.',
    );
  });

  it('shows the QR, not a reason, once a new pairing starts', () => {
    const html = render({ state: 'waiting', link: 'https://relay.example.invalid/p#demo' });
    expect(html).toContain('companion-qr');
    expect(html).not.toContain('companion-ended');
  });

  it('says which app to update, with the QR still there for a first pairing', () => {
    const phone = render({
      state: 'waiting',
      link: 'https://relay.example.invalid/p#demo',
      outdated: { phone: 5, desktop: 6 },
    });
    expect(phone).toContain('data-side="phone"');
    expect(phone).toContain(
      'La app del móvil está desactualizada. Actualízala desde Google Play y vuelve a abrirla.',
    );
    expect(phone).toContain('companion-qr');
    const desktop = render({
      state: 'away',
      device: 'Pixel 8',
      outdated: { phone: 7, desktop: 6 },
    });
    expect(desktop).toContain('data-side="desktop"');
    expect(desktop).toContain(
      'La app del móvil es más nueva que Spain Assist en el ordenador. Actualiza Spain Assist en el ordenador para firmar con el móvil.',
    );
  });

  it('spins while connecting, then says the server is out of reach and offers to retry', () => {
    const link = 'https://relay.example.invalid/p#demo';
    const connecting = render({ state: 'connecting', link });
    expect(connecting).toContain('Conectando…');
    expect(connecting).not.toContain('companion-stalled');
    const stalled = render({ state: 'connecting', link, stalled: true });
    expect(stalled).toContain('data-testid="companion-stalled"');
    expect(stalled).toContain(
      'No se puede conectar con el servidor. Comprueba tu conexión a internet.',
    );
    expect(stalled).toContain('Reintentar');
    expect(stalled).not.toContain('companion-qr');
    expect(stalled).not.toContain('Conectando…');
    // A paired phone: the same words, under its own state (it reconnects by itself).
    const paired = render({ state: 'connecting', device: 'Pixel 8', stalled: true });
    expect(paired).toContain('data-testid="companion-stalled"');
    expect(paired).not.toContain('Reintentar');
    expect(paired).toContain('Vincular otro móvil');
  });
});
