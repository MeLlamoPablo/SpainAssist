export interface CameraOption {
  deviceId: string;
  label: string;
}

/** The video inputs the person can pick from. Labels are empty until camera permission. */
export function cameraOptions(
  devices: readonly MediaDeviceInfo[],
  unnamed: (n: number) => string,
): CameraOption[] {
  const seen = new Set<string>();
  const cameras: CameraOption[] = [];
  for (const device of devices) {
    if (device.kind !== 'videoinput' || !device.deviceId || seen.has(device.deviceId)) continue;
    seen.add(device.deviceId);
    cameras.push({
      deviceId: device.deviceId,
      label: device.label.trim() || unnamed(cameras.length + 1),
    });
  }
  return cameras;
}

/** The chosen camera if it is still connected; otherwise `null` (the system default). */
export function keptCamera(selected: string | null, cameras: readonly CameraOption[]) {
  return selected && cameras.some((camera) => camera.deviceId === selected) ? selected : null;
}
