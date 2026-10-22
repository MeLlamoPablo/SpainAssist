# Marketing videos

1080p60 animations, hand-built replicas of the UI (the app's colors, fonts and Lucide icons) with
mock data, so they render offline. Each `scene.js` sets every style as a function of time; change
the timing in its `T` table.

- `launch-video`: 18 seconds, the desktop app's happy path ("Me quiero empadronar" → rental
  contract → DNIe signature → certificate) for the launch announcement.
- `dni-video`: 20 seconds, the call for Android testers. Mis datos shows "DNI con el móvil" with
  its "Acceso anticipado" pill, "Probar" opens the pairing QR, and a Pixel held up to the screen
  scans it (its viewfinder films a copy of the window) and signs a PDF with the DNI. The phone's
  screens are rebuilt in dp from `apps/mobile/…/ui/FirmaApp.kt` and its strings, with a few
  animations of their own. `qr.svg` is the web preview's pairing QR (`?dnie=prerelease`).

```sh
node marketing/render.mjs dni-video                 # → marketing/dni-video/out/spain-assist-dni-video.mp4
node marketing/render.mjs dni-video --stills 3,7.5  # PNGs of those seconds
```

Needs ffmpeg and the Chromium that `apps/desktop`'s playwright-core expects.
