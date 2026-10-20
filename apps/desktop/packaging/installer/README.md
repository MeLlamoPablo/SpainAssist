# macOS installer artwork

Framer source: **Installer · macOS**, branch **macOS installer redesign**.
The supplied `shader.png` is the user's exported “Background Shader@3x.png”.

- `dmg.html` reproduces screen 01 without Finder's title bar, app icon or filename.
  Finder supplies the real draggable/openable app at (360, 260), with a 112 pt icon.
- `progress.html` reproduces screen 04 beneath the native title bar. It has an
  indeterminate CSS animation and respects reduced motion.
- `background.tiff` contains 1× and 2× representations at 720 × 442 pt. `background.png`
  is its 1× preview. Only the TIFF goes into the DMG.
- `serif.ttf`, `inter.woff2` and `icon.png` are generated copies of existing app assets,
  also shipped with the preparation window so no network or vault is needed.

Rebuild artwork on macOS with cached Chromium:

```sh
corepack pnpm --filter @sa/desktop design:installer
```

Opening a packaged app outside Applications starts the preparation window and calls
Electron's native bundle mover without an extra install confirmation. Successful copying
quits the source and relaunches the installed app. A private one-shot record identifies
the original DMG by mount, exact signed-build resource manifest, file identity and size.
The installed instance ejects the source and moves that exact DMG to Trash automatically.
Cleanup failure is nonblocking and never deletes a guessed filename. There is no
cleanup preference or completion screen. Development, tests and other platforms skip it.

The native mover handles authorization and existing installations. Gatekeeper and Files
& Folders prompts remain under macOS control; they are not app artwork. If an installed
instance already holds the single-instance lock, the existing app receives focus.

Tests inject all install, eject and Trash operations. A real downloaded, quarantined,
signed release still needs a manual macOS check for native prompts and translocation;
unit tests do not copy anything into the real Applications folder or trash downloads.
