import type { SaApi, SaEvent } from '@sa/shared';
import { contextBridge, ipcRenderer } from 'electron';

// Keep the preload tiny: only type imports from @sa/shared (no runtime code / zod).
// Channel names must match SA_INVOKE_CHANNEL / SA_EVENT_CHANNEL in @sa/shared ipc.ts.
const INVOKE = 'sa:invoke';
const EVENT = 'sa:event';

/**
 * Electron reports handler errors as "Error invoking remote method 'sa:invoke': UserError: …".
 * The renderer gets just the message (user-facing errors are already plain Spanish/English).
 */
function cleanError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^[A-Za-z]*Error:\s*/, '');
  return new Error(message || raw);
}

const api: SaApi = {
  invoke: (method, ...args) =>
    ipcRenderer.invoke(INVOKE, method, ...args).catch((err: unknown) => {
      throw cleanError(err);
    }),
  on(listener) {
    const handler = (_e: Electron.IpcRendererEvent, event: SaEvent) => listener(event);
    ipcRenderer.on(EVENT, handler);
    return () => ipcRenderer.removeListener(EVENT, handler);
  },
};

contextBridge.exposeInMainWorld('sa', api);

contextBridge.exposeInMainWorld('saScanner', {
  start: (sessionId: string, source?: 'camera' | 'photo') =>
    ipcRenderer
      .invoke('sa:scanner', 'start', source ? { sessionId, source } : sessionId)
      .catch((err: unknown) => {
        throw cleanError(err);
      }),
  frames: (sessionId: string, requestId: string, images: string[]) =>
    ipcRenderer
      .invoke('sa:scanner', 'frames', { sessionId, requestId, images })
      .catch((err: unknown) => {
        throw cleanError(err);
      }),
  cancel: (sessionId: string) => ipcRenderer.invoke('sa:scanner', 'cancel', sessionId),
  on: (listener: (event: import('../scanner').ScannerEvent) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      update: import('../scanner').ScannerEvent,
    ) => listener(update);
    ipcRenderer.on('sa:scanner:event', handler);
    return () => ipcRenderer.removeListener('sa:scanner:event', handler);
  },
  requestCamera: () => ipcRenderer.invoke('sa:scanner', 'requestCamera'),
  openCameraSettings: () => ipcRenderer.invoke('sa:scanner', 'openCameraSettings'),
  cameraEvent: (event: unknown) => ipcRenderer.invoke('sa:scanner', 'cameraEvent', event),
  status: () =>
    ipcRenderer.invoke('sa:scanner', 'status').catch((err: unknown) => {
      throw cleanError(err);
    }),
  read: (dataUrl: string) =>
    ipcRenderer.invoke('sa:scanner', 'read', dataUrl).catch((err: unknown) => {
      throw cleanError(err);
    }),
});
