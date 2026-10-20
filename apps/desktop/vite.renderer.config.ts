import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Standalone browser preview of the renderer (no Electron). `window.sa` does not exist there, so
 * the renderer falls back to the in-memory mock API (src/renderer/src/mock).
 *
 *   corepack pnpm --filter @sa/desktop preview:web          # dev server on http://localhost:5180
 *   corepack pnpm --filter @sa/desktop build:web            # static build in out/renderer-web
 *
 * Useful query params (mock only): ?onboarding=1 (splash) or =voucher|data (open that step;
 * add &provider=voucher for data), ?lang=en, ?provider=none|chatgpt|voucher|byok, ?chatgpt=ineligible,
 * ?playground=1 (interactive agent UI catalogue), ?example=<id>, ?map=1 (map picker; ?nomap=1: its list only, lookups used up), ?appointment=1 (appointment picker), ?phone=1 (phone-call card), ?dnie=1 (feature flag: DNIe with the phone on; ?companion, ?dnieSaved and ?playground imply it), ?companion=waiting|away|connected (DNIe phone pairing; =phone_unpaired|expired|relay_refused: the last pairing ended that way; =outdated|outdated_desktop: the phone app or this one needs an update; =stalled: the relay is out of reach), ?dnieSaved=1|pin (a saved DNIe in Mis datos; =pin with its PIN saved), ?address=1 (saved mock address, located on open), ?empty=1, ?freeze=1 (no simulated activity), ?speed=4, ?view=vault|settings, ?p=<procedureId>, ?errors=1 (feature flag: the error-reports setting), ?mustUpdate=1 (feature flag: the must-update screen, playing a Windows update; =checking|downloading|ready|error|unsupported shows one state), ?dataImport=uninstall|import (Windows Store build: the screen that asks to uninstall the GitHub install, then copies its data), ?store=1 (the Microsoft Store build: with ?mustUpdate=1, the screen opens the Store).
 */

/** The app CSP forbids inline scripts; Vite's React refresh preamble needs one in dev. */
function relaxCspInDev(): Plugin {
  return {
    name: 'sa-relax-csp-in-dev',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '');
    },
  };
}

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  resolve: {
    alias: { '@renderer': resolve(__dirname, 'src/renderer/src') },
  },
  plugins: [react(), tailwindcss(), relaxCspInDev()],
  server: { port: 5180, strictPort: false, watch: null, hmr: false },
  preview: { port: 5181, strictPort: false },
  build: {
    outDir: resolve(__dirname, 'out/renderer-web'),
    emptyOutDir: true,
  },
});
