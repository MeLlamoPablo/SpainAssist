import {
  type AppInfo,
  type CredentialSummary,
  DEFAULT_SETTINGS,
  FEATURES_OFF,
  type VaultOverview,
} from '@sa/shared';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../components/ui/tooltip';
import {
  CertificateExportDialog,
  exportPasswordIssue,
  submitCertificateExport,
} from './CertificateExport';
import { CredentialsSection } from './CredentialsSection';

// Server rendering reads a zustand store's initial state: give components a plain one instead.
const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('../../store/app', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(store.state),
    { getState: () => store.state, setState: (patch: object) => Object.assign(store.state, patch) },
  ),
}));

const invoke = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()),
  api: { invoke, on: () => () => {} },
}));

// Radix portals render nothing on the server: an open dialog shows its parts inline.
vi.mock('../../components/ui/dialog', async (original) => ({
  ...(await original<typeof import('../../components/ui/dialog')>()),
  Dialog: (props: {
    open: boolean;
    title: ReactNode;
    description?: ReactNode;
    children: ReactNode;
    footer?: ReactNode;
  }) =>
    props.open ? (
      <div data-testid="dialog">
        <h2>{props.title}</h2>
        <p>{props.description}</p>
        {props.children}
        <footer>{props.footer}</footer>
      </div>
    ) : null,
}));

const info: AppInfo = {
  name: 'Spain Assist',
  version: '0.0.0-test',
  platform: 'darwin',
  installChannel: 'dev',
  isDev: true,
  isE2E: false,
  features: { ...FEATURES_OFF, dniePhone: 'release' },
  errorReports: false,
};

const CERTIFICATE: CredentialSummary = {
  id: 'cred-cert',
  kind: 'certificate',
  label: 'Certificado de CARMEN ESPAÑOLA ESPAÑOLA',
  policy: 'ask',
  createdAt: '2026-10-11T10:00:00.000Z',
  certificate: {
    subject: 'CN=ESPAÑOLA ESPAÑOLA CARMEN - 99999999R',
    issuer: 'AC FNMT Usuarios',
    serialNumber: '01',
    validFrom: '2026-10-01T00:00:00.000Z',
    validTo: '2030-10-01T00:00:00.000Z',
    holderName: 'CARMEN ESPAÑOLA ESPAÑOLA',
    fingerprint: 'ab',
  },
};

const DNIE: CredentialSummary = {
  id: 'cred-dnie',
  kind: 'dnie',
  label: 'DNI con el móvil',
  policy: 'ask',
  createdAt: '2026-10-11T10:00:00.000Z',
  certificate: CERTIFICATE.certificate!,
};

beforeEach(() => {
  store.state = { info, settings: DEFAULT_SETTINGS, companion: { state: 'off' } };
  invoke.mockReset();
});

function section(credentials: CredentialSummary[]): string {
  const overview: VaultOverview = {
    personal: [],
    documents: [],
    credentials,
    certificateRequests: [],
    storage: { backend: 'test', secure: true, biometricAvailable: false },
  };
  return renderToStaticMarkup(
    <TooltipProvider>
      <CredentialsSection overview={overview} />
    </TooltipProvider>,
  );
}

function dialog(biometric: boolean): string {
  return renderToStaticMarkup(
    <CertificateExportDialog
      credentialId={CERTIFICATE.id}
      biometric={biometric}
      open
      onOpenChange={() => {}}
    />,
  );
}

describe('Mis datos: exporting a certificate', () => {
  it('offers a download button on each certificate, never on the DNI', () => {
    const html = section([CERTIFICATE, { ...CERTIFICATE, id: 'cred-cert-2' }, DNIE]);
    expect(html.match(/data-testid="certificate-export"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Descargar copia (.p12)"');
    expect(section([DNIE])).not.toContain('Descargar copia (.p12)');
  });

  it('asks for the password twice and says it can’t be recovered', () => {
    const html = dialog(false);
    expect(html).toContain('Exportar certificado');
    expect(html).toContain('Contraseña del archivo');
    expect(html).toContain('Al menos 8 caracteres.');
    expect(html).toContain('Repite la contraseña');
    expect(html.match(/type="password"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Mostrar"/g)).toHaveLength(2);
    expect(html).toContain(
      'La necesitarás para instalar el certificado en otro sitio. No la guardo, así que no podré recuperarla.',
    );
    expect(html).toContain('cualquiera puede identificarse y firmar como tú');
    expect(html).toContain('Exportar…');
    expect(html).not.toContain('Touch ID');
    expect(dialog(true)).toContain('Te pediré Touch ID para confirmar');
  });

  it('wants at least 8 characters, typed the same twice', () => {
    expect(exportPasswordIssue('', '')).toBe('short');
    expect(exportPasswordIssue('1234567', '1234567')).toBe('short');
    expect(exportPasswordIssue('12345678', '12345679')).toBe('mismatch');
    expect(exportPasswordIssue('12345678', '12345678')).toBeNull();
    expect(exportPasswordIssue('contraseña', 'contraseña')).toBeNull();
  });

  it('only asks main once the passwords are fine, and passes on a cancel', async () => {
    expect(await submitCertificateExport(CERTIFICATE.id, 'corta', 'corta')).toEqual({
      issue: 'short',
    });
    expect(await submitCertificateExport(CERTIFICATE.id, 'contraseña1', 'contraseña2')).toEqual({
      issue: 'mismatch',
    });
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockResolvedValueOnce('Certificado CARMEN ESPAÑOLA ESPAÑOLA.p12');
    expect(await submitCertificateExport(CERTIFICATE.id, 'contraseña1', 'contraseña1')).toEqual({
      name: 'Certificado CARMEN ESPAÑOLA ESPAÑOLA.p12',
    });
    expect(invoke).toHaveBeenCalledWith('vault.exportCertificate', CERTIFICATE.id, 'contraseña1');

    invoke.mockResolvedValueOnce(null);
    expect(await submitCertificateExport(CERTIFICATE.id, 'contraseña1', 'contraseña1')).toEqual({
      name: null,
    });
  });
});
