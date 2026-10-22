/**
 * HTTP side of the relay:
 * - `GET /health`;
 * - `GET /p`: the page a pairing link opens when the phone app isn't installed (or App Links
 *   aren't verified). It offers the Android download; the pairing payload stays in the
 *   fragment (never sent to us);
 * - `GET /.well-known/assetlinks.json`: verifies the app for App Links on this host, when the
 *   signing certificate fingerprints are configured.
 */
import { readFileSync } from 'node:fs';
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

const fonts = new Map(
  [
    ['inter-latin-wght-normal.woff2', 'font/woff2'],
    ['instrument-serif-regular.ttf', 'font/ttf'],
    ['instrument-serif-italic.ttf', 'font/ttf'],
  ].map(([name, contentType]) => [
    name,
    { contentType, data: readFileSync(new URL(`../assets/${name}`, import.meta.url)) },
  ]),
);

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function landingPage(installUrl: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Spain Assist</title>
<style>
  @font-face {
    font-family: Inter; font-style: normal; font-weight: 100 900; font-display: swap;
    src: url("/assets/inter-latin-wght-normal.woff2") format("woff2");
  }
  @font-face {
    font-family: "Instrument Serif"; font-style: normal; font-weight: 400; font-display: swap;
    src: url("/assets/instrument-serif-regular.ttf") format("truetype");
  }
  @font-face {
    font-family: "Instrument Serif"; font-style: italic; font-weight: 400; font-display: swap;
    src: url("/assets/instrument-serif-italic.ttf") format("truetype");
  }
  :root {
    color-scheme: light dark;
    --bg: #fff; --fg: #28211d; --subtle: #79736e;
    --accent: #28211d; --accent-hover: #463d37; --accent-fg: #fff; --flag-outline: #d4d0cb;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1e1b19; --fg: #edebe7; --subtle: #96918c;
      --accent: #edebe7; --accent-hover: #fff; --accent-fg: #1e1b19; --flag-outline: #fff;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/22px Inter, system-ui, sans-serif; }
  main {
    display: flex; flex-direction: column; align-items: center; justify-content: space-between;
    min-height: 100vh; min-height: 100svh; max-width: 496px; margin: 0 auto;
    padding: 152px 24px 64px; gap: 64px;
  }
  .brand {
    display: flex; align-items: center; gap: 11px; height: 44px; flex-shrink: 0;
    font: 400 44px/44px "Instrument Serif", serif; letter-spacing: -.02em; white-space: nowrap;
  }
  .brand-flag {
    width: 39px; height: 26px; border-radius: 5px;
    background: linear-gradient(#c60b1e 25%, #ffc400 25% 75%, #c60b1e 75%);
    box-shadow: inset 0 0 0 1.3px var(--flag-outline);
  }
  .content { width: 100%; }
  h1 { font-size: 24px; line-height: 30px; font-weight: 600; margin: 0; text-wrap: balance; }
  p { color: var(--subtle); margin: 10px 0 64px; text-wrap: pretty; }
  .download {
    display: flex; align-items: center; justify-content: center; min-height: 52px;
    padding: 14px 24px; border-radius: 12px; background: var(--accent); color: var(--accent-fg);
    text-align: center; text-decoration: none; font-weight: 600; line-height: 24px;
  }
  .download:hover { background: var(--accent-hover); }
  .download:focus-visible { outline: 3px solid var(--fg); outline-offset: 4px; }
</style>
</head>
<body>
<main>
  <header class="brand" aria-label="Spain Assist">
    <span class="brand-flag" aria-hidden="true"></span>
    <span>Spain</span> <i>Assist</i>
  </header>
  <section class="content" aria-labelledby="title">
    <h1 id="title">Firma con tu DNI</h1>
    <p>Conecta la app de escritorio de Spain Assist con tu móvil para firmar.</p>
    <a class="download" href="${escapeHtml(installUrl)}">Descargar Spain Assist para Android</a>
  </section>
</main>
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

  app.get('/assets/:name', (c) => {
    const font = fonts.get(c.req.param('name'));
    if (!font) return c.notFound();
    return c.body(font.data, 200, {
      'Content-Type': font.contentType,
      'Cache-Control': 'public, max-age=86400',
    });
  });

  app.get('/p', (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'none'",
    );
    return c.html(landingPage(installUrl));
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
