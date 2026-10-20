# Electron packaging and distribution: research memo

This memo started as section 6 of a larger research doc. The numbering is kept because
`apps/desktop/electron-builder.ts` and other memos link to §6.5 and §6.11.

**What was built.** electron-builder 26.17.0 with `apps/desktop/electron-builder.ts` (its header
comment lists targets, sidecar and Chromium staging, signing and updates). macOS dmg + zip per
arch, Windows NSIS (GitHub Releases) plus an MSIX for the Microsoft Store, Linux `.deb` only.
Every build bundles playwright-core's Chrome for Testing (`scripts/chromium.ts`). Updates come
from GitHub Releases through electron-updater (`src/main/updates/`). Releases:
`.github/workflows/release.yml`. This memo keeps the external facts, measurements and rejected
options behind those choices.

## 6. Packaging and distribution

_Checked 2026-10-03. Versions: electron 44.5.1 (Chromium 152.0.7977.54, Node 24.18.1, see the [release notes](https://github.com/electron/electron/releases/tag/v44.5.1)); electron-vite 5.0.0 (6.0.0-beta.5 is on the `beta` tag); electron-builder: npm `latest` is 26.15.3, but **26.17.0 is on the `v26` dist-tag** (2026-09-26) and 27.0.0-alpha.9 is on `next`; @electron-forge/cli 8.0.1; @electron/fuses 2.1.3; @electron/rebuild 4.2.0; playwright(-core) 1.63.0 (Chrome for Testing 153.0.8010.12, rev 1243); pnpm 10.34.6 (the newest 10.x; pnpm 11 and 12 also exist, and `latest` is 12.8.1). "Verified" means I read it in source or docs, or reproduced it in a scratch experiment (see 6.10). Anything I couldn't check is marked UNVERIFIED._

### 6.0 Decisions and why
- **electron-builder, pinned exactly to `26.17.0`**, not Forge (6.3). A caret range won't pick it up: pnpm 10.34.6 and npm both resolve `^26.15.3` to **26.15.3**, because the `latest` tag satisfies the range (verified). We need the pnpm/monorepo fixes in 26.15.6–26.17.0 (6.2).
- **pnpm's default isolated `node_modules`**, no `node-linker=hoisted` or `shamefully-hoist` (6.2, 6.8).
- **`@sa/*` packages are bundled by electron-vite** (they are `devDependencies`). They export raw `./src/index.ts`, and Node "refuses to handle TypeScript files inside folders under a `node_modules` path" ([Node docs](https://nodejs.org/api/typescript.html)).
- **`runAsNode` stays on for now.** The agent host is spawned as `ELECTRON_RUN_AS_NODE`. Moving it to `utilityProcess.fork` would let us turn the fuse off (6.7, 6.11); `packages/agent/src/rpc/transport.ts` is ready for that.
- **Chrome for Testing is bundled in every build** (6.5). The Microsoft Store forbids downloading code after install (policy 10.2.2), and one build path for all targets is simpler.
- **One native runner per OS, and per macOS arch.** A universal build would double native helpers and the bundled browser.
- **No JRE.** AutoFirma is reimplemented in TypeScript (`@sa/signer`). *An earlier plan bundled a `jlink` JRE (measured: 56 MB, 30 Mach-O files to sign).*

### 6.1 Electron ≥42 has no `postinstall`: what changes for pnpm 10, dev and CI
- **What changed.** Electron 42 breaking change: "`electron` no longer downloads itself via `postinstall` script". Electron now downloads its binary "the first time that its main `bin` script is run (e.g. via `npx electron`)". A new `install-electron` script "contains the exact same code from the former `postinstall` script" (`npx install-electron --no`). Cross-platform installs use the `ELECTRON_INSTALL_PLATFORM` / `ELECTRON_INSTALL_ARCH` env vars. `ELECTRON_SKIP_BINARY_DOWNLOAD` is no longer supported ([breaking changes 42.0](https://www.electronjs.org/docs/latest/breaking-changes); [RFC #22](https://github.com/electron/rfcs/pull/22)).
- **Verified in the `electron@44.5.1` tarball:** there is no `scripts` field. The bins are `electron` and `install-electron`. `require('electron')` (index.js) runs `install.js` synchronously when `dist/` or `path.txt` is missing.
- **pnpm 10.** There is nothing left to approve for `electron`, so the `electron` entry in our `onlyBuiltDependencies` is a no-op. pnpm 10.34.6 doesn't flag it. `pnpm install` no longer fetches the binary.
- **electron-vite gotcha.** `dev` and `preview` find Electron by reading `node_modules/electron/path.txt` directly. If the file is missing they throw `Error: Electron uninstall`. They never call `require('electron')`, so the lazy download never runs (verified in the electron-vite 5.0.0 and 6.0.0-beta.5 `getElectronPath()`; [electron-vite#904](https://github.com/alex8088/electron-vite/issues/904) is still open). `electron-vite build` only needs the binary when `build.bytecode` is on. So the `dev` and `preview` scripts run `install-electron` first; `install.js` exits at once when the binary is already there.
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
- **electron-vite's template pitfalls** ([quick-start react-ts electron-builder.yml](https://github.com/alex8088/quick-start/blob/master/packages/create-electron/template/react-ts/electron-builder.yml)): it writes `extendInfo` as a YAML list (broken, 6.6), sets `npmRebuild: false` (ships host-arch binaries when cross-packaging, 6.4) and serves the renderer with `loadFile()` over `file://` (6.7). `electron-builder.ts` avoids all three.
- **v26 and `catalog:`.** Don't use `catalog:` for `electron-updater` on v26; the fix (#10019) is in 27 only.
- **Check a build** with `npx @electron/asar list <...>/app.asar`.

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

The packaged app ships `sa-sidecar` in `<resources>/vendor/` and the browser in
`<resources>/chromium/` (`extraResources`, outside the ASAR). Paths: `sidecarBinaryPath` in
`@sa/sidecar` and `src/main/browser/bundled.ts`.

**Native helpers**
- **Only spawn real paths.** From inside the asar only `execFile` works, and `cwd` can't point into an archive ([ASAR limitations](https://www.electronjs.org/docs/latest/tutorial/asar-archives)). electron-vite's `?asset&asarUnpack` rewrites paths to `app.asar.unpacked` for you.
- **Exec bits.** electron-builder's copier keeps the owner-exec bit, adds group/other exec and strips setuid (verified in builder-util). The source files must already be `+x`. Zip artifacts passed between CI jobs may lose modes (UNVERIFIED for any specific CI), so use tar or `chmod` in `beforePack`.

- **macOS signing.** electron-builder (via @electron/osx-sign) signs every binary under `Contents/`, deepest first. All nested code gets `entitlementsInherit`; per-file entitlements are only possible with a custom `mac.sign` (verified in `MacTargetHelper` and osx-sign).
  - **Third-party libraries:** a helper that loads PKCS#11 smart-card/DNIe drivers signed by other teams needs `disable-library-validation` under the hardened runtime (UNVERIFIED for the DNIe drivers; see `docs/research/dnie.md`).
  - **Placement.** Apple puts helper tools in `Contents/Helpers|MacOS` and dylibs in `Contents/Frameworks`, and warns that misplaced code "might cause problems during notarization" ([Placing content in a bundle](https://developer.apple.com/documentation/bundleresources/placing-content-in-a-bundle)). `Contents/Resources/vendor` via `extraResources` is the pragmatic spot for helpers; electron-builder's docs recommend it for binaries. Validate early with `codesign --verify --deep --strict -vv`, `spctl -a -vvv -t exec` and a real `notarytool` submission (UNVERIFIED that it passes).
- **Windows.** `.exe` files copied through `extraResources` are signed automatically. DLLs are signed only if you add `win.signExts: [".dll"]` (verified in `winPackager`).

**Playwright's browser**
- **Which build it uses.** Since 1.57, headed mode uses **Chrome for Testing** and headless mode uses **chrome-headless-shell** ([release notes](https://playwright.dev/docs/release-notes#version-157)).
- **Install controls** ([browsers](https://playwright.dev/docs/browsers)):
  - `npx playwright install chromium --only-shell` installs only the headless shell; `--no-shell` installs only CfT.
  - `PLAYWRIGHT_BROWSERS_PATH=<dir>` picks the directory; `=0` installs into `node_modules/playwright-core/.local-browsers`.
  - playwright-core reads that env var when its registry initializes, so set it in the child's env, or pass `chromium.launch({ executablePath })` (what the packaged app does). For non-bundled browsers the docs say "use at your own risk"; the matching revision is fine.
- **Layout for rev 1243:**
  - `chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
  - `chromium-1243/chrome-win64/chrome.exe` and `chromium-1243/chrome-linux64/chrome`
  - `chromium_headless_shell-1243/chrome-headless-shell-{mac-arm64|mac-x64|win64|linux64}/chrome-headless-shell[.exe]`
- **Sizes** for CfT 153.0.8010.12, read from the CDN zips' central directories:

  | | mac-arm64 | mac-x64 | win64 | linux64 |
  |---|---|---|---|---|
  | `chromium` (CfT), zip / unpacked | 182 / 358 MiB | 192 / 369 | 196 / 432 | 187 / 391 |
  | `chromium-headless-shell`, zip / unpacked | 94 / 195 MiB | 99 / 199 | 115 / 270 | 114 / 260 |
- **Don't package with `PLAYWRIGHT_BROWSERS_PATH=0`.** The browser lands in node_modules, i.e. inside the asar. electron-builder's built-in mac sign-ignore list covers `node_modules/playwright/.local-browsers` and `puppeteer/.local-chromium`, but not `playwright-core`. Anything ignored stays unsigned, and notarization fails. That is why the build stages it into `vendor/<platform>-<arch>/chromium` and ships it via `extraResources`. There is an undocumented `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE` for cross-downloading (UNVERIFIED).
- **macOS signing of CfT.**
  - The CfT zip contains **no `_CodeSignature` directories** (verified), so it isn't a sealed Developer-ID bundle. We would have to sign every Mach-O ourselves: a 235 MB framework, 8 helper apps, crashpad and dylibs. osx-sign would do this, and electron-builder's copier preserves the framework's 5 symlinks.
  - Bundled browsers have failed to sign before: [#2010](https://github.com/electron-userland/electron-builder/issues/2010) (Puppeteer: "code object is not signed") and [#5383](https://github.com/electron-userland/electron-builder/issues/5383) (Playwright). That's why the ignore list exists.
  - Ad-hoc re-signed with the rest of the app, CfT 153 launches headed and headless (6.11). It passes Developer ID signing with the hardened runtime and notarization (verified 2026-10-20, §6.11). Whether the agent can still launch it under the hardened runtime is UNVERIFIED.
  - `mac.binaries` only matters for files outside the bundle walk. `signIgnore` leaves files unsigned, so notarization rejects the app.

**Options for the agent's browser**
- **Chosen: bundle Chrome for Testing** (headed CfT, `playwright-core install --no-shell`), staged by `scripts/chromium.ts`. The Microsoft Store forbids downloading code after install (policy 10.2.2), it works offline from the first run, and every build follows one path. Cost: about 360–430 MiB unpacked per platform (table above) and the macOS signing risk above.
- **Rejected: download on first run** into Playwright's cache (what builds did until the Store MSIX). Needs network on first use, the binary sits outside our signed bundle, and the Store forbids it. How Gatekeeper treats Node-downloaded files was never checked.
- **Rejected: Electron's own Chromium over a CDP port** (`remote-debugging-port` + `connectOverCDP()`). CDP on localhost has no authentication, so any local process could drive *every* window, including our privileged UI. Playwright sees a single BrowserContext even with `session.fromPartition` ([#34815](https://github.com/microsoft/playwright/issues/34815)): no `newContext()`, per-context tracing or `clientCertificates`, and the docs call it "significantly lower fidelity" ([connectOverCDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)). The UA also contains `Electron/44`.
- **Rejected: `webContents.debugger`** ([docs](https://www.electronjs.org/docs/latest/api/debugger)). In-process CDP with no port, but no Playwright API: we'd write our own CDP layer.
- **Not chosen: `chrome-headless-shell` only.** Much easier to sign on macOS (one Mach-O plus 4 dylibs, no nested bundle), but the agent shows headed windows for logins the user does, and some government WAFs block the shell (`docs/research/browser.md` §5.1).
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

- **Notarization** runs when `mac.notarize` is on and the env vars are present (our config turns it on only with a certificate).
  - Precedence: Apple ID trio, then API-key trio, then keychain profile (verified).
  - **`APPLE_API_KEY` must be a *file path* to the `.p8`.** It is passed straight to `notarytool --key`; @electron/notarize documents it as "File system path to the .p8". The v26 notarization page shows a base64 value; that conflicts with the code.
  - Also set `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. The signing certificate goes in `CSC_LINK` and `CSC_KEY_PASSWORD`. Stapling is automatic.
- **Platform floor.** Electron 44 requires macOS 13+ and ships 64-bit builds only.
- **Entitlements** are in `apps/desktop/packaging/`. Add `disable-library-validation` to the main app's only if the main process loads dylibs signed by another team. Whether nested helpers need the camera key is UNVERIFIED (the inherit file has it).
- **CI with an API key:** decode the `.p8` from a secret into `$RUNNER_TEMP/AuthKey.p8` and set `APPLE_API_KEY` to that path.
- **`CSC_IDENTITY_AUTO_DISCOVERY=false` disables `CSC_LINK` too** (26.17.0, verified): `findIdentity` returns null without `CSC_NAME` or `mac.identity`, and signing is skipped with only a warning. With `CSC_LINK`, auto-discovery searches only the temporary keychain the .p12 is imported into, so release.yml turns it on for macOS; `forceCodeSigning` makes a skipped signature fail the build.

**Windows**
- **Configuration.** `win.azureSignOptions` (Azure **Artifact Signing**, formerly Trusted Signing) is built in.
  - Required fields: `publisherName` (the certificate CN), `endpoint`, `certificateProfileName` and `codeSigningAccountName`.
  - Optional fields: `fileDigest`, `timestampRfc3161` and `timestampDigest`. Any extra keys are passed through to `Invoke-TrustedSigning`.
  - It can't be combined with `win.signtoolOptions`, which is where v26 moved the pfx and `sign` options.
- **Runner.** electron-builder installs the `TrustedSigning` PowerShell module (≥0.5.0) and calls `Invoke-TrustedSigning`, so plan on a Windows runner. Whether it works under `pwsh` on macOS/Linux is UNVERIFIED. For macOS/Linux, the Electron docs suggest `jsign` behind a custom `sign` hook.
- **Auth.** Use `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` ([code-signing-win](https://www.electron.build/code-signing-win), [Electron code-signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)).
- **Eligibility** for Public Trust certificates: **organizations** in the EU (Spain qualifies), US, CA, UK and others. **Individual developers must be in the US or Canada** ([Microsoft quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)).
- **The Store MSIX** is left unsigned: the Store signs it on submission (see `appx` in `electron-builder.ts`).

**Linux** (we ship a `.deb` only; facts on the other targets kept in case that changes)
- **deb:** the after-install script installs an AppArmor profile granting `userns` on Ubuntu 24+. It sets `chrome-sandbox` SUID only when user namespaces are unavailable (verified). Use `deb.appArmorProfile` to override.
- **AppImage:** would need `toolsets.appimage: "1.0.3"`, a static runtime with no libfuse2 dependency whose AppRun only adds `--no-sandbox` when user namespaces are unavailable (the default in v27). The v26 default, `0.0.0`, is the deprecated FUSE2 runtime ([appimage](https://www.electron.build/appimage)). Its `resourcesPath` is a read-only mount whose path changes on every launch.
- **flatpak:** only single-file bundles are supported, and the build host needs `flatpak` and `flatpak-builder`. Set `runtimeVersion: "24.08"`; the schema default is still `20.08`. DNIe readers probably need `--socket=pcsc` (UNVERIFIED).
- **snap:** skipped.
- **Signing:** there is no code signing on Linux; publish checksums.

### 6.7 Electron fuses
- **The key is `electronFuses`** (verified in the 26.15.3 and 26.17.0 schemas; [tutorial](https://www.electron.build/tutorials/adding-electron-fuses)). Fields: `runAsNode`, `enableCookieEncryption`, `enableNodeOptionsEnvironmentVariable`, `enableNodeCliInspectArguments`, `enableEmbeddedAsarIntegrityValidation`, `onlyLoadAppFromAsar`, `loadBrowserProcessSpecificV8Snapshot`, `grantFileProtocolExtraPrivileges`, `resetAdHocDarwinSignature`.
- **Order of operations:** the `afterPack` hook runs, then fuses are flipped, then the app is signed (verified in `platformPackager`).
- **What it can't do:** it has no `wasmTrapHandlers` key, because it bundles @electron/fuses ^1.8.0. If you want `wasmTrapHandlers` or `strictlyRequireAllFuses`, use an `afterPack` hook with @electron/fuses 2.1.3, which is ESM-only and needs Node ≥22.12.
- **Our values** are in `electron-builder.ts` (`electronFuses`). The target state turns `runAsNode` and `enableNodeOptionsEnvironmentVariable` off too, once the agent host runs in a `utilityProcess`.

Check the result with `npx @electron/fuses read --app <path>.app`. Consequences, per the [Electron fuses doc](https://www.electronjs.org/docs/latest/tutorial/fuses) unless noted:
- **`runAsNode: false` (not yet).** "With this fuse disabled, `child_process.fork` throws." `spawn(process.execPath, …)` with `ELECTRON_RUN_AS_NODE` no longer gives you Node. Use `utilityProcess.fork`; in electron-vite that's `import entry from './agent-host?modulePath'`. Audit dependencies that fork or need a `node` binary (playwright-core's `oopBrowserDownload.js` fork no longer runs: the browser is bundled). electron-vite's `build.bytecode` is unaffected because it runs at build time with the dev binary.
- **`enableNodeOptionsEnvironmentVariable: false` (not yet)** also disables `NODE_EXTRA_CA_CERTS`. Behind corporate TLS proxies, use Electron's `net.fetch`, which uses the system trust store.
- **`enableNodeCliInspectArguments: false`.** Playwright's `_electron.launch()` always passes `--inspect=0` (verified in 1.63). Run E2E against unfused builds and smoke-test the fused artifact separately. The exact failure mode is UNVERIFIED.
- **`enableEmbeddedAsarIntegrityValidation`** works on macOS and on Windows from Electron 30. electron-builder writes `ElectronAsarIntegrity` and the Windows `INTEGRITY/ElectronAsar` resource automatically (verified). It only covers `app.asar`. That `app.asar.unpacked` and `extraResources` are not covered is UNVERIFIED; on macOS the code signature seals them.
- **`enableCookieEncryption`** is one-way. On macOS it needs a stable signature for Keychain access, same as `safeStorage` ([code-signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)). Use the async `safeStorage` APIs now; the sync ones are deprecated in 45 and removed in 46.
- **`grantFileProtocolExtraPrivileges: false`** needs the renderer off `file://` (the template's `loadFile()`); otherwise Vite's module scripts will likely break (UNVERIFIED). Ours is served from `app://` through `protocol.handle`.
- **No fuse blocks Chromium's `--remote-debugging-port`.** We don't use CDP into Electron (6.5), so consider refusing to start in packaged builds when it is present (UNVERIFIED practice).

### 6.8 pnpm workspace config
Ours is the root `pnpm-workspace.yaml` (default isolated linker, `allowBuilds`).
- **`allowBuilds`** (pnpm ≥10.26) replaces `onlyBuiltDependencies`/`ignoredBuiltDependencies`, both removed in pnpm 11. `strictDepBuilds` (fail on unreviewed build scripts) is the default from pnpm 11. `electron` needs no entry: Electron ≥42 has no install script. `electron-winstaller` comes from electron-builder's Squirrel peer and is only needed for Squirrel.Windows.
- **Cross-arch packaging** on one machine would need `supportedArchitectures: { os: [current], cpu: [current, x64, arm64] }`.
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

### 6.9 pi (`@earendil-works/pi-coding-agent` ^1.1.0) as an externalized runtime dependency
pi (with `typebox` and `@napi-rs/canvas`, the agent host's other externals) is in `apps/desktop`
`dependencies`, so electron-vite externalizes it and the pnpm collector copies it as real files
into `app.asar/node_modules`. It works from inside the ASAR with only smartUnpack (6.11): no
`asarUnpack`, `PI_PACKAGE_DIR` or `ESBUILD_BINARY_PATH` override was needed.
- **Files stripped by the copier.** pi resolves `README.md`, `CHANGELOG.md`, `docs/` and `examples/` through `getPackageDir()` and puts those paths into its default system prompt. electron-builder always drops `CHANGELOG.md`, and drops top-level `README.md` and `examples/` unless forced in with `onNodeModuleFile`. Harmless for us: the host replaces pi's system prompt (`before_agent_start`).
- **esbuild.** `@earendil-works/chord` depends on esbuild 0.28.2, whose native binary in `@esbuild/<plat>-<arch>` smartUnpack moves to `app.asar.unpacked` (21 MB). esbuild would spawn it from the `app.asar` path; that chord calls esbuild at runtime at all is UNVERIFIED (see "Possible savings" in 6.11).
- **Things outside our signed bundle.** pi downloads `rg`/`fd` at runtime, and its package manager shells out to the system `npm`/`git`. The host loads no extensions and runs offline (`PI_OFFLINE=1`), so neither is used today (`packages/agent/README.md`).
- **Node version.** pi requires `engines.node >=22.19.0`; Electron 44 ships Node 24.18.1.

### 6.10 Scratch experiments (node_modules deleted afterwards; no Electron or browser downloaded)
- **Packaging fixture:** electron-builder 26.17.0 with pnpm 10.34.6 and a fake `electronDist`. It confirmed collection of an isolated workspace, the zero-deps fallback to the root's `dependencies`, the `extendInfo` list-form bug, and the ASAR integrity plist.
- **Version resolution:** `^26.15.3` resolves to 26.15.3 in both pnpm and npm.
- **pnpm:** the per-package `.npmrc` `node-linker` is ignored, and the `pnpm deploy` inject requirement and hoisted output are as described in 6.8.
- **Playwright sizes:** read via HTTP range requests on the CDN zips (about 0.1 MB fetched each).

### 6.11 What we built (2026-10-11, updated for the Store MSIX)

The config and its rationale are in `apps/desktop/electron-builder.ts`; the release flow is in
`.github/workflows/release.yml` and `AGENTS.md` ("Installers"). What follows is what the code
doesn't record: measurements, checks in the packaged app, and open points.

- **Package on the target machine.** pnpm installs only the host's platform packages (e.g.
  `@napi-rs/canvas-darwin-x64` is missing on an Apple Silicon Mac), and electron-builder only
  warns ("platform-specific optional dependencies not bundled"). That is why `beforePack` throws
  for any other OS or CPU.
- **sa-sidecar binaries** (`corepack pnpm --filter @sa/sidecar build --all`), checked with
  `file`: Mach-O arm64 (Go linker ad-hoc signature, `linker-signed`), Mach-O x86_64 (unsigned
  until packaging), PE32+ x86-64 console (spawned with `windowsHide`) and static ELF x86-64.
  Each is about 5.5 MB. osx-sign re-signs the sidecar ad-hoc, so there is nothing to restore.
- **ASAR contents.** `out/`, `agent-host/host.js` and the production graph of `dependencies`
  (121 packages): 166 MB in all. smartUnpack moves native files to `app.asar.unpacked`
  (`@napi-rs/canvas-darwin-arm64` 28 MB, esbuild 21 MB, pi-tui, quickjs-wasi).
- **pnpm 7 on PATH.** electron-builder spawns `pnpm list` from PATH. On this machine that is the
  global pnpm 7, which fails, and electron-builder silently falls back to walking node_modules
  (the same 121 packages here). `scripts/package.mjs` puts a Corepack `pnpm` shim first on PATH,
  so local builds take the same path as CI.
- **Fuses** (checked with `@electron/fuses read`): as set in `electron-builder.ts`, with
  `ElectronAsarIntegrity` in Info.plist. `runAsNode` and `enableNodeOptionsEnvironmentVariable`
  are the remaining hardening step (6.0, 6.7): the agent host runs as `ELECTRON_RUN_AS_NODE`,
  and the NODE_OPTIONS fuse also gates `NODE_EXTRA_CA_CERTS`.
- **Ad-hoc signing.** Without certificates every Mach-O gets `identity: "-"`, with no hardened
  runtime (library validation would reject Electron's frameworks). The `.app` and the sidecar in
  it pass `codesign --verify --deep --strict`.
- **macOS releases are signed and notarized** (Developer ID Application, team B3KD4D44DR) from
  release.yml, and update themselves (`src/main/updates/`). Releases before that were ad-hoc
  signed: Gatekeeper warned ("Apple could not verify…", Open Anyway in Privacy & Security), and
  they never update, so their users install a signed release by hand once.
- **Verified 2026-10-20 (local signed build, arm64, 0.3.0-beta).** Notarization succeeds with the
  bundled Chrome for Testing: `spctl -a -t exec` says `accepted, source=Notarized Developer ID`,
  the ticket is stapled to the app, and CfT carries our Developer ID with the hardened runtime.
  `package:mac` took 13 min, mostly notarization. The dmg itself stays unsigned and unstapled
  (`dmg.sign` is off by default); Gatekeeper checks the stapled app inside it.
- **Keychain on the switch to signing.** The safeStorage keychain item was created by an ad-hoc
  build, so the first signed launch asks for the login password to release it (verified: the
  app waits on SecurityAgent). "Always Allow" adds the Developer ID app, and later signed
  updates keep the same designated requirement, so it asks once (later updates UNVERIFIED).
- **Measured on macOS arm64 (2026-10-11, before Chromium was bundled).** `Spain Assist.app` is
  428 MB: Electron Framework, plus app.asar 116 MB and 51 MB unpacked. The dmg is 166 MB and the
  zip 161 MB. `package:mac` takes about 75 s. Bundled Chrome for Testing adds about 358 MiB
  unpacked on mac-arm64 (6.5 table); the new totals were not re-measured.
- **Checked in the packaged app.** It starts with an isolated profile (`SA_USER_DATA_DIR`,
  `--use-mock-keychain`) and logs `sa-sidecar started`, and the sidecar process runs from
  `Contents/Resources/vendor`. Without the binary it logs `certificate logins unavailable:
  sa-sidecar could not start … ENOENT` and still reaches `ready`. Over a DevTools port, the
  renderer serves `app://bundle/index.html` with `window.sa`. One agent turn ran through
  `app.asar/agent-host/host.js` under the packaged binary as Node, against the mock LLM. From
  inside the ASAR, `@napi-rs/canvas` loads, pi's image-resize worker starts, and playwright-core
  finds its Chromium. Before Chromium was bundled, a first-run download into an empty
  `PLAYWRIGHT_BROWSERS_PATH` also completed: playwright-core's fork of `oopBrowserDownload.js`
  works from inside the ASAR. The bundled Chrome for Testing `.app`, ad-hoc signed with the
  rest, launched headed and headless.
- **UNVERIFIED:** the Windows installers and the MSIX (not built here), the Linux `.deb`, x64
  macOS, signing with real certificates, notarization (including the bundled CfT), and
  Gatekeeper and quarantine behavior of a downloaded dmg (including the sidecar launched from it).
- **Possible savings.** esbuild (21 MB, via pi's `@earendil-works/chord`) is probably unused at
  runtime. Excluding it needs a check that nothing imports it when the host starts.
