/// <reference types="vite/client" />
import type { SaApi } from '@sa/shared';

declare global {
  interface Window {
    /** Exposed by the preload script. Undefined when the renderer runs in a plain browser. */
    sa?: SaApi;
    saScanner?: import('../scanner').ScannerApi;
  }
}
