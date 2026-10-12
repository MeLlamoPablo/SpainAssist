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
  return assets;
}
