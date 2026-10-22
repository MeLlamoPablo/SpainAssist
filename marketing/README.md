# Marketing videos

1080p60 animations, hand-built replicas of the UI (the app's colors, fonts and Lucide icons) with
mock data, so they render offline. Each `scene.js` sets every style as a function of time; change
the timing in its `T` table.

- `launch-video`: 18 seconds, the desktop app's happy path ("Me quiero empadronar" → rental
  contract → DNIe signature → certificate) for the launch announcement.
- `dnie-video`: 22 seconds, the call for Android testers. Mis datos shows "DNIe con el móvil"
  with its "Acceso anticipado" pill, "Probar" opens the early-access dialog and then the pairing
  QR, and a Pixel scans it and signs a PDF with the DNIe. The phone's screens in `phone/` are
  real: the debug app's `PreviewActivity` (apps/mobile/README.md) on the `sa_preview` emulator
  in light mode, captured with `adb exec-out screencap`. `qr.svg` is the web preview's pairing QR
  (`?dnie=prerelease`).

```sh
node marketing/render.mjs dnie-video                 # → marketing/dnie-video/out/spain-assist-dnie-video.mp4
node marketing/render.mjs dnie-video --stills 3,7.5  # PNGs of those seconds
```

Needs ffmpeg and the Chromium that `apps/desktop`'s playwright-core expects.
