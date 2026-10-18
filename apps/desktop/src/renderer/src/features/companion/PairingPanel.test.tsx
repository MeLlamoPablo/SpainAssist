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
});
