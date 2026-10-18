import {
  type AppInfo,
  type CompanionStatus,
  DEFAULT_SETTINGS,
  FEATURES_OFF,
  type VaultOverview,
} from '@sa/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../components/ui/tooltip';
import { CredentialsSection } from './CredentialsSection';

// Server rendering reads a zustand store's initial state: give components a plain one instead.
const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('../../store/app', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(store.state),
    { getState: () => store.state, setState: (patch: object) => Object.assign(store.state, patch) },
  ),
}));

const info = (dniePhone: boolean): AppInfo => ({
  name: 'Spain Assist',
  version: '0.0.0-test',
  platform: 'darwin',
  installChannel: 'dev',
  isDev: true,
  isE2E: false,
  features: { ...FEATURES_OFF, dniePhone },
  errorReports: false,
});

const DNIE = {
  id: 'cred-dnie',
  kind: 'dnie',
  label: 'DNIe con el móvil',
  policy: 'ask',
  createdAt: '2026-10-11T10:00:00.000Z',
} as const;

function render(
  dniePhone: boolean,
  credentials: VaultOverview['credentials'] = [],
  companion: CompanionStatus = { state: 'off' },
): string {
  store.state = {
    info: info(dniePhone),
    settings: DEFAULT_SETTINGS,
    companion,
  };
  const overview: VaultOverview = {
    personal: [],
    documents: [],
    credentials,
    storage: { backend: 'test', secure: true, biometricAvailable: false },
  };
  return renderToStaticMarkup(
    <TooltipProvider>
      <CredentialsSection overview={overview} />
    </TooltipProvider>,
  );
}

describe('Mis datos: DNIe with the phone', () => {
  it('has no DNIe card without the feature flag, even with a saved DNIe', () => {
    for (const html of [render(false), render(false, [DNIE])]) {
      expect(html).not.toContain('DNIe con el móvil');
      expect(html).not.toContain('Vincular el móvil');
      expect(html).toContain('Cl@ve Móvil');
      expect(html).toContain('Certificado digital');
    }
  });

  it('offers to add the DNIe, or shows the saved one with its pairing, with the flag on', () => {
    const add = render(true);
    expect(add).toContain('DNIe con el móvil');
    expect(add).toContain('Lo tengo');
    const saved = render(true, [DNIE]);
    expect(saved).toContain('data-testid="credential-dnie"');
    expect(saved).toContain('Vincular el móvil');
  });

  it('offers to save the DNIe PIN, and to change or delete a saved one (never shown)', () => {
    const none = render(true, [{ ...DNIE, hasPin: false }]);
    expect(none).toContain('dnie-pin-row');
    expect(none).toContain('Sin guardar');
    expect(none).toContain('Guardar PIN');
    const saved = render(true, [{ ...DNIE, hasPin: true }]);
    expect(saved).toContain('Guardado. El asistente nunca lo ve.');
    expect(saved).toContain('Cambiar');
    expect(saved).toContain('Borrar');
    expect(saved).not.toContain('Guardar PIN');
  });

  it('says why the last pairing ended, unless the user unpaired here', () => {
    const ended = {
      phone_unpaired: 'Se ha desvinculado desde el móvil.',
      expired: 'La vinculación ha caducado (dura 72 horas). Vuelve a escanear el código.',
      relay_refused:
        'El servidor de enlace ha rechazado la conexión. Inténtalo de nuevo más tarde.',
    } as const;
    for (const [reason, text] of Object.entries(ended)) {
      const html = render(true, [DNIE], { state: 'off', reason } as CompanionStatus);
      expect(html).toContain('Ningún móvil vinculado');
      expect(html).toContain(text);
      expect(html).toContain('Vincular el móvil');
    }
    expect(render(true, [DNIE])).not.toContain('companion-ended');
  });
});
