import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { tracesApi } from './src/server/api.ts';

/**
 * The trace viewer (src/cli.ts starts it). SA_TRACES_INPUT is what it opens: a userData folder,
 * a transcripts export, a capture or a trace.zip. Loopback only: traces hold personal data.
 */
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tracesApi(process.env.SA_TRACES_INPUT || undefined)],
  server: { host: '127.0.0.1', port: 5190, strictPort: false },
  clearScreen: false,
  logLevel: 'warn',
});
