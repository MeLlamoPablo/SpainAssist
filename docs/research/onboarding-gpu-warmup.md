# Onboarding GPU warm-up — research memo

*Date: 2026-10-07 · Scope: why the first splash → voucher switch in the onboarding lagged, what
fixed it, what did not, and how to measure it. Code: `apps/desktop/src/renderer/src/features/
onboarding/Onboarding.tsx` (`Rehearsal`, `RehearsalCopy`), `components/LiquidGradient.tsx`, and
`revealWindow` in `apps/desktop/src/main/index.ts`. Commits `85829b7`, `bb73d44`, `f8d2147`.*

## TL;DR

- **Cause:** with a cold GPU shader cache, Skia **Graphite** (Chromium's renderer on macOS, on
  Dawn/Metal) compiles a new GPU pipeline the first time it draws a new mix of shape, clip,
  filter, blend and render-pass format. Each compile blocks the GPU process main thread for
  100–400 ms, so *every* frame stops: CSS animations, the WebGL gradient, everything. The first
  splash → card switch needed about 30 new pipelines, so it froze for about 600 ms in total.
- **Not a JS problem.** Long-animation-frame entries show no script, style or layout time. The
  time is in the GPU process (`RasterDecoderImpl::DoEndRasterCHROMIUM`, `skgpu::graphite::
  QueueManager::addRecording`, waiting for `DawnPlatformImpl::RunWorkerTask`).
- **Not the gradient shader.** The WebGL shader is cheap and compiles once at startup. A native
  port would not help.
- **"Cold" happens in real life:** first launch, after an Electron update, after a macOS update,
  and also when macOS evicts its Metal cache. We saw "warm" launches stall again after other
  Electron runs had filled the cache.
- **Fix (current design):**
  1. During the onboarding, the window opens **invisible** (opacity 0, click-through, inactive).
  2. The splash plays a hidden **rehearsal** of the switch **under the gradient**: 16 copies, each
     62.5 ms further into the switch, restarting on their own.
  3. When 125 ms pass with no frame longer than 50 ms, the renderer calls `app.reveal` and the
     splash entrance plays.
- **Result** (M3 Max, 120 Hz, Electron 44.5.1):

  | | Trunk before | Now |
  | --- | --- | --- |
  | Window shows, warm cache | ~0.23 s | ~0.44 s |
  | Window shows, cold cache | ~0.35 s | ~2.6 s |
  | Slow frames after the window shows | 117–417 ms (cold) | none (max 10.4 ms, 15/15 cold runs) |

- **Open:** 2.6 s on a cold launch is still too long (§7). Slower GPUs are not measured.

## 1. How to reproduce and measure

### 1.1 Make the cache cold

