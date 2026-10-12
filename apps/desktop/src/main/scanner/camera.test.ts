import { describe, expect, it, vi } from 'vitest';
import type { CameraAccess } from '../../scanner';
import { createLogger } from '../core/logger';
import { createCameraRequester, logCameraEvent, requestCameraAccess } from './camera';

function fixture(status: CameraAccess['status'] = 'not-determined') {
  const lines: string[] = [];
  const log = createLogger({ sinks: [(line) => lines.push(line)] });
  const system = {
    getMediaAccessStatus: vi.fn(() => status),
    askForMediaAccess: vi.fn(async () => true),
  };
  return { system, log, lines };
}

describe('native camera permission', () => {
  it('requests native permission before capture and logs the result', async () => {
    const { system, log, lines } = fixture();
    system.getMediaAccessStatus.mockReturnValueOnce('not-determined').mockReturnValue('granted');
    expect(await requestCameraAccess(system, log, true)).toEqual({
      granted: true,
      status: 'granted',
      settingsAvailable: true,
    });
    expect(system.askForMediaAccess).toHaveBeenCalledWith('camera');
    expect(lines.join('\n')).toContain('not-determined');
    expect(lines.join('\n')).toContain('camera permission result');
  });

  it('asks for the microphone the same way, for recording phone calls', async () => {
    const { system, log, lines } = fixture('granted');
    const request = createCameraRequester(system, log, true, 'microphone');
    expect((await request()).granted).toBe(true);
    expect(system.getMediaAccessStatus).toHaveBeenCalledWith('microphone');
    expect(lines.join('\n')).toContain('microphone permission result');
  });

  it('shares one native request between concurrent callers', async () => {
    const { system, log } = fixture();
    const request = createCameraRequester(system, log, true);
    await Promise.all([request(), request()]);
    expect(system.askForMediaAccess).toHaveBeenCalledTimes(1);
    await request();
    expect(system.askForMediaAccess).toHaveBeenCalledTimes(2);
  });

  it('distinguishes an unavailable OS prompt from a user denial', async () => {
    const { system, log, lines } = fixture();
    system.askForMediaAccess.mockResolvedValue(false);
    expect(await requestCameraAccess(system, log, true)).toEqual({
      granted: false,
      status: 'not-determined',
      settingsAvailable: false,
    });
    expect(lines.join('\n')).toContain('prompt unavailable');
  });

  it('does not request again when already granted', async () => {
    const { system, log } = fixture('granted');
    expect((await requestCameraAccess(system, log, true)).granted).toBe(true);
    expect(system.askForMediaAccess).not.toHaveBeenCalled();
  });

  it('returns denied access with settings recovery and warning logs', async () => {
    const { system, log, lines } = fixture('denied');
    system.askForMediaAccess.mockResolvedValue(false);
    expect(await requestCameraAccess(system, log, true)).toEqual({
      granted: false,
      status: 'denied',
      settingsAvailable: true,
    });
    expect(lines.join('\n')).toContain('WARN');
  });

  it('records native failures without arbitrary error messages', async () => {
    const { system, log, lines } = fixture();
    system.askForMediaAccess.mockRejectedValue(new Error('private content'));
    expect((await requestCameraAccess(system, log, true)).granted).toBe(false);
    expect(lines.join('\n')).toContain('camera permission request failed');
    expect(lines.join('\n')).not.toContain('private content');
  });

  it('never requests OS access in mocked runs and records capture failures', async () => {
    const { system, log, lines } = fixture();
    expect((await requestCameraAccess(system, log, false)).granted).toBe(true);
    expect(system.getMediaAccessStatus).not.toHaveBeenCalled();
    expect(system.askForMediaAccess).not.toHaveBeenCalled();
    logCameraEvent(log, { stage: 'failed', errorName: 'NotAllowedError' });
    expect(lines.join('\n')).toContain('NotAllowedError');
  });
});
