/** Static files under public/ (CSS, page scripts and the imitation autoscript.js). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { MockSedeConfig } from './context';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

export interface Asset {
  body: string;
  contentType: string;
}

const FILES: Record<string, string> = {
  '/css/sede.css': 'text/css; charset=utf-8',
  '/js/sede.js': 'text/javascript; charset=utf-8',
  '/js/tramite-firma.js': 'text/javascript; charset=utf-8',
  '/js/autoscript.js': 'text/javascript; charset=utf-8',
};

/**
 * Loads the assets once. The AutoFirma connection constants of autoscript.js are rewritten from
 * the config (lines tagged with a "mock-sede:" comment) so tests can make the "AutoFirma not
 * installed" error appear quickly.
 */
export function loadAssets(config: MockSedeConfig): Map<string, Asset> {
  const assets = new Map<string, Asset>();
  for (const [path, contentType] of Object.entries(FILES)) {
    let body = readFileSync(`${PUBLIC_DIR}${path.slice(1)}`, 'utf8');
    if (path === '/js/autoscript.js') {
      const set = (tag: string, value: number) => {
        const re = new RegExp(`= \\d+; // mock-sede:${tag}`);
        if (!re.test(body)) throw new Error(`autoscript.js: missing mock-sede:${tag} marker`);
        body = body.replace(re, `= ${Math.max(0, Math.round(value))}; // mock-sede:${tag}`);
      };
      set('launching-time', config.autofirma.launchingTimeMs);
      set('retries', config.autofirma.retries);
      set('retry-interval', config.autofirma.retryIntervalMs);
    }
    assets.set(path, { body, contentType });
  }
  assets.set(GSEDE_CLIENT_SIGNER, {
    body: gsedeClientSigner(assets.get('/js/autoscript.js')!.body),
    contentType: 'text/javascript; charset=utf-8',
  });
  return assets;
}

/** The gsede login's script: its own autoscript.js copy followed by the clientSigner wrapper. */
export const GSEDE_CLIENT_SIGNER = '/gsede/js/clientSigner.js';

/**
 * Like the real platform, the bundle carries an older autoscript (1.8.0) with the two
 * certificate-wait setters its wrapper calls, which the official 1.9/1.10 clients don't have.
 */
function gsedeClientSigner(autoscript: string): string {
  const replace = (body: string, tag: string, re: RegExp, value: string) => {
    if (!re.test(body)) throw new Error(`autoscript.js: missing mock-sede:${tag} marker`);
    return body.replace(re, value);
  };
  let body = replace(
    autoscript,
    'version',
    /var VERSION = '[^']*'; \/\/ mock-sede:version/,
    "var VERSION = '1.8.0';",
  );
  body = replace(
    body,
    'extra-members',
    / *\/\/ mock-sede:extra-members/,
    [
      '    setWaitCertMaxLoops: function (loops) { certificateWait.loops = loops; },',
      '    setWaitCertTimeout: function (timeout) { certificateWait.timeoutMs = timeout; },',
    ].join('\n'),
  );
  const wrapper = readFileSync(`${PUBLIC_DIR}js/clientsigner.js`, 'utf8');
  return `var certificateWait = { loops: 15, timeoutMs: 4000 };\n${body}\n${wrapper}`;
}
