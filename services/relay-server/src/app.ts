/**
 * HTTP side of the relay:
 * - `GET /health`;
 * - `GET /p`: the page a pairing link opens when the phone app isn't installed (or App Links
 *   aren't verified). It reads the payload from the fragment (never sent to us) and offers to
 *   open it in the app or to install it;
 * - `GET /.well-known/assetlinks.json`: verifies the app for App Links on this host, when the
 *   signing certificate fingerprints are configured.
 */
import { Hono } from 'hono';

export interface AppOptions {
  /** Android application id (default es.spainassist.firma). */
  androidPackage?: string;
  /** SHA-256 fingerprints of the app's signing certificates ("AB:CD:…"). */
  androidCertFingerprints?: string[];
  /** Where to install the app; default the Play Store page of `androidPackage`. */
  installUrl?: string;
}

export const DEFAULT_ANDROID_PACKAGE = 'es.spainassist.firma';

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function landingPage(pkg: string, installUrl: string): string {
  // The script builds an intent:// link with the payload as a query parameter of the app's own
  // scheme (an intent URL can't carry a fragment). Chrome opens the store when the app is
  // missing. Nothing here talks to the server.
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Spain Assist</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f6f2; --fg: #1d1d1b; --muted: #5f5e58; --accent: #b4441c; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161614; --fg: #f1efe8; --muted: #aaa79d; --accent: #ef8a5e; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.5 system-ui, sans-serif; }
  main { max-width: 28rem; margin: 0 auto; padding: 3rem 1rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .75rem; }
  p { color: var(--muted); margin: 0 0 1rem; }
  a.button { display: block; text-align: center; padding: .9rem 1rem; border-radius: .75rem; margin: 0 0 .75rem;
    background: var(--accent); color: #fff; text-decoration: none; font-weight: 600; }
  a.secondary { background: transparent; color: var(--accent); border: 1px solid currentColor; }
</style>
</head>
<body>
<main>
  <h1>Firma con tu DNI desde el móvil</h1>
  <p>Este enlace conecta tu móvil con Spain Assist en tu ordenador. Ábrelo con la app Spain Assist del móvil.</p>
  <a class="button" id="open" href="#">Abrir en la app</a>
  <a class="button secondary" href="${escapeHtml(installUrl)}">Instalar la app</a>
  <p lang="en">Open this link with the Spain Assist app to pair your phone with your computer.</p>
</main>
<script>
  (function () {
    var payload = location.hash.slice(1);
    var open = document.getElementById('open');
    if (!/^[A-Za-z0-9_-]+$/.test(payload)) { open.style.display = 'none'; return; }
    open.href = 'intent://pair?d=' + payload + '#Intent;scheme=sa-firma;package=${escapeHtml(pkg)};end';
  })();
</script>
</body>
</html>`;
}

export function createApp(options: AppOptions = {}): Hono {
  const pkg = options.androidPackage ?? DEFAULT_ANDROID_PACKAGE;
  const installUrl =
    options.installUrl ??
    `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}`;
  const fingerprints = options.androidCertFingerprints ?? [];
  const app = new Hono();

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.get('/p', (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    );
    return c.html(landingPage(pkg, installUrl));
  });

  app.get('/.well-known/assetlinks.json', (c) => {
    if (fingerprints.length === 0) return c.notFound();
    return c.json([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: pkg,
          sha256_cert_fingerprints: fingerprints,
        },
      },
    ]);
  });

  return app;
}
