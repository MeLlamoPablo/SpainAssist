import { describe, expect, it } from 'vitest';
import { cameraOptions, keptCamera } from './cameras';

const device = (kind: MediaDeviceKind, deviceId: string, label = ''): MediaDeviceInfo =>
  ({ kind, deviceId, label, groupId: '', toJSON: () => ({}) }) as MediaDeviceInfo;

describe('camera options', () => {
  it('lists only video inputs, once each, naming unlabelled ones', () => {
    const cameras = cameraOptions(
      [
        device('audioinput', 'mic', 'Micrófono'),
        device('videoinput', 'mac', 'FaceTime HD Camera'),
        device('videoinput', 'mac', 'FaceTime HD Camera'),
        device('videoinput', 'iphone', ''),
        device('videoinput', '', 'No id'),
      ],
      (n) => `Cámara ${n}`,
    );
    expect(cameras).toEqual([
      { deviceId: 'mac', label: 'FaceTime HD Camera' },
      { deviceId: 'iphone', label: 'Cámara 2' },
    ]);
  });

  it('keeps the chosen camera only while it is connected', () => {
    const cameras = [{ deviceId: 'iphone', label: 'iPhone' }];
    expect(keptCamera('iphone', cameras)).toBe('iphone');
    expect(keptCamera('gone', cameras)).toBeNull();
    expect(keptCamera(null, cameras)).toBeNull();
  });
});
