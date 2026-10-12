# Launch video

An 18-second, 1080p60 animation of the app's happy path ("Me quiero empadronar" → rental
contract → DNIe signature → certificate) for the launch announcement. It's a hand-built replica
of the UI (the app's colors, fonts and Lucide icons) with mock data, so it renders offline.

```sh
node marketing/launch-video/render.mjs                 # → out/spain-assist-launch.mp4
node marketing/launch-video/render.mjs --stills 3,7.5  # PNGs of those seconds
```

Needs ffmpeg and the Chromium that `apps/desktop`'s playwright-core expects. `scene.js` sets
every style as a function of time; change the timing in its `T` table.
