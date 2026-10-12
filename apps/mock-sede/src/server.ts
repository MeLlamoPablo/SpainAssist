/**
 * startMockSede(): two HTTPS servers on 127.0.0.1.
 *  - main port: the sede, the Cl@ve-like gateway and the /__test API;
 *  - cert port: the "DNIe / Certificado electrónico" identity provider, which asks for a TLS
 *    client certificate and checks it against the mock "FNMT-like" client CA.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { createMainApp } from './app';
import { loadAssets } from './assets';
import type { AppContext, MockSedeConfig } from './context';
import { DEMO_IDENTITY_PASSPHRASE, FIXTURE_PATHS, loadClientCa } from './identities';
import {
  type CertAndKey,
  createServerCa,
  issueServerCert,
  loadCertAndKey,
  type ServerPki,
  spkiSha256Base64,
  stillValid,
} from './pki';
import { createCertIdpApp } from './routes/cert-idp';
import { type ClaveUser, DEMO_USER, MockSedeState } from './state';
import { MockSedeTestApi } from './test-api';

export interface MockSedeOptions {
  /** Main HTTPS port. Default 0 (random). The CLI uses 8790. */
  port?: number;
  /** Client-certificate HTTPS port. Default 0 (random). The CLI uses 8791. */
  certPort?: number;
  /** Bind address. Default 127.0.0.1. */
  host?: string;
  /** Host name used in URLs (must be covered by the TLS certificate). Default "localhost". */
  publicHost?: string;
  /**
   * Directory where the TLS CA and server certificate are cached (e.g. ".data/mock-sede").
   * Without it a fresh CA is generated in memory on every start (hermetic tests).
   */
  dataDir?: string;
  /** Enable /__test/*. Default: true unless MOCK_SEDE_TEST_API=0. */
  testApi?: boolean;
  /** Cl@ve Permanente users. Default: the demo user 99999999R / clave-demo-1234. */
  users?: ClaveUser[];
  sessionTimeoutSeconds?: number;
  sessionWarningSeconds?: number;
  smsTtlSeconds?: number;
  movilTtlSeconds?: number;
  /** "No soy un robot" step in the cita previa flow. Default true. */
  captchaInCita?: boolean;
  /** How long the page's autoscript.js keeps trying to reach AutoFirma (default ~32 s). */
  autofirma?: Partial<MockSedeConfig['autofirma']>;
  /** Receives human-readable events (simulated SMS codes, Cl@ve Móvil requests...). */
  log?: (message: string) => void;
}

export interface MockSede {
  /** e.g. https://localhost:8790 (no trailing slash) */
  url: string;
  /** Exact origin for sidecar certificate configuration, e.g. https://localhost:8791 */
  certUrl: string;
  port: number;
  certPort: number;
  /** CA of the TLS server certificate (trust it, or use ignoreHTTPSErrors). */
  caCertPem: string;
  /** File with caCertPem, when `dataDir` is set (e.g. for NODE_EXTRA_CA_CERTS). */
  caCertPath?: string;
  /** Base64 SHA-256 of the server key, for Chromium's --ignore-certificate-errors-spki-list. */
  serverCertSpkiSha256: string;
  /** Client CA chain (intermediate + root) that personal certificates must chain to. */
  clientCaCertPem: string;
  demo: {
    dni: string;
    clavePassword: string;
    certificateP12Path: string;
    certificatePassphrase: string;
  };
  config: MockSedeConfig;
  test: MockSedeTestApi;
  close(): Promise<void>;
}

function resolveConfig(options: MockSedeOptions): MockSedeConfig {
  return {
    sessionTimeoutSeconds: options.sessionTimeoutSeconds ?? 15 * 60,
    sessionWarningSeconds: options.sessionWarningSeconds ?? 2 * 60,
    smsTtlSeconds: options.smsTtlSeconds ?? 5 * 60,
    movilTtlSeconds: options.movilTtlSeconds ?? 5 * 60,
    gatewayRequestTtlSeconds: 30 * 60,
    captchaInCita: options.captchaInCita ?? true,
    testApi: options.testApi ?? process.env.MOCK_SEDE_TEST_API !== '0',
    autofirma: {
      launchingTimeMs: options.autofirma?.launchingTimeMs ?? 2000,
      retries: options.autofirma?.retries ?? 15,
      retryIntervalMs: options.autofirma?.retryIntervalMs ?? 2000,
    },
    maxUploadBytes: 5 * 1024 * 1024,
  };
}

