import { type AppInfo, DEFAULT_SETTINGS, FEATURES_OFF, type VaultOverview } from '@sa/shared';
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
  isDev: true,
  isE2E: false,
  features: { ...FEATURES_OFF, dniePhone },
});

const DNIE = {
  id: 'cred-dnie',
  kind: 'dnie',
  label: 'DNIe con el móvil',
  policy: 'ask',
  createdAt: '2026-10-11T10:00:00.000Z',
} as const;

function render(dniePhone: boolean, credentials: VaultOverview['credentials'] = []): string {
  store.state = {
    info: info(dniePhone),
    settings: DEFAULT_SETTINGS,
    companion: { state: 'off' },
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

  it('shows whether the DNIe PIN is saved, refused by the card, or missing', () => {
    const none = render(true, [DNIE]);
    expect(none).toContain('data-testid="dnie-pin"');
    expect(none).toContain('Guarda el PIN del DNIe y el móvil no te lo pedirá.');
    expect(none).toContain('Guardar PIN');
    expect(none).not.toContain('Quitar');

    const saved = render(true, [{ ...DNIE, pin: 'saved' }]);
    expect(saved).toContain('PIN del DNIe guardado.');
    expect(saved).toContain('Cambiar');
    expect(saved).toContain('Quitar');
    expect(saved).not.toContain('Guardar PIN');

    const wrong = render(true, [{ ...DNIE, pin: 'wrong' }]);
    expect(wrong).toContain('Tu DNIe no aceptó el PIN guardado.');
    expect(wrong).toContain('Corregir PIN');
    expect(wrong).toContain('Quitar');
    expect(wrong).toContain('bg-st-attention-bg');

    // Without the feature flag there is no card, so no PIN either.
    expect(render(false, [{ ...DNIE, pin: 'saved' }])).not.toContain('dnie-pin');
  });
});