The macOS Metal cache of the dev Electron binary lives in
`$(getconf DARWIN_USER_CACHE_DIR)/com.github.Electron.helper/` (`com.apple.metal`,
`com.apple.gpuarchiver`, `com.apple.metalfe`). Delete these three folders before each launch, and
use a fresh `SA_USER_DATA_DIR` (Chromium's own GPU caches are in userData). They are caches; the
OS and Chromium rebuild them. A packaged app has its own bundle id, so its cache folder has
another name.

Without this step, results are random: the first run after a build is cold, later runs are mostly
warm, and sometimes warm again goes cold.

### 1.2 Measure frames in the real Electron app

The web preview (`preview:web`) is not enough: plain Chromium has its own Metal cache and other
flags, and it showed no lag after its first run. Measure the built app (`corepack pnpm --filter
@sa/desktop build`) with `_electron` from `playwright-core`, the window visible
(`SA_HIDE_WINDOW=0`):

1. Launch with a fresh `SA_USER_DATA_DIR`.
2. Poll the main process until the window is visible **and** `getOpacity() === 1`. That is the
   time the user sees the app. (`isVisible()` is not a good signal for an opacity-0 window.)
3. In the page, record `requestAnimationFrame` timestamps for 1.3–1.5 s while you click
   `onboarding-voucher`, then "Atrás", then the voucher button again. Count intervals > 20 ms.
4. Check that the card really shows (`voucher-input` visible). A crash also gives "smooth" frames.
5. Optionally record a `PerformanceObserver` for `long-animation-frame` to rule out JS.

A stall in the GPU process blocks the renderer's `requestAnimationFrame` too, so rAF intervals
are a good proxy for what the user sees. On a 120 Hz display, a clean run is ~180 frames in
1.5 s with max ~10.4 ms.

The scripts used for this memo were throwaway (not in the repo). The steps above are enough to
rebuild them in about 50 lines.

### 1.3 See which pipelines compile

Start a CDP trace right after `firstWindow()` (`page.context().newCDPSession(page)`,
`Tracing.start` with `transferMode: 'ReturnAsStream'`) with these categories:
`gpu, viz, cc, skia, disabled-by-default-skia.gpu, disabled-by-default-gpu.service, toplevel,
devtools.timeline`. Then:

- `createGraphicsPipeline` events carry `args.desc`, the pipeline key, for example
  `RP((BGRA8+D24_S8 x4->1).rgba w/ msaa load) + BitmapTextRenderStep[Mask] + SolidColor SrcOver`.
  List the ones created after the click: those are what the warm-up missed.
- `Scheduler::RunTask` slices on `CrGpuMain` longer than 40 ms are the stalls.
- A full cold startup creates about 56 pipelines.

### 1.4 Find which element needs a pipeline

Inject CSS at `firstWindow()` (`page.addStyleTag`) that turns one effect off, for example
`[data-testid="onboarding-skip"]{display:none!important}`. Then check whether the pipeline still
appears anywhere in the trace. Bisecting by effect (`filter`, `box-shadow`, `animation`) alone
did not work: each effect owns a few pipelines, and none owns most of them.

## 2. What each part of the switch needs

From the traces (key fragments of `desc`):

| Source | Pipelines |
| --- | --- |
| Card first raster (text, rounded rects, Lucide strokes) | MSAA passes `x4->1`: `BitmapText`, `AnalyticRRect`, `TessellateStrokes`, `TessellateWedges`, `InverseCover` |
| Focused input (border + ring, 150 ms transition) | the same, with `w/ msaa load` (partial re-raster), plus `AnalyticClip` |
| Caret inside the scaling card | `PerEdgeAAQuadRenderStep + SolidColor` (the caret is its own layer) |
| Leaving splash buttons, `filter: blur(0→4px)` | `$1DBlur4/8/12/16`, `$2DBlur12/28`, each with `HardwareImage` and `ImageShaderClamp` variants. Each blur radius range has its own kernel. |
| Logo `drop-shadow` while it glides | `R8` passes, `$1DBlur16 … AlphaOnly`, `BlendCompose[… AlphaOnlyPaintColor, SrcIn]` |
| Card scaling in (transformed, rounded) | `PerEdgeAAQuad + HardwareImage`, `AnalyticRRect + HardwareImage`, `AnalyticClip` |
| "Saltar" button starting to leave | `PerEdgeAAQuad + LocalMatrix[CoordNormalize[HardwareImage(0)]+PreAlpha] SrcOver` |

Pipelines are keyed by render-pass format too (`D16 x1` vs `D24_S8 x4` MSAA, `BGRA8` vs `R8`), so
the same shape inside a different kind of pass is a new pipeline.

## 3. The current design

### 3.1 Hidden window (`app.reveal`)

- `main/index.ts`: at `ready-to-show`, if `settings.onboardingCompleted` is false, the window gets
  `setOpacity(0)`, `setIgnoreMouseEvents(true)` and `showInactive()`. Chromium still draws an
  opacity-0 window, so the GPU compiles. A window that is hidden (`show: false`) does not draw.
- The renderer calls `app.reveal` (new `SaMethods` entry) when the warm-up is done. Main then sets
  opacity 1, restores mouse events and calls `show()`.
- Fallback: main reveals after 7 s whatever happens. Normal launches (onboarding complete) show at
  `ready-to-show` as before.
- The splash actions stay `invisible` (laid out, not drawn) until reveal, then remount, so their
  entrance plays when the window shows.

### 3.2 Rehearsal under the gradient

- `LiquidGradient` no longer creates its context with `alpha: false`. Every pixel the shader writes
  is opaque, so it looks the same, but the compositor no longer treats the canvas as opaque, and
  it still draws what is under it. With `alpha: false`, viz/cc skip occluded layers and nothing
  under the canvas compiles. The CSS fallback background is removed after the first WebGL frame
  for the same reason.
- The rehearsal sits at `-z-20` inside the onboarding root (under the canvas at `-z-10`). It is
  `inert` and `aria-hidden`, and it uses the real classes and components: `SplashButton`s with
  `animate-onboarding-splash-leave`, the logo glide (`animateGlide`, shared with the real FLIP),
  the real `OnboardingCard` for the voucher step, and the skip button.
- The rehearsal must be **drawn like the real UI**. An opacity-0.001 wrapper does not work: it puts
  everything in its own render pass with another format, so the pipelines differ.

### 3.3 16 staggered copies

- `REHEARSAL_COPIES = 16` copies, each offset on screen on a ring (200 × 150 px, whole pixels), so
  opaque cards do not fully cover each other (the compositor skips fully covered quads).
- Copy *i* starts `i × 62.5 ms` into the switch (`animation.currentTime += startAt` for every
  animation in its subtree, in a layout effect) and restarts on its own every 1 s. So at any
  moment the copies are 62.5 ms apart all around the switch.
- Done when `REHEARSAL_CALM_MS` = 125 ms pass with no frame over `STALL_MS` = 50 ms: every moment
  of the switch was drawn at least twice at real speed, with nothing new to compile. Limit: 5 s.
- Why it is faster: one frame asks for many pipelines at once and Dawn compiles them on worker
  threads in parallel. One copy compiled them about one at a time (cold: 5.6 s → 2.6 s). The
  short calm window cut the warm launch from 1.44 s to 0.44 s.

### 3.4 Details that each fixed one pipeline

- **Focused field:** the rehearsal card is inert, so it can't take focus. A wrapper sets
  `data-focus` a frame after mount, and the CSS gives its `label` the focused look
  (`border-accent ring-3 ring-ring/40`), so the 150 ms ring transition also runs.
- **Caret:** the real caret is a separate solid-colour layer, and drawing it scaled needs
  `PerEdgeAAQuad + SolidColor`. A fake caret did not make the same quad. Instead, the real card
  hides the caret (`[&_input]:caret-transparent`) until its entrance animation ends. That also
  stops the caret from wobbling.
- **"Saltar" button:** the real one is static for seconds, drawn as part of the page, and then
  starts `splash-leave`, which gives it its own layer mid-flight. A rehearsal copy that animates
  from mount, as a `<span>`, or after only 2 frames, made the pipeline only sometimes (a race).
  It works when the copy is a disabled `<button>` that stays still for 150 ms before the leave
  class is added.

## 4. What did not work

| Attempt | Result |
| --- | --- |
| `--disable-features=SkiaGraphite` (Ganesh) | Looked smooth, but **WebGL2 does not start** under Ganesh in this Electron: the gradient fell back to the static CSS gradient. The "smooth" numbers were fake, because no shader ran. |
| `--enable-skia-graphite-precompilation` | Little effect (~570 ms vs ~600 ms of stalls). Chromium's precompile list does not cover our mixes. |
| `--enable-features=SkiaGraphiteSmallPathAtlas` | No effect. |
| Static invisible copy of the card (opacity 0.001) | ~600 → ~280 ms. An opacity group draws in another pass format, and it misses all mid-animation states. |
| Copies held still mid-animation (constant WAAPI keyframes) | Better, but variants depend on exact compositor states (blur kernel per radius, AA on/off, raster scale) that held states do not match. |
| One rehearsal looping at 2× or 4× speed | Skips states. Stalls came back after reveal. |
| Turning off the leave blur alone, or the logo shadow alone | No single effect removes most of the cost. |
| Seeds for the "Saltar" AA quad (rotated layer, `scale(0.999)`, opacity/filter animations, fractional positions) | None made the exact pipeline. The fix was to copy how the real button behaves (§3.4). |
| `from { opacity: 0.99 }` on `splash-leave` | Did not remove the need for that pipeline. Reverted. |

## 5. Rules for future UI changes in the onboarding

- **Any new visual effect in the splash → card switch needs a matching part in the rehearsal.**
  New filters, shadows, clip shapes, blend modes, icons with strokes or a newly focused element can
  each need new pipelines. After a change, run the cold measurement (§1). If a frame after reveal
  is over 20 ms, trace it (§1.3), find the source (§1.4), and make the rehearsal draw it the same
  way (same element type, same layering, same "still first, then animated" sequence).
- Keep the rehearsal's structure equal to the real one. When you change the real markup (classes,
  wrappers, the skip button), change `RehearsalCopy` too.
