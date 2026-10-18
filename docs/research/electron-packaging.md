## 6. Packaging and distribution (post-MVP, but decide now)

_Checked 2026-10-03. Versions: electron 44.5.1 (Chromium 152.0.7977.54, Node 24.18.1, see the [release notes](https://github.com/electron/electron/releases/tag/v44.5.1)); electron-vite 5.0.0 (6.0.0-beta.5 is on the `beta` tag); electron-builder: npm `latest` is 26.15.3, but **26.17.0 is on the `v26` dist-tag** (2026-09-26) and 27.0.0-alpha.9 is on `next`; @electron-forge/cli 8.0.1; @electron/fuses 2.1.3; @electron/rebuild 4.2.0; playwright(-core) 1.63.0 (Chrome for Testing 153.0.8010.12, rev 1243); pnpm 10.34.6 (the newest 10.x; pnpm 11 and 12 also exist, and `latest` is 12.8.1). "Verified" means I read it in source or docs, or reproduced it in a scratch experiment (see 6.10). Anything I couldn't check is marked UNVERIFIED._

### 6.0 Recommendations
- **Use electron-builder, pinned exactly to `26.17.0`**, not Forge (see 6.3). A caret range won't pick it up: pnpm 10.34.6 and npm both resolve `^26.15.3` to **26.15.3**, because the `latest` tag satisfies the range (verified). We need the pnpm/monorepo fixes in 26.15.6–26.17.0 (see 6.2).
- **Keep pnpm's default isolated `node_modules`.** Don't add `node-linker=hoisted` or `shamefully-hoist`.
- **Let electron-vite bundle every `@sa/*` workspace package** by listing them in `apps/desktop` `devDependencies`. They export raw `./src/index.ts`, and Node "refuses to handle TypeScript files inside folders under a `node_modules` path" ([Node docs](https://nodejs.org/api/typescript.html)). Only real runtime dependencies go in `apps/desktop` `dependencies`: pi, playwright-core and any native addons.
- **Run the agent harness with `utilityProcess.fork`.** That lets us turn the `runAsNode` fuse off. Set fuses with electron-builder's `electronFuses` (6.7).
- **Don't bundle a second Chromium in the first signed release.** Drive Electron's own Chromium, or download Playwright's browser on first run. If we do bundle it, prefer `chrome-headless-shell` and test macOS signing early (6.5).
- **Ship no JRE.** AutoFirma is reimplemented in TypeScript (`@sa/signer`, DECISIONS D4), so nothing in the app runs Java. Native helpers, such as the built `sa-sidecar` certificate-login helper (`docs/research/dnie.md`), go in `extraResources` and are signed like any nested code (6.5, 6.6).
- **CI: one native runner per OS, and per macOS arch.** Build separate arm64 and x64 DMGs; a universal build would double native helpers and any bundled browser. Pass `--publish never`.
- **Electron ≥42: run `install-electron` before `electron-vite dev`/`preview` and before E2E tests** (6.1).

### 6.1 Electron ≥42 has no `postinstall`: what changes for pnpm 10, dev and CI
- **What changed.** Electron 42 breaking change: "`electron` no longer downloads itself via `postinstall` script". Electron now downloads its binary "the first time that its main `bin` script is run (e.g. via `npx electron`)". A new `install-electron` script "contains the exact same code from the former `postinstall` script" (`npx install-electron --no`). Cross-platform installs use the `ELECTRON_INSTALL_PLATFORM` / `ELECTRON_INSTALL_ARCH` env vars. `ELECTRON_SKIP_BINARY_DOWNLOAD` is no longer supported ([breaking changes 42.0](https://www.electronjs.org/docs/latest/breaking-changes); [RFC #22](https://github.com/electron/rfcs/pull/22)).
- **Verified in the `electron@44.5.1` tarball:** there is no `scripts` field. The bins are `electron` and `install-electron`. `require('electron')` (index.js) runs `install.js` synchronously when `dist/` or `path.txt` is missing.
- **pnpm 10.** There is nothing left to approve for `electron`, so the `electron` entry in our `onlyBuiltDependencies` is a no-op. pnpm 10.34.6 doesn't flag it. `pnpm install` no longer fetches the binary.
- **electron-vite gotcha.** `dev` and `preview` find Electron by reading `node_modules/electron/path.txt` directly. If the file is missing they throw `Error: Electron uninstall`. They never call `require('electron')`, so the lazy download never runs (verified in the electron-vite 5.0.0 and 6.0.0-beta.5 `getElectronPath()`; [electron-vite#904](https://github.com/alex8088/electron-vite/issues/904) is still open). `electron-vite build` only needs the binary when `build.bytecode` is on. The fix, without adding an install hook back:
  ```jsonc
  // apps/desktop/package.json — install.js exits immediately when already installed
  "scripts": { "dev": "install-electron && electron-vite dev", "preview": "install-electron && electron-vite preview" }
  ```
- **CI.** electron-builder never uses `node_modules/electron/dist`; it downloads `electron-v44.5.1-<platform>-<arch>.zip` itself through @electron/get. Packaging jobs therefore need no install step.
  - Cache `~/Library/Caches/electron` and `~/Library/Caches/electron-builder`. On Linux these are under `~/.cache/`; on Windows `%LOCALAPPDATA%\electron[-builder]\Cache`. `ELECTRON_BUILDER_CACHE` overrides the builder cache.
  - E2E jobs that use `_electron.launch` should run `pnpm --filter @sa/desktop exec install-electron` first.

### 6.2 electron-builder 26 with a pnpm workspace
- **Hoisting is no longer needed.**
  - **Since 26.0.4:** electron-builder runs `pnpm list --prod --json --depth Infinity`, builds the production graph, hoists it and copies the real package directories into `app.asar/node_modules` ([#8571](https://github.com/electron-userland/electron-builder/pull/8571)). That same commit deleted the README's "Note for PNPM", which used to require `node-linker=hoisted`, `public-hoist-pattern=*` or `shamefully-hoist=true`.
  - **Collector:** `PnpmNodeModulesCollector` handles the isolated virtual store, `nodeLinker: hoisted`, and pnpm 11 output.
  - **Key fixes** ([releases](https://github.com/electron-userland/electron-builder/releases)):
    - 26.9.1 #9698: version→path resolution in the `.pnpm` store
    - 26.10.0 #9720: pnpm 11 support
    - **26.15.6 #9950:** deps of a workspace sub-package
    - **26.16.0 #10074:** adds `allowMissingDependencies`
    - **26.17.0:** #10189, #10207, #10213, #10230. #10189 fixes Windows workspace-root detection. Before it, transitive native modules in `.pnpm` were rebuilt for the host arch only ([#10188](https://github.com/electron-userland/electron-builder/pull/10188)).
- **Reproduced** with 26.17.0 and pnpm 10.34.6 (isolated, no `.npmrc`). The app was a workspace sub-package depending on `workspace:*` plus a registry package. `app.asar` contained a flat `node_modules` with real files, including the transitive deps of the workspace package. No devDependencies were included, and `ElectronAsarIntegrity` was written to Info.plist.
- **v26 pitfalls (all verified):**
  - **An app with zero production `dependencies`** (everything bundled) makes electron-builder fall back to the workspace root and bundle the root's `dependencies` ([#10033](https://github.com/electron-userland/electron-builder/issues/10033); fixed only in 27.0.0-alpha.7, #10035). Our root package.json has only devDependencies, so nothing leaks today. Keep it that way.
  - **The node_modules copier strips files.** It always drops `CHANGELOG.md`/`ChangeLog`, `binding.gyp` and `.npmignore` anywhere in a package. At a package's top level it also drops `README*`, `test(s)`, `__tests__`, `example(s)` and `.bin`. The `onNodeModuleFile` hook can force-include the top-level items, but not CHANGELOG. This matters for pi (6.9).
  - **v27 is coming:** ESM, `asar` and `nativeModules` options regrouped, no implicit publishing. It ships a `migrate-schema` CLI ([27.0.0-alpha.0](https://github.com/electron-userland/electron-builder/releases/tag/electron-builder%4027.0.0-alpha.0)).
- **What each option does** ([contents](https://www.electron.build/contents), [configuration](https://www.electron.build/configuration); the v26 docs live in `website/docs` on branch `release/v26`):
  - **`directories.app`:** the directory holding the app package.json. It defaults to `app/`, then `www/`, then the project dir; leave it unset. `directories.output` defaults to `dist` and `buildResources` to `build` (not packed).
  - **`files`:** globs relative to the app dir. **If any pattern is positive, the default `**/*` is not prepended**, which gives you an allow-list. `package.json` and production `node_modules` are always added; devDependencies never are.
  - **`asar`** (default true) and **`asarUnpack`** (copied to `app.asar.unpacked/`). Reads are redirected transparently; `spawn` and `cwd` are not. **`asar.smartUnpack`** (default) unpacks the whole package around any `.node/.dll/.exe/.dylib/.so` or extensionless binary (verified in `unpackDetector`).
  - **`extraResources`** goes to `Contents/Resources` (mac) or `resources/` (win/linux). **`extraFiles`** goes to `Contents/` or the install root. `from` is relative to the project dir and `to` to the target. Macros: `${os}` (mac|win|linux), `${arch}`, `${platform}`. Neither is in the asar.
- **What electron-vite's docs say** ([distribution](https://electron-vite.org/guide/distribution), [entry point](https://electron-vite.org/guide/#electron-entry-point), [dependency handling](https://electron-vite.org/guide/dependency-handling)):
  - The app package.json needs `"main": "./out/main/index.js"`, and electron-builder is the recommended packager.
  - `build.externalizeDeps` is on by default and externalizes exactly `Object.keys(<app>/package.json#dependencies)` plus their subpaths (verified in source). It only looks at the *app's* dependencies, so third-party runtime deps of bundled workspace packages (pi in `@sa/agent`, playwright-core in `@sa/browser`) must be repeated in `apps/desktop` `dependencies`. Otherwise they get bundled.
  - The electron-vite troubleshooting page and the scaffolder still write `shamefully-hoist=true` and `pnpm.onlyBuiltDependencies: [electron, esbuild]` ([create-electron/index.js](https://github.com/alex8088/quick-start/blob/master/packages/create-electron/index.js)). Both predate the v26 collector and Electron 42.
- **Template, relevant parts (condensed; comments are mine)** ([quick-start react-ts electron-builder.yml](https://github.com/alex8088/quick-start/blob/master/packages/create-electron/template/react-ts/electron-builder.yml)). The template package.json has `"main": "./out/main/index.js"`, `"postinstall": "electron-builder install-app-deps"`, and electron-builder `^26.0.12`.
  ```yaml
  appId: com.electron.app
  directories:
    buildResources: build
  files:
    - '!**/.vscode/*'
    - '!src/*'
    - '!electron.vite.config.{js,ts,mjs,cjs}'
    - '!{.eslintcache,eslint.config.mjs,.prettierignore,.prettierrc.yaml,dev-app-update.yml,CHANGELOG.md,README.md}'
    - '!{.env,.env.*,.npmrc,pnpm-lock.yaml}'
    - '!{tsconfig.json,tsconfig.node.json,tsconfig.web.json}'
  asarUnpack:
    - 'resources/**'
  mac:
    entitlementsInherit: build/entitlements.mac.plist   # allow-jit, allow-unsigned-executable-memory, allow-dyld-environment-variables
    extendInfo:
      - NSCameraUsageDescription: Application requests access to the device's camera.   # list form: BROKEN, see 6.6
    notarize: false
  linux:
    target: [AppImage, snap, deb]
  npmRebuild: false
  publish: { provider: generic, url: https://example.com/auto-updates }
  ```
- **Proposed `apps/desktop/package.json` (excerpt).** Avoid `catalog:` for `electron-updater` on v26; the fix for that, #10019, is in 27 only.
  ```jsonc
  {
    "name": "@sa/desktop", "private": true, "type": "module",
    "main": "./out/main/index.js",
    "dependencies": {                                  // externalized by electron-vite, collected by electron-builder
      "@earendil-works/pi-coding-agent": "^1.0.0",
      "@earendil-works/pi-ai": "^1.0.0",
      "playwright-core": "1.63.0"                       // exact: the browser revision is tied to this version
    },
    "devDependencies": {                               // bundled by electron-vite
      "@sa/agent": "workspace:*", "@sa/browser": "workspace:*", "@sa/shared": "workspace:*",
      "@sa/signer": "workspace:*", "@sa/vault": "workspace:*",
      "electron": "44.5.1", "electron-builder": "26.17.0", "electron-vite": "5.0.0"
    }
  }
  ```
- **Proposed `apps/desktop/electron-builder.yml`.** The `mac`, `win` and `linux` blocks are in 6.6 and `electronFuses` in 6.7.
  ```yaml
  appId: es.spainassist.desktop   # placeholder
  productName: SpainAssist
  directories: { buildResources: build, output: dist }
  files:                         # allow-list
    - out/**
    - "!out/**/*.map"
  asar: true
  asarUnpack: ["**/*.node"]      # smartUnpack already does this; explicit is harmless
  extraResources:
    - { from: "vendor/${os}-${arch}", to: vendor }   # native helpers (+ ms-playwright/ if bundled), staged per runner
  npmRebuild: true               # default: rebuild native prod deps for the target Electron/arch
  allowMissingDependencies: false   # 26.16+: fail instead of warning when a prod dep can't be collected
  toolsets: { appimage: "1.0.3" }
  ```
- **CI build command:** `pnpm --filter @sa/desktop exec electron-vite build && pnpm --filter @sa/desktop exec electron-builder --mac --arm64 --publish never`. Then check the result with `npx @electron/asar list <...>/app.asar`.

### 6.3 Electron Forge 8
- **Forge 8.0.1** (2026-09-29) moves to Node 22 and ESM and renames `publish` to `release`. Its Vite plugin "graduate[d] from experimental", uses Vite 8 and outputs `.vite/build/main.cjs` ([release notes](https://github.com/electron/forge/releases/tag/v8.0.1)).
- **pnpm still requires hoisting.** The docs, now in the electron/forge repo, still say: "Forge crawls your project's `node_modules` folder… doesn't take into account symlinked dependencies… If you are using pnpm, please set `node-linker=hoisted`" ([docs/index.md](https://github.com/electron/forge/blob/main/docs/index.md), [electronforge.io](https://www.electronforge.io/)). In our workspace that setting is workspace-wide (6.8), and pnpm 11 only reads it from `pnpm-workspace.yaml`.
- **Forge only integrates with its own `@electron-forge/plugin-vite`.** electron-vite documents a packaging-only combination: `electron-vite build --outDir=dist && electron-forge package`, because Forge's `out/` collides with electron-vite's `out/`. That recipe was written against Forge 6 and is UNVERIFIED on Forge 8.
- **Recommendation: electron-builder.** It supports isolated pnpm, is first-class in electron-vite's docs and template, and has built-in fuses, Azure signing and AppImage/deb/rpm/flatpak targets.

### 6.4 Native modules
- **Prefer pure JS/WASM or Node-API prebuilds.** Node-API is ABI-stable, so no Electron rebuild is needed:
  - prebuildify (`prebuilds/<plat>-<arch>/node.napi.node` via node-gyp-build): @electron/rebuild detects these and skips them (`src/module-type/prebuildify.ts`).
  - napi-rs per-platform packages: they have no `binding.gyp`, so there is nothing to rebuild.
- **node-gyp/NAN addons** are rebuilt by electron-builder for the target Electron version and arch before packing.
  - Relevant settings: `npmRebuild: true` (default); `nativeRebuilder: sequential`, which is @electron/rebuild ^4; `buildDependenciesFromSource: false`, which tries prebuild-install Electron prebuilds first; `nodeGypRebuild: false`, which only applies to the app's own binding.gyp.
  - For `electron-vite dev`, add `"postinstall": "electron-builder install-app-deps"` (pnpm 10 still runs *project* scripts) or run @electron/rebuild.
  - @electron/rebuild follows pnpm symlinks via `realpath`.
- **Keep `npmRebuild` on** if there are native deps. The template sets `npmRebuild: false`, which ships host-arch binaries when cross-packaging. Cross-arch packaging on one machine also needs pnpm `supportedArchitectures`; native runners are simpler.
- **pnpm 10 blocks the addon's own install script** unless it is allowed. Electron doesn't need it, but plain-Node tests (vitest) that load the addon do; add `allowBuilds: { <addon>: true }` for those (UNVERIFIED per addon).
- **Electron 45** (not 44) will make file descriptors for files inside ASAR non-real (`EBADF` for native code that reads them; [breaking changes](https://www.electronjs.org/docs/latest/breaking-changes)). Keep files that native code reads outside the asar.

### 6.5 Extra binaries: native helpers and Playwright's browser

The desktop loads `sa-sidecar` from `apps/desktop/vendor/<platform>-<arch>` in dev, and from
`process.resourcesPath/vendor` when packaged (`sa-sidecar.exe` on Windows). Both paths come from
`sidecarBinaryPath` in `@sa/sidecar`. Packaging builds the target's binary and copies it there
(6.11). The sketch below uses `${os}` folder names; the built layout uses `<platform>-<arch>`
(`darwin-arm64`).

**Paths and permissions**
```ts
import { app } from 'electron'
import { join } from 'node:path'
const OS = ({ darwin: 'mac', win32: 'win', linux: 'linux' } as const)[process.platform as 'darwin' | 'win32' | 'linux']
export const vendorDir = app.isPackaged
  ? join(process.resourcesPath, 'vendor')                      // .app/Contents/Resources/vendor | <install>/resources/vendor
  : join(app.getAppPath(), 'vendor', `${OS}-${process.arch}`)  // dev: getAppPath() = apps/desktop
export const helperBin = (name: string) => join(vendorDir, process.platform === 'win32' ? `${name}.exe` : name)
// execFile(helperBin('…'), […], { cwd: app.getPath('userData') })
```
- **Only spawn real paths.** From inside the asar only `execFile` works, and `cwd` can't point into an archive ([ASAR limitations](https://www.electronjs.org/docs/latest/tutorial/asar-archives)). electron-vite's `?asset&asarUnpack` rewrites paths to `app.asar.unpacked` for you.
- **Exec bits.** electron-builder's copier keeps the owner-exec bit, adds group/other exec and strips setuid (verified in builder-util). The source files must already be `+x`. Zip artifacts passed between CI jobs may lose modes (UNVERIFIED for any specific CI), so use tar or `chmod` in `beforePack`.
- **AppImage:** `resourcesPath` is a read-only mount whose path changes on every launch.

*An earlier version of this memo planned a `jlink` JRE for AutoFirma (measured: 56 MB, 30 Mach-O files to sign). It was dropped: the app reimplements AutoFirma in TypeScript.*

- **macOS signing.** electron-builder (via @electron/osx-sign) signs every binary under `Contents/`, deepest first. All nested code gets `entitlementsInherit`; per-file entitlements are only possible with a custom `mac.sign` (verified in `MacTargetHelper` and osx-sign).
  - **Third-party libraries:** a helper that loads PKCS#11 smart-card/DNIe drivers signed by other teams needs `disable-library-validation` under the hardened runtime (UNVERIFIED for the DNIe drivers; see `docs/research/dnie.md`).
  - **Placement.** Apple puts helper tools in `Contents/Helpers|MacOS` and dylibs in `Contents/Frameworks`, and warns that misplaced code "might cause problems during notarization" ([Placing content in a bundle](https://developer.apple.com/documentation/bundleresources/placing-content-in-a-bundle)). `Contents/Resources/vendor` via `extraResources` is the pragmatic spot for helpers; electron-builder's docs recommend it for binaries. Validate early with `codesign --verify --deep --strict -vv`, `spctl -a -vvv -t exec` and a real `notarytool` submission (UNVERIFIED that it passes).
- **Windows.** `.exe` files copied through `extraResources` are signed automatically. DLLs are signed only if you add `win.signExts: [".dll"]` (verified in `winPackager`).

**Playwright's browser**
- **Which build it uses.** Since 1.57, headed mode uses **Chrome for Testing** and headless mode uses **chrome-headless-shell** ([release notes](https://playwright.dev/docs/release-notes#version-157)).
- **Install controls** ([browsers](https://playwright.dev/docs/browsers)):
  - `npx playwright install chromium --only-shell` installs only the headless shell; `--no-shell` installs only CfT.
  - `PLAYWRIGHT_BROWSERS_PATH=<dir>` picks the directory; `=0` installs into `node_modules/playwright-core/.local-browsers`.
  - playwright-core reads that env var when its registry initializes. Set it in the utility process's `fork` env, or pass `chromium.launch({ executablePath })`. For non-bundled browsers the docs say "use at your own risk"; the matching revision is fine.
- **Layout for rev 1243:**
  - `chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
  - `chromium-1243/chrome-win64/chrome.exe` and `chromium-1243/chrome-linux64/chrome`
  - `chromium_headless_shell-1243/chrome-headless-shell-{mac-arm64|mac-x64|win64|linux64}/chrome-headless-shell[.exe]`
- **Sizes** for CfT 153.0.8010.12, read from the CDN zips' central directories:

  | | mac-arm64 | mac-x64 | win64 | linux64 |
  |---|---|---|---|---|
  | `chromium` (CfT), zip / unpacked | 182 / 358 MiB | 192 / 369 | 196 / 432 | 187 / 391 |
  | `chromium-headless-shell`, zip / unpacked | 94 / 195 MiB | 99 / 199 | 115 / 270 | 114 / 260 |
- **Don't package with `PLAYWRIGHT_BROWSERS_PATH=0`.** The browser lands in node_modules, i.e. inside the asar. electron-builder's built-in mac sign-ignore list covers `node_modules/playwright/.local-browsers` and `puppeteer/.local-chromium`, but not `playwright-core`. Anything ignored stays unsigned, and notarization fails. Instead, stage the browser into `vendor/${os}-${arch}/ms-playwright` and ship it via `extraResources`. There is an undocumented `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE` for cross-downloading (UNVERIFIED).
- **macOS signing of CfT.**
  - The CfT zip contains **no `_CodeSignature` directories** (verified), so it isn't a sealed Developer-ID bundle. We would have to sign every Mach-O ourselves: a 235 MB framework, 8 helper apps, crashpad and dylibs. osx-sign would do this, and electron-builder's copier preserves the framework's 5 symlinks.
  - Bundled browsers have failed to sign before: [#2010](https://github.com/electron-userland/electron-builder/issues/2010) (Puppeteer: "code object is not signed") and [#5383](https://github.com/electron-userland/electron-builder/issues/5383) (Playwright). That's why the ignore list exists.
  - Whether CfT 153 runs and notarizes after re-signing is **UNVERIFIED; spike it before committing.** The headless shell on mac is one Mach-O plus 4 dylibs with no nested bundle, which is much easier.
  - `mac.binaries` only matters for files outside the bundle walk. `signIgnore` leaves files unsigned, so notarization rejects the app.
- **Option A, Electron's own Chromium over a CDP port.** Call `app.commandLine.appendSwitch('remote-debugging-port','0')` before `ready`, then `chromium.connectOverCDP()` from the harness.
  - **Pros:** no extra MB and one signing story. The user sees a real `BrowserWindow`/`WebContentsView` for logins they must do themselves (Cl@ve, client-certificate choice via `select-client-certificate`; in 44.0 `webContents` can be null there). It runs the same Chromium 152 as the app.
  - **Cons:** CDP on localhost has no authentication, so any local process can drive *every* window, including our privileged UI. Playwright sees a single BrowserContext even with `session.fromPartition` ([#34815](https://github.com/microsoft/playwright/issues/34815)), so there's no `newContext()`, per-context tracing or `clientCertificates`. The docs call it "significantly lower fidelity" ([connectOverCDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)). The UA contains `Electron/44`. Port discovery via `DevToolsActivePort` is UNVERIFIED for Electron.
- **Option B, `webContents.debugger`** ([docs](https://www.electronjs.org/docs/latest/api/debugger)). This is in-process CDP per WebContents with no port, but there is no Playwright API; we'd write our own CDP layer.
- **Option C, download the browser on first run** into userData. This avoids installer bloat and signing work, but needs network on first use, and the downloaded binary sits outside our signed bundle. How Gatekeeper treats Node-downloaded files is UNVERIFIED.
- **Pick:** A or B for interactive government sessions, C or a bundled headless shell for background jobs, and full CfT bundling only as a last resort.
- **Sandbox note:** Playwright launches with `chromiumSandbox: false` by default.

### 6.6 Signing, notarization and Linux targets
**macOS**
- **Defaults.** `hardenedRuntime` defaults to true. `entitlements` falls back to `build/entitlements.mac.plist`, then a built-in template. `entitlementsInherit` falls back to `build/entitlements.mac.inherit.plist`, then the same template, which has `allow-jit`, `allow-unsigned-executable-memory` and `disable-library-validation`. The inherit file applies to **every nested binary** (verified).
- **Camera.** It needs three things: the `com.apple.security.device.camera` entitlement, `NSCameraUsageDescription` in Info.plist, and a call to `systemPreferences.askForMediaAccess('camera')`. **`extendInfo` must be a map.** The template's YAML list produces Info.plist keys `"0"`, `"1"` and `"length"` instead (verified on 26.17.0).
  - **Dev launch attribution (verified 2026-10-04).** Starting Electron as a terminal child can
    attribute TCC requests to the terminal. Local tccd logs showed Otty missing the camera
    entitlement and returning false with permission still not-determined. Starting the same
    Electron bundle with `open -n -a` gave Electron its own identity and granted access. Dev and
    preview now use Launch Services, with a private socket for environment transfer and explicit
    native PID tracking for shutdown/rebuilds. Real webcam acquisition and watching were verified.

- **Notarization.** Leave `mac.notarize` unset; it runs whenever the env vars are present.
  - Precedence: Apple ID trio, then API-key trio, then keychain profile (verified).
  - **`APPLE_API_KEY` must be a *file path* to the `.p8`.** It is passed straight to `notarytool --key`; @electron/notarize documents it as "File system path to the .p8". The v26 notarization page shows a base64 value; that conflicts with the code.
  - Also set `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. The signing certificate goes in `CSC_LINK` and `CSC_KEY_PASSWORD`. Stapling is automatic.
- **Platform floor.** Electron 44 requires macOS 13+ and ships 64-bit builds only.
```yaml
mac:
  category: public.app-category.productivity
  target: [{ target: dmg, arch: [arm64, x64] }, { target: zip, arch: [arm64, x64] }]  # zip needed for Squirrel.Mac updates
  hardenedRuntime: true
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.inherit.plist
  extendInfo:
    NSCameraUsageDescription: "SpainAssist usa la cámara para …"
```
```bash
echo "$APPLE_API_KEY_P8_B64" | base64 --decode > "$RUNNER_TEMP/AuthKey.p8"
export APPLE_API_KEY="$RUNNER_TEMP/AuthKey.p8" APPLE_API_KEY_ID=… APPLE_API_ISSUER=… CSC_LINK=… CSC_KEY_PASSWORD=…
```
`build/entitlements.mac.plist` (main app). Add `disable-library-validation` only if the main process loads dylibs signed by another team.
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.device.camera</key><true/>
</dict>
</plist>
```
`build/entitlements.mac.inherit.plist` covers all nested code: Electron helpers, native helpers and any bundled browser. Whether the helpers need the camera key is UNVERIFIED.
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
  <key>com.apple.security.device.camera</key><true/>
</dict>
</plist>
```
**Windows**
- **Configuration.** `win.azureSignOptions` (Azure **Artifact Signing**, formerly Trusted Signing) is built in.
  - Required fields: `publisherName` (the certificate CN), `endpoint`, `certificateProfileName` and `codeSigningAccountName`.
  - Optional fields: `fileDigest`, `timestampRfc3161` and `timestampDigest`. Any extra keys are passed through to `Invoke-TrustedSigning`.
  - It can't be combined with `win.signtoolOptions`, which is where v26 moved the pfx and `sign` options.
- **Runner.** electron-builder installs the `TrustedSigning` PowerShell module (≥0.5.0) and calls `Invoke-TrustedSigning`, so plan on a Windows runner. Whether it works under `pwsh` on macOS/Linux is UNVERIFIED. For macOS/Linux, the Electron docs suggest `jsign` behind a custom `sign` hook.
- **Auth.** Use `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` ([code-signing-win](https://www.electron.build/code-signing-win), [Electron code-signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)).
- **Eligibility** for Public Trust certificates: **organizations** in the EU (Spain qualifies), US, CA, UK and others. **Individual developers must be in the US or Canada** ([Microsoft quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)).
```yaml
win:
  target: [{ target: nsis, arch: [x64] }]
  signExts: [".dll"]           # optional: also sign helper/browser DLLs
  azureSignOptions:
    publisherName: "Example S.L."
    endpoint: https://weu.codesigning.azure.net   # or https://neu.codesigning.azure.net
    codeSigningAccountName: example-signing
    certificateProfileName: example-public
```
**Linux**
- **AppImage:** set `toolsets.appimage: "1.0.3"`. It is a static runtime with no libfuse2 dependency, and AppRun only adds `--no-sandbox` when user namespaces are unavailable; it becomes the default in v27. The current default, `0.0.0`, is the deprecated FUSE2 runtime ([appimage](https://www.electron.build/appimage)).
- **deb/rpm:** the after-install script installs an AppArmor profile granting `userns` on Ubuntu 24+. It sets `chrome-sandbox` SUID only when user namespaces are unavailable (verified). Use `deb.appArmorProfile` to override.
- **flatpak:** only single-file bundles are supported, and the build host needs `flatpak` and `flatpak-builder`. Set `runtimeVersion: "24.08"`; the schema default is still `20.08`. DNIe readers probably need `--socket=pcsc` (UNVERIFIED).
- **snap:** skip it.
- **Signing:** there is no code signing on Linux; publish checksums.
```yaml
toolsets: { appimage: "1.0.3" }
linux: { target: [AppImage, deb, rpm], category: Office, maintainer: "…" }
```

### 6.7 Electron fuses
- **The key is `electronFuses`** (verified in the 26.15.3 and 26.17.0 schemas; [tutorial](https://www.electron.build/tutorials/adding-electron-fuses)). Fields: `runAsNode`, `enableCookieEncryption`, `enableNodeOptionsEnvironmentVariable`, `enableNodeCliInspectArguments`, `enableEmbeddedAsarIntegrityValidation`, `onlyLoadAppFromAsar`, `loadBrowserProcessSpecificV8Snapshot`, `grantFileProtocolExtraPrivileges`, `resetAdHocDarwinSignature`.
- **Order of operations:** the `afterPack` hook runs, then fuses are flipped, then the app is signed (verified in `platformPackager`).
- **What it can't do:** it has no `wasmTrapHandlers` key, because it bundles @electron/fuses ^1.8.0. If you want `wasmTrapHandlers` or `strictlyRequireAllFuses`, use an `afterPack` hook with @electron/fuses 2.1.3, which is ESM-only and needs Node ≥22.12.
```yaml
electronFuses:
  runAsNode: false
  enableCookieEncryption: true
  enableNodeOptionsEnvironmentVariable: false
  enableNodeCliInspectArguments: false
  enableEmbeddedAsarIntegrityValidation: true
  onlyLoadAppFromAsar: true
  loadBrowserProcessSpecificV8Snapshot: false
  grantFileProtocolExtraPrivileges: false   # only after the renderer is served from a custom protocol (see below)
```
```js
// build/after-pack.mjs: use instead of `electronFuses` (config: afterPack: build/after-pack.mjs)
import path from 'node:path'
import { flipFuses, FuseVersion, FuseV1Options as F } from '@electron/fuses'
export default async function afterPack({ appOutDir, electronPlatformName: p, packager }) {
  const name = p === 'linux' ? packager.executableName : packager.appInfo.productFilename
  await flipFuses(path.join(appOutDir, name + ({ darwin: '.app', mas: '.app', win32: '.exe' }[p] ?? '')), {
    version: FuseVersion.V1, strictlyRequireAllFuses: true, resetAdHocDarwinSignature: p === 'darwin',
    [F.RunAsNode]: false, [F.EnableCookieEncryption]: true, [F.EnableNodeOptionsEnvironmentVariable]: false,
    [F.EnableNodeCliInspectArguments]: false, [F.EnableEmbeddedAsarIntegrityValidation]: true,
    [F.OnlyLoadAppFromAsar]: true, [F.LoadBrowserProcessSpecificV8Snapshot]: false,
    [F.GrantFileProtocolExtraPrivileges]: false, [F.WasmTrapHandlers]: true,
  })
}
```
Check the result with `npx @electron/fuses read --app <path>.app`. Consequences, per the [Electron fuses doc](https://www.electronjs.org/docs/latest/tutorial/fuses) unless noted:
- **`runAsNode: false`.** "With this fuse disabled, `child_process.fork` throws." `spawn(process.execPath, …)` with `ELECTRON_RUN_AS_NODE` no longer gives you Node. Use `utilityProcess.fork`; in electron-vite that's `import entry from './agent-host?modulePath'`. Audit dependencies that fork or need a `node` binary. electron-vite's `build.bytecode` is unaffected because it runs at build time with the dev binary.
- **`enableNodeOptionsEnvironmentVariable: false`** also disables `NODE_EXTRA_CA_CERTS`. Behind corporate TLS proxies, use Electron's `net.fetch`, which uses the system trust store.
- **`enableNodeCliInspectArguments: false`.** Playwright's `_electron.launch()` always passes `--inspect=0` (verified in 1.63). Run E2E against unfused builds and smoke-test the fused artifact separately. The exact failure mode is UNVERIFIED.
- **`enableEmbeddedAsarIntegrityValidation`** works on macOS and on Windows from Electron 30. electron-builder writes `ElectronAsarIntegrity` and the Windows `INTEGRITY/ElectronAsar` resource automatically (verified). It only covers `app.asar`. That `app.asar.unpacked` and `extraResources` are not covered is UNVERIFIED; on macOS the code signature seals them.
- **`enableCookieEncryption`** is one-way. On macOS it needs a stable signature for Keychain access, same as `safeStorage` ([code-signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)). Use the async `safeStorage` APIs now; the sync ones are deprecated in 45 and removed in 46.
- **`grantFileProtocolExtraPrivileges: false`.** The template uses `loadFile()`, which is `file://`. Switch to `protocol.handle('app', …)` with a privileged standard/secure scheme first. Otherwise Vite's module scripts over `file://` will likely break (UNVERIFIED).
- **No fuse blocks Chromium's `--remote-debugging-port`.** Unless we use CDP ourselves (6.5 option A), consider refusing to start in packaged builds when it is present (UNVERIFIED practice).

### 6.8 pnpm workspace config
```yaml
# pnpm-workspace.yaml
packages: ["apps/*", "packages/*", "services/*", "tools/*", "e2e"]
# nodeLinker: keep the default (isolated); a per-package override is not possible
allowBuilds:                   # pnpm ≥10.26; replaces onlyBuiltDependencies/ignoredBuiltDependencies (both removed in pnpm 11)
  esbuild: true                # optional; the binary comes from the @esbuild/* optional deps anyway
  electron-winstaller: false   # pulled in via electron-builder's Squirrel peer; only needed for Squirrel.Windows
  # electron is no longer needed (Electron ≥42 has no install script)
strictDepBuilds: true          # fail on unreviewed build scripts (the default in pnpm 11)
# supportedArchitectures: { os: [current], cpu: [current, x64, arm64] }   # only for cross-arch packaging
```
- **`.npmrc` holds auth and registry only.** pnpm 10 documents settings in `pnpm-workspace.yaml`. pnpm 11 "no longer reads all settings from `.npmrc`. Only auth and registry settings" ([v11.0.0](https://github.com/pnpm/pnpm/releases/tag/v11.0.0)). We need no `node-linker`, `shamefully-hoist` or `electron_mirror`.
- **A per-package `node-linker` doesn't work with a shared lockfile.**
  - With pnpm 10.34.6, `apps/desktop/.npmrc` `node-linker=hoisted` was ignored on a root install; packages were still symlinked (verified).
  - Running `pnpm install` inside `apps/desktop` tried to re-link the whole workspace and stopped at the purge prompt.
  - pnpm 11's `packageConfigs` only applies layout settings per project when `sharedWorkspaceLockfile: false` ([settings](https://pnpm.io/settings#packageconfigs)).
- **`pnpm deploy` is plan B** if we ever need a flat, self-contained app directory ([deploy](https://pnpm.io/10.x/cli/deploy)).
  - pnpm 10 needs `injectWorkspacePackages: true`; without it you get `ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`. `--legacy` also works.
  - `pnpm --filter @sa/desktop deploy --prod --node-linker=hoisted <dir>` produced a flat `node_modules` with real files, workspace package included (verified).
  - It copies every project file unless `files`, `.npmignore` or `.gitignore` restrict it.
- **`pnpm approve-builds`** (10.x) still writes `onlyBuiltDependencies`, so edit `allowBuilds` by hand.

### 6.9 pi (`@earendil-works/pi-coding-agent` 1.0.0) as an externalized runtime dependency
_From the npm tarball and electron-builder's source; behavior inside the asar is UNVERIFIED._
- **Collection.** Declare it in `apps/desktop` `dependencies` so electron-vite externalizes it. The pnpm collector then copies the hoisted tree as real files into `app.asar/node_modules`, the same mechanism I verified on the fixture. Pair it with `allowMissingDependencies: false` and an asar listing in CI.
- **Files stripped by the copier.**
  - pi resolves `README.md`, `CHANGELOG.md`, `docs/` and `examples/` through `getPackageDir()`, and writes the README, docs and examples paths into its system prompt.
  - electron-builder always drops `CHANGELOG.md`, and drops top-level `README.md` and `examples/` unless they are force-included with `onNodeModuleFile`.
  - Alternatively, ship a complete copy of the package via `extraResources` and point pi's `PI_PACKAGE_DIR` env override at it.
- **Paths look like `…/app.asar/node_modules/…`.** That's fine for pi's fs-based tools, but not for its shell tool (`bash` spawn) or its `worker_threads` image-resize worker. Simplest fix: `asarUnpack: ["**/node_modules/@earendil-works/**"]` and set `PI_PACKAGE_DIR` to the `app.asar.unpacked` path.
- **esbuild.** `@earendil-works/chord` depends on esbuild 0.28.2, which ships a native binary in `@esbuild/<plat>-<arch>`. smartUnpack unpacks it, but esbuild spawns it from the `app.asar` path. Set `ESBUILD_BINARY_PATH` to the unpacked binary. That chord calls esbuild at runtime at all is UNVERIFIED. This is also why pnpm flags esbuild's postinstall. On macOS, osx-sign signs it inside `app.asar.unpacked`.
- **Things that live outside our signed bundle.** pi downloads `rg`/`fd` at runtime, and its package manager shells out to the system `npm`/`git`. Decide whether to bundle `rg` or disable npm-based extensions. WASM loaded through `fs` (photon-node) should work from the asar; for quickjs-wasi that is UNVERIFIED.
- **Node version.** pi requires `engines.node >=22.19.0`; Electron 44 ships Node 24.18.1.

### 6.10 Scratch experiments (node_modules deleted afterwards; no Electron or browser downloaded)
- **Packaging fixture:** electron-builder 26.17.0 with pnpm 10.34.6 and a fake `electronDist`. It confirmed collection of an isolated workspace, the zero-deps fallback to the root's `dependencies`, the `extendInfo` list-form bug, and the ASAR integrity plist.
- **Version resolution:** `^26.15.3` resolves to 26.15.3 in both pnpm and npm.
- **pnpm:** the per-package `.npmrc` `node-linker` is ignored, and the `pnpm deploy` inject requirement and hoisted output are as described in 6.8.
- **Playwright sizes:** read via HTTP range requests on the CDN zips (about 0.1 MB fetched each).

### 6.11 What we built (2026-10-11)

DECISIONS D17 records the decision. The config is `apps/desktop/electron-builder.ts` (TypeScript,
loaded by electron-builder through jiti). `corepack pnpm --filter @sa/desktop package` builds
the installers for this OS and CPU. `package:dir` builds only the unpacked app; `package:mac`,
`package:win` and `package:linux` are for CI runners of each OS. All of them build the app
first and pass `--publish never`.

- **Tool and targets.** electron-builder 26.17.0, pinned. macOS: dmg + zip for the host arch.
  arm64 and x64 are separate builds, with no universal app. Windows: NSIS x64, one-click and
  per-user. Linux: `.deb` x64 only (D17), which updates itself through electron-updater's
  `DebUpdater` (D19). Artifacts are named
  `SpainAssist-<os>-<arch>.<ext>`, with no version, so
  `github.com/MeLlamoPablo/SpainAssist/releases/latest/download/SpainAssist-mac-arm64.dmg`
  always points at the newest stable release. App id `es.spainassist.desktop`, product
  name "Spain Assist". `electronLanguages: [en, es]` keeps the en/es Chromium locales and
  their regional variants.
- **Package on the target machine.** pnpm installs only the host's platform packages. For
  example, `@napi-rs/canvas-darwin-x64` is missing on an Apple Silicon Mac, and electron-builder
  only warns ("platform-specific optional dependencies not bundled"). So `beforePack` throws for
  any other OS or CPU.
- **sa-sidecar.** `beforePack` runs `buildSidecar` for the target: Go with `GOOS`/`GOARCH` and
  `CGO_ENABLED=0`, into `vendor/<platform>-<arch>/`. `extraResources`
  (`vendor/${platform}-${arch}` → `vendor`) copies it outside the ASAR and keeps the exec bit.
  Without Go, packaging fails with a clear message. `corepack pnpm --filter @sa/sidecar build
  --all [--out <dir>]` cross-builds every shipped target (`SIDECAR_TARGETS`). Checked with
  `file`: Mach-O arm64 (Go linker ad-hoc signature, `linker-signed`), Mach-O x86_64 (unsigned
  until packaging), PE32+ x86-64 console (spawned with `windowsHide`) and static ELF x86-64.
  Each is about 5.5 MB.
- **What main needs at runtime.** The ASAR holds `out/` (main, preload, renderer), the agent
  host as `agent-host/host.js`, and the production graph of `dependencies` collected by
  electron-builder (121 packages). Everything in the ASAR adds up to 166 MB. The host's externals (pi, `typebox`,
  `@napi-rs/canvas`) are in `apps/desktop` `dependencies` for that reason, and a test keeps
  their versions equal to `@sa/agent`'s. smartUnpack moves native files to
  `app.asar.unpacked` (`@napi-rs/canvas-darwin-arm64` 28 MB, esbuild 21 MB, pi-tui,
  quickjs-wasi). Chromium was not bundled then: it downloaded on first use into
  Playwright's cache (6.5 option C). Since the Microsoft Store build (D17), every package bundles
  it in `<resources>/chromium/` (`scripts/chromium.ts`); the bundled Chrome for Testing .app was
  ad-hoc signed with the rest and launched, headed and headless.
- **Collecting node_modules.** electron-builder spawns `pnpm list` from PATH. On this machine
  that is the global pnpm 7, which fails, and electron-builder falls back to walking
  node_modules (the same 121 packages here). `scripts/package.mjs` therefore puts a Corepack
  `pnpm` shim first on PATH, so local builds use the same path as CI.
- **Fuses** (checked with `@electron/fuses read`). `runAsNode` and
  `enableNodeOptionsEnvironmentVariable` stay on. The agent host is spawned with
  `ELECTRON_RUN_AS_NODE`, playwright-core forks `oopBrowserDownload.js`, and the NODE_OPTIONS
  fuse also gates `NODE_EXTRA_CA_CERTS`. These two are the remaining hardening step
  (`utilityProcess`, 6.0). Cookie encryption, ASAR integrity (`ElectronAsarIntegrity` is in
  Info.plist) and `onlyLoadAppFromAsar` are on. `--inspect`, the browser-specific V8 snapshot
  and extra `file://` privileges are off.
- **Signing, driven by the environment.** `CSC_LINK` or `CSC_NAME` selects Developer ID: the
  hardened runtime, `packaging/entitlements.mac.plist` for the app (JIT, unsigned executable
  memory, camera, microphone) and `entitlements.mac.inherit.plist` for every nested binary,
  sa-sidecar included. Notarization runs when the notarytool variables are set too (6.6).
  Without those variables the build uses `identity: "-"`: an ad-hoc signature on every Mach-O.
  It has no hardened runtime, because library validation would reject Electron's frameworks,
  and no notarization. The `.app` and the sidecar inside it pass `codesign --verify --deep
  --strict`. osx-sign re-signs the sidecar ad-hoc, so there is nothing to restore. Windows uses
  `win.azureSignOptions` when `SA_AZURE_SIGNING_ENDPOINT` and its three companion variables are
  set, then a `.pfx` (`WIN_CSC_LINK`), and builds unsigned otherwise.
- **macOS notarization is deferred** until the Apple Developer account ($99/year) is bought.
  Until then a downloaded dmg is ad-hoc signed and not notarized: `spctl -a -t exec` says
  `rejected`. Users see a Gatekeeper warning ("Apple could not verify…"). On macOS 13–14 they
  right-click the app and choose Open. On macOS 15 and later, where that shortcut no longer
  works, they open System Settings → Privacy & Security → Open Anyway. They do this once per
  installed version. With an ad-hoc signature the Keychain may also ask again after each update
  before it releases the vault key (UNVERIFIED). The variables that turn signing on are
  listed in `apps/desktop/electron-builder.ts`.
- **Auto-update: not yet** (`publish: null`). electron-updater on macOS needs a signed app.
  The zip target and the blockmaps are already built for it.
- **Measured on macOS arm64 (2026-10-11).** `Spain Assist.app` is 428 MB: Electron
  Framework, plus app.asar 116 MB and 51 MB unpacked. The dmg is 166 MB and the zip 161 MB.
  `package:mac` takes about 75 s.
- **Checked in the packaged app.** It starts with an isolated profile (`SA_USER_DATA_DIR`,
  `--use-mock-keychain`) and logs `sa-sidecar started`, and the sidecar process runs from
  `Contents/Resources/vendor`. Without the binary it logs `certificate logins unavailable:
  sa-sidecar could not start … ENOENT` and still reaches `ready`. Over a DevTools port, the
  renderer serves `app://bundle/index.html` with `window.sa`. One agent turn ran through
  `app.asar/agent-host/host.js` under the packaged binary as Node, against the mock LLM. From
  inside the ASAR, `@napi-rs/canvas` loads, pi's image-resize worker starts, and
  playwright-core finds its Chromium. A first-run Chromium download into an empty
  `PLAYWRIGHT_BROWSERS_PATH` completed (the fork from inside the ASAR works).
- **UNVERIFIED:** Windows and Linux installers (not built here), x64 macOS, signing with real
  certificates, notarization, Gatekeeper and quarantine behavior of a downloaded dmg
  (including the sidecar launched from it), and AppImage on Ubuntu 24+ (user namespaces).
- **Third-party notices.** `scripts/package.mjs` runs `scripts/notices.ts` (D16) before
  electron-builder; `extraResources` ships `THIRD_PARTY_NOTICES.txt` and `LICENSE.txt` in
  Resources, outside the ASAR. electron-builder 26 moves Electron's `LICENSE` (as
  `LICENSE.electron.txt`) and `LICENSES.chromium.html` into Resources on macOS itself.
- **Possible savings.** esbuild (21 MB, via pi's `@earendil-works/chord`) is probably unused at
  runtime. Excluding it needs a check that nothing imports it when the host starts.