/** Loads the TLS CA + server certificate from `dataDir`, (re)creating them when needed. */
function loadServerPki(dataDir: string | undefined): ServerPki & { caPath?: string } {
  if (!dataDir) {
    const ca = createServerCa();
    return { ca, server: issueServerCert(ca) };
  }
  mkdirSync(dataDir, { recursive: true });
  const files = {
    caCert: join(dataDir, 'server-ca.crt.pem'),
    caKey: join(dataDir, 'server-ca.key.pem'),
    cert: join(dataDir, 'server.crt.pem'),
    key: join(dataDir, 'server.key.pem'),
  };
  const read = (cert: string, key: string): CertAndKey | undefined => {
    if (!existsSync(cert) || !existsSync(key)) return undefined;
    try {
      return loadCertAndKey(readFileSync(cert, 'utf8'), readFileSync(key, 'utf8'));
    } catch {
      return undefined;
    }
  };
  let ca = read(files.caCert, files.caKey);
  if (!ca || !stillValid(ca.cert)) {
    ca = createServerCa();
    writeFileSync(files.caCert, ca.certPem);
    writeFileSync(files.caKey, ca.keyPem, { mode: 0o600 });
  }
  let server = read(files.cert, files.key);
  let issuedByCa = false;
  try {
    issuedByCa = Boolean(server && ca.cert.verify(server.cert));
  } catch {
    issuedByCa = false;
  }
  if (!server || !issuedByCa || !stillValid(server.cert)) {
    server = issueServerCert(ca);
    writeFileSync(files.cert, server.certPem);
    writeFileSync(files.key, server.keyPem, { mode: 0o600 });
  }
  return { ca, server, caPath: files.caCert };
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export async function startMockSede(options: MockSedeOptions = {}): Promise<MockSede> {
  const config = resolveConfig(options);
  const state = new MockSedeState(options.users ?? [DEMO_USER]);
  const ctx: AppContext = {
    state,
    config,
    urls: { main: '', cert: '' },
    log: options.log ?? (() => {}),
  };
  const testApi = new MockSedeTestApi(ctx);
  const assets = loadAssets(config);
  const tls = loadServerPki(options.dataDir);
  const clientCa = loadClientCa();

  const listenerOptions = {
    overrideGlobalObjects: false,
    errorHandler: (err: unknown) => {
      ctx.log(`[Error] ${(err as Error)?.stack ?? String(err)}`);
    },
  };
  const mainServer = createServer(
    { key: tls.server.keyPem, cert: tls.server.certPem },
    getRequestListener(createMainApp(ctx, assets, testApi).fetch, listenerOptions),
  );
  const certServer = createServer(
    {
      key: tls.server.keyPem,
      cert: tls.server.certPem,
      // Like the real certificate IdP: ask for a client certificate during the handshake, but let
      // the application show its own error page when none (or an untrusted one) is presented.
      requestCert: true,
      rejectUnauthorized: false,
      ca: clientCa.trustedPems,
      maxVersion: 'TLSv1.2',
    },
    getRequestListener(createCertIdpApp(ctx, assets).fetch, listenerOptions),
  );

  const host = options.host ?? '127.0.0.1';
  const publicHost = options.publicHost ?? 'localhost';
  let port: number;
  let certPort: number;
  try {
    port = await listen(mainServer, options.port ?? 0, host);
    certPort = await listen(certServer, options.certPort ?? 0, host);
  } catch (err) {
    await Promise.all([closeServer(mainServer), closeServer(certServer)]);
    throw err;
  }
  ctx.urls.main = `https://${publicHost}:${port}`;
  ctx.urls.cert = `https://${publicHost}:${certPort}`;

  return {
    url: ctx.urls.main,
    certUrl: ctx.urls.cert,
    port,
    certPort,
    caCertPem: tls.ca.certPem,
    caCertPath: tls.caPath,
    serverCertSpkiSha256: spkiSha256Base64(tls.server.certPem),
    clientCaCertPem: clientCa.trustedPems.join(''),
    demo: {
      dni: DEMO_USER.dni,
      clavePassword:
        (options.users ?? [DEMO_USER]).find((u) => u.dni === DEMO_USER.dni)?.password ??
        DEMO_USER.password,
      certificateP12Path: FIXTURE_PATHS.demoIdentityP12,
      certificatePassphrase: DEMO_IDENTITY_PASSPHRASE,
    },
    config,
    test: testApi,
    close: async () => {
      await Promise.all([closeServer(mainServer), closeServer(certServer)]);
    },
  };
}
