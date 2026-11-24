/**
 * HTTP side of the relay:
 * - `GET /health`;
 * - `GET /p`: the page a pairing link opens when the phone app isn't installed (or App Links
 *   aren't verified). It offers the Android download; the pairing payload stays in the
 *   fragment (never sent to us);
 * - `GET /android` and `GET /android/latest.json`: the download page of the APK offered outside
 *   Google Play, and what the desktop reads to tell an out-of-date phone app. Without an APK
 *   configured they point to the store;
 * - `GET /.well-known/assetlinks.json`: verifies the app for App Links on this host, when the
 *   signing certificate fingerprints are configured.
 */
import { readFileSync } from 'node:fs';
import { type Context, Hono } from 'hono';

export interface AppOptions {
  /** Android application id (default es.spainassist.firma). */
  androidPackage?: string;
  /** SHA-256 fingerprints of the app's signing certificates ("AB:CD:…"). */
  androidCertFingerprints?: string[];
  /** Where to install the app; default the Play Store page of `androidPackage`. */
  installUrl?: string;
  /** The APK offered outside Google Play now; with one, `/p` sends to `/android`, not `installUrl`. */
  androidApk?: () => AndroidApk | undefined;
  /** Trust X-Forwarded-For and X-Forwarded-Proto (only behind our own reverse proxy). */
  trustProxy?: boolean;
}

/** The universal APK Google Play signs, hosted as an asset of its `android/vX.Y.Z` release. */
export interface AndroidApk {
  /** Direct download URL. */
  url: string;
  /** X.Y.Z. */
  version: string;
  /** SHA-256 of the file, in hex. */
  sha256: string;
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

/** A page in the relay's own style: no scripts, fonts served from here. */
function page(main: string, style = ''): string {
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
  .download:focus-visible { outline: 3px solid var(--fg); outline-offset: 4px; }${style}
</style>
</head>
<body>
${main}
</body>
</html>`;
}

const BRAND = `<header class="brand" aria-label="Spain Assist">
    <span class="brand-flag" aria-hidden="true"></span>
    <span>Spain</span> <i>Assist</i>
  </header>`;

function landingPage(installUrl: string): string {
  return page(`<main>
  ${BRAND}
  <section class="content" aria-labelledby="title">
    <h1 id="title">Firma con tu DNI</h1>
    <p>Conecta la app de escritorio de Spain Assist con tu móvil para firmar.</p>
    <a class="download" href="${escapeHtml(installUrl)}">Descargar Spain Assist para Android</a>
  </section>
</main>`);
}

/** Android's head, from Simple Icons (CC0), in the button's colour. */
const ANDROID_ICON = `<svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18.4395 5.5586c-.675 1.1664-1.352 2.3318-2.0274 3.498-.0366-.0155-.0742-.0286-.1113-.043-1.8249-.6957-3.484-.8-4.42-.787-1.8551.0185-3.3544.4643-4.2597.8203-.084-.1494-1.7526-3.021-2.0215-3.4864a1.1451 1.1451 0 0 0-.1406-.1914c-.3312-.364-.9054-.4859-1.379-.203-.475.282-.7136.9361-.3886 1.5019 1.9466 3.3696-.0966-.2158 1.9473 3.3593.0172.031-.4946.2642-1.3926 1.0177C2.8987 12.176.452 14.772 0 18.9902h24c-.119-1.1108-.3686-2.099-.7461-3.0683-.7438-1.9118-1.8435-3.2928-2.7402-4.1836a12.1048 12.1048 0 0 0-2.1309-1.6875c.6594-1.122 1.312-2.2559 1.9649-3.3848.2077-.3615.1886-.7956-.0079-1.1191a1.1001 1.1001 0 0 0-.8515-.5332c-.5225-.0536-.9392.3128-1.0488.5449zm-.0391 8.461c.3944.5926.324 1.3306-.1563 1.6503-.4799.3197-1.188.0985-1.582-.4941-.3944-.5927-.324-1.3307.1563-1.6504.4727-.315 1.1812-.1086 1.582.4941zM7.207 13.5273c.4803.3197.5506 1.0577.1563 1.6504-.394.5926-1.1038.8138-1.584.4941-.48-.3197-.5503-1.0577-.1563-1.6504.4008-.6021 1.1087-.8106 1.584-.4941z"/></svg>`;

/** The download page of the APK: the button and its version at the bottom, within thumb's reach. */
function downloadPage(apk: AndroidApk): string {
  return page(
    `<main class="apk">
  ${BRAND}
  <section class="content" aria-labelledby="title">
    <h1 id="title" class="hidden">Spain Assist para Android</h1>
    <a class="download" href="${escapeHtml(apk.url)}">${ANDROID_ICON}Descargar para Android</a>
    <p class="version">Versión ${escapeHtml(apk.version)}</p>
  </section>
  <footer>
    <p>Spain Assist es una app privada y no representa a ninguna entidad gubernamental.</p>
  </footer>
</main>`,
    `
  :root { --faint: #a39d98; }
  @media (prefers-color-scheme: dark) { :root { --faint: #67625d; } }
  main.apk { justify-content: flex-start; padding: 72px 24px 32px; gap: 32px; }
  .apk .content { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; }
  .apk .download { gap: 8px; }
  .apk .download svg { flex-shrink: 0; }
  .apk .version { margin: 12px 0 0; text-align: center; font-size: 13px; line-height: 18px; }
  .hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  footer { width: 100%; padding: 0 30px; text-align: center; font-size: 11px; line-height: 18px; }
  footer p { margin: 0; color: var(--faint); }`,
  );
}

export function createApp(options: AppOptions = {}): Hono {
  const pkg = options.androidPackage ?? DEFAULT_ANDROID_PACKAGE;
  const installUrl =
    options.installUrl ??
    `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}`;
  const fingerprints = options.androidCertFingerprints ?? [];
  const currentApk = options.androidApk ?? (() => undefined);
  const app = new Hono();

  const html = (c: Context, body: string) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'none'",
    );
    return c.html(body);
  };

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.get('/assets/:name', (c) => {
    const font = fonts.get(c.req.param('name'));
    if (!font) return c.notFound();
    return c.body(font.data, 200, {
      'Content-Type': font.contentType,
      'Cache-Control': 'public, max-age=86400',
    });
  });

  // The link to `/android` carries no fragment: the pairing payload stays in the phone's browser.
  app.get('/p', (c) => html(c, landingPage(currentApk() ? '/android' : installUrl)));

  app.get('/android', (c) => {
    const apk = currentApk();
    return apk ? html(c, downloadPage(apk)) : c.redirect(installUrl, 302);
  });

  app.get('/android/latest.json', (c) => {
    const apk = currentApk();
    c.header('Cache-Control', 'public, max-age=300');
    if (!apk) return c.json({ store: installUrl });
    const url = new URL('/android', c.req.url);
    // Our proxy ends TLS: the request reaches us as http.
    const forwarded = options.trustProxy
      ? c.req.header('x-forwarded-proto')?.split(',')[0]?.trim()
      : undefined;
    if (forwarded === 'https' || forwarded === 'http') url.protocol = forwarded;
    return c.json({ version: apk.version, url: apk.url, sha256: apk.sha256, page: url.href });
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