- Don't set `alpha: false` on the gradient again, and don't put an opaque background behind the
  rehearsal inside the gradient element.
- Other screens (the card → data step, the exit to the app) are **not** warmed up. Their first run
  on a cold cache can still stall.

## 6. Tuning knobs

| Constant | Value | Effect |
| --- | --- | --- |
| `REHEARSAL_COPIES` | 16 | More copies: more parallel compiles and a shorter calm window, but more GPU work per frame. Measured: 1 copy (1 s calm loop) 1.44 s warm / 5.6 s cold; 4 copies 0.93 s / 2.6–3.1 s; 8 copies 0.94 s / 2.6–3.1 s; 16 copies 0.44 s / ~2.6 s. |
| `REHEARSAL_CALM_MS` | 2 steps (125 ms) | One step left about 1 cold launch in 6 with one stall. |
| `STALL_MS` | 50 ms | Frames over this count as compiling. On a GPU whose normal frames are slower than 50 ms, the warm-up never ends early and hits the limit. |
| `REHEARSAL_MAX_MS` | 5 s | Upper bound on the hidden time in the renderer. |
| `REVEAL_TIMEOUT_MS` (main) | 7 s | Shows the window if the renderer never calls `app.reveal`. |

## 7. Ideas to make the cold launch faster

