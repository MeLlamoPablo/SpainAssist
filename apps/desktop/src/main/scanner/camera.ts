import type { CameraAccess, CameraEvent } from '../../scanner';
import type { Logger } from '../core/logger';

/** The camera (document scanning) or the microphone (recording phone calls). */
export type MediaDevice = 'camera' | 'microphone';

export interface CameraSystem {
  getMediaAccessStatus(media: MediaDevice): CameraAccess['status'];
  askForMediaAccess(media: MediaDevice): Promise<boolean>;
}

/** Request native access explicitly, before Chromium starts device acquisition. */
export async function requestCameraAccess(
  system: CameraSystem,
  log: Logger,
  native: boolean,
  media: MediaDevice = 'camera',
): Promise<CameraAccess> {
  if (!native) {
    log.info(`${media} permission delegated to browser`);
    return { granted: true, status: 'unknown', settingsAvailable: false };
  }
  const before = system.getMediaAccessStatus(media);
  log.info(`${media} permission requested`, { status: before });
  try {
    const granted = before === 'granted' || (await system.askForMediaAccess(media));
    const status = system.getMediaAccessStatus(media);
    (granted ? log.info : log.warn)(`${media} permission result`, { granted, status });
    if (!granted && status === 'not-determined')
      log.warn(
        `${media} permission prompt unavailable; check the launcher ${media} entitlement or use Launch Services`,
      );
    return { granted, status, settingsAvailable: status !== 'not-determined' };
  } catch (error) {
    log.error(`${media} permission request failed`, {
      errorName: error instanceof Error ? error.name : 'UnknownError',
      status: system.getMediaAccessStatus(media),
    });
    return {
      granted: false,
      status: system.getMediaAccessStatus(media),
      settingsAvailable: true,
    };
  }
}

export function logCameraEvent(log: Logger, event: CameraEvent): void {
  const write = event.stage === 'failed' || event.stage === 'timeout' ? log.warn : log.info;
  write('camera capture', event);
}

/** React development remounts can request access concurrently. Show only one OS prompt. */
export function createCameraRequester(
  system: CameraSystem,
  log: Logger,
  native: boolean,
  media: MediaDevice = 'camera',
) {
  let pending: Promise<CameraAccess> | undefined;
  return () => {
    pending ??= requestCameraAccess(system, log, native, media).finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