The cold launch is still ~2.6 s, and the goal is lower. Ideas not yet tried:

1. **Start earlier.** The rehearsal starts after settings load, the onboarding mounts and 2
   frames. A rehearsal that starts in parallel with app startup could save some of that time
   (not measured; on a warm launch the whole wait before the rehearsal is about 150 ms).
2. **Fewer pipelines in the design.** Each removed effect saves its compiles: the blur on the
   leaving buttons (6–10 blur pipelines), the logo `drop-shadow` while it glides (R8 passes), the
   MSAA path rendering from Lucide stroke icons in the card (an image or a filled path might stay
   out of MSAA). This changes the design, so ask first.
3. **Warm up from the main process before the window exists.** For example, a hidden helper
   window with the same content right after `app.whenReady()`, while the main window loads. Not
   tested: a hidden window may not draw.
4. **Ship a warm cache.** Dawn's pipeline cache (`DawnGraphiteCache` in userData) and the macOS
   Metal cache are per machine and per binary. It is unclear whether Chromium can load a
   pre-built cache.
5. **Chromium flags.** Look for a Graphite/Dawn option that compiles pipelines asynchronously
   without blocking the frame (draw nothing until ready), or a newer Electron where precompilation
   covers more mixes. Check every flag with the gradient visible: under Ganesh, WebGL2 broke.
6. **Know when the cache is cold.** If a quick probe (a few frames of the rehearsal) shows no
   stall, reveal at once. Today's 125 ms calm window is already close to this on a warm cache.
7. **Measure other Macs.** Everything here is from one M3 Max. Slower GPUs compile slower, and on
   an Intel Mac the hidden time can reach the 5 s limit.
