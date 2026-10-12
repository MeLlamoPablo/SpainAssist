# SpainAssist — conventions for agents

Read `SPEC.md` (product), `docs/ARCHITECTURE.md` (how it fits together) and the memos in
`docs/research/` relevant to your task before writing code.

## Tooling

- **Always run pnpm through corepack: `corepack pnpm …`** (never bare `pnpm`: the global pnpm on
  this machine is v7 and will break the v9 lockfile). Set `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`.
  pnpm 12 needs Corepack ≥ 0.36 (installed globally on this machine).
- Certificate logins need Go 1.19+ at build time: `corepack pnpm --filter @sa/sidecar build`
  creates `apps/desktop/vendor/<platform>-<arch>/sa-sidecar`. Dev, preview, smoke and e2e build it
  first. Without Go or the binary the app runs with certificate logins unavailable.
- Node 24, TypeScript 7 (`tsc` is the native compiler), Vitest 5, Biome 2 (lint + format).
- Disk space is tight (~12 GB free). Don't download extra browsers: check
  `~/Library/Caches/ms-playwright` for the Chromium playwright-core expects and use a cached one.
- Electron ≥42 has no postinstall: run `corepack pnpm --filter @sa/desktop exec install-electron`
  once before `dev`/`preview`/e2e (the `dev` script does it). The binary is cached.
- Phone app (`apps/mobile`, Gradle): JDK 17 (picked from `gradle/gradle-daemon-jvm.properties`),
  Android SDK platform 37, `apps/mobile/local.properties` with `sdk.dir` (gitignored). Run
  `./gradlew :shared:testAndroidHostTest` and `:androidApp:assembleDebug` from `apps/mobile`;
  `corepack pnpm --filter @sa/relay-server interop` checks it against the desktop code.
- Desktop app: `corepack pnpm --filter @sa/desktop dev` (electron-vite). Workspace packages are
  bundled into main/preload/renderer; third-party runtime deps that must stay external (pi,
  playwright-core, and the agent host's imports `typebox` and `@napi-rs/canvas`) are listed in
  `apps/desktop` `dependencies`.
- Installers (electron-builder, `apps/desktop/electron-builder.ts`, D17):
  `corepack pnpm --filter @sa/desktop package` builds them for this OS and CPU only (dmg + zip
  on macOS), and `package:dir` builds only the unpacked app. `package:mac`, `package:win` and
  `package:linux` are for CI runners of that OS. Releases: pushing a `vX.Y.Z` tag on a commit of
  `master` runs `.github/workflows/release.yml`, which builds macOS arm64, macOS x64 and
  Windows x64 and publishes a GitHub Release. Packaging needs Go (it builds sa-sidecar for the
  target). Signing is env-driven, so local builds are ad-hoc signed on macOS. Output goes to
  `apps/desktop/dist/` (about 430 MB unpacked plus 330 MB of installers): delete it when done.
- Never touch `~/.pi` or other global config. Never use real credentials. Automated tests must
  never contact real government sites or paid APIs: use `apps/mock-sede` and `tools/mock-llm`.

## Layout

| Path | What |
| --- | --- |
| `apps/desktop` | Electron app (electron-vite): `src/main` (Node), `src/preload`, `src/renderer` (React) |
| `apps/mobile` | Phone app for DNIe signatures and certificate logins (Compose Multiplatform; `shared` + `androidApp`) |
| `apps/mock-sede` | Fake government site (Cl@ve-like login, client-cert login, AutoFirma signing) for tests/demos |
| `packages/shared` | **Contracts**: domain types + zod schemas, host bridge API, renderer IPC API |
| `packages/agent` | pi extension (tools), system prompt, guides, pi launcher + RPC client, provider helpers |
| `packages/sidecar` | Native Go TLS helper plus Node client: per-session loopback proxy, `.p12` and phone DNIe login keys |
| `packages/browser` | Playwright browser service (snapshots, actions, client certs, AutoFirma shim injection) |
| `packages/signer` | AutoFirma replacement: in-page AutoScript shim + CAdES/XAdES/PAdES signing |
| `packages/vault` | Encrypted local vault (envelope encryption, KeyProvider injected) |
| `packages/pii` | PII detection/scrubbing for Spanish text |
| `packages/companion` | Desktop ↔ phone channel for DNIe signatures (pairing link, E2E channel, `PhoneSigner`) |
| `packages/gateway-keys` | Users' LiteLLM gateway keys as auth for our services: key check + daily quota |
| `services/key-server` | Voucher → capped LiteLLM virtual key (Hono + Postgres/PGlite) |
| `services/feedback-server` | Anonymous learnings: ingest + full-text search (Hono + Postgres/PGlite) |
| `services/maps-server` | Mapbox address lookups for maps, behind the user's LiteLLM key and a daily limit (Hono) |
| `services/relay-server` | Relay for the desktop ↔ phone channel (end-to-end encrypted frames, no accounts) |
| `tools/mock-llm` | Scripted OpenAI-compatible LLM server for e2e tests |
| `e2e` | Playwright tests driving the Electron app with all backends mocked |

Local ports: key-server 8787, feedback-server 8788, mock-llm 8789, mock-sede 8790 (+8791 for
client-certificate login), maps-server 8793, relay-server 8794.

## Code conventions

- New code is MIT (`LICENSE`, D16). No copyleft or proprietary dependency goes into the desktop,
  the services or the packages without a decision (`apps/desktop/scripts/notices.ts` checks the
  desktop's).
- ESM everywhere. Internal packages export TypeScript source (`"exports": "./src/index.ts"`);
  bundlers/tsx/vitest consume it directly. Import siblings by package name (`@sa/shared`).
- Contracts live in `@sa/shared`. The app is not in production yet: change contracts whenever
  that's the right design, and update every consumer in the same change. Don't work around a
  contract (e.g. `custom.*` keys for fields the app knows), and don't add compatibility shims or
  migrations for old data. Mention contract changes in your final summary.
- Remove unused code in the same change that makes it unused: functions, exports, types, files,
  tests, docs mentions and dependencies. Don't keep dead code "for later", and don't ask before
  removing it.
- Validate all untrusted input (IPC from renderer, bridge requests, HTTP bodies) with zod.
- Library packages (`packages/*`) must not import Electron. Electron-specific code lives in
  `apps/desktop/src/main`.
- Secrets (passwords, .p12, API keys, OAuth tokens, the DNIe PIN) never go to the renderer, the
  agent/model, logs, or the network (except to the service they authenticate against). The DNIe
  PIN leaves the desktop only to the paired phone, inside the encrypted channel, per request and
  after the desktop's approval (D18).
- Code and comments in English. User-facing copy in Spanish (default) and English; plain words,
  short sentences, "tú" form, no bureaucratic jargon.
- Style: Biome defaults from `biome.json` (2 spaces, single quotes, width 100). Run
  `corepack pnpm exec biome check --write <paths>` on files you touch.
- Tests: Vitest, colocated in `test/` or `*.test.ts`. Keep unit tests fast and offline.

## Framer designs

The UI is designed in the Framer project "Spain Assistant"
(https://framer.com/projects/Spain-Assistant--pUjYAa19YnbwN3svySUn-5RLSE). Two pages matter:

| Page | What | May agents edit it? |
| --- | --- | --- |
| App Explorations v2 | The design source of truth: what the UI should become | No, read only |
| App Screens | A generated copy of every screen of the real app, as built | Yes, when asked |

- **Access.** Load the `framer` skill: run `npx @framer/agent@latest setup` once, then create one
  `session new <project>` and reuse its session id for the whole task. The CLI needs network
  access, so run it outside the sandbox. Read the generated `projects/<id>/index.md` task map
  before writing scripts.
- **Read designs, don't copy them blindly.** Take node screenshots or `serialize` the frames to
  get copy, spacing, colors and states. Then build the screen with the renderer's own Tailwind
  tokens and components (`styles.css`, `components/ui`); don't port Framer's absolute positions.
  When the design and `SPEC.md` disagree, or a state isn't designed, ask instead of guessing.
- **Check your work in the web preview** (no Electron, mock API, no agents or network):
  `corepack pnpm --filter @sa/desktop preview:web` (port 5180; pass `--port` if it's taken).
  Query params are listed in `apps/desktop/vite.renderer.config.ts`; use `?freeze=1` for
  stable screenshots. Screenshot with `playwright-core` from `apps/desktop/node_modules` and the
  cached Chromium, at the same viewport as the design frame.
- **Keep "App Screens" in sync** when a task changes the UI and the user asks for it:
  - one frame per screen state, named `Area · State` (e.g. `Inicio · Menú de un trámite`), at
    1280×820, in Spanish, light theme, mock data only (never real personal data);
  - build frames with `framer.agent.applyChanges` as real layout: stacks, text, fills, borders.
    Use icons from the project's Lucide icon set, and upload only true raster images;
  - each frame holds its screen as plain layers. Don't put screens into a component with one
    variant per screen: each variant copies every screen, and Framer breaks at that size;
  - make a component only for a reusable bit. It needs props (label, icon, count) or state
    variants (Active, Selected) that its uses actually set. A no-prop component is fine only
    for identical chrome or cards used in 3 or more frames. Don't make one component per label
    (`Usar`, `Renovar el DNI`): add an instance of the generic one and set its props. Inline
    anything used once;
  - replace only the frames you generate, and delete frames for states the app no longer has.
    Never touch other pages, and don't publish;
  - compare a Framer screenshot of each frame with the app screenshot. Expect a small pixel
    difference from font rendering: about 2% on simple screens, about 4% on text-heavy ones.
    Anything more is a real mismatch to fix;
  - there is no generator script in the repo; keep throwaway scripts in your job's tmp dir.
- If the CLI reports `[FRAMER_BRANCH_CHANGE]`, rename an auto-named branch after the task and
  tell the user the branch URL.

## Git

- **Never rewrite or squash history without reading `PRODUCTION_CHECKLIST.md`**: commit `fc83e68`
  is the only recovery path for the git-crypt secrets in `infra/terraform/`. Never commit a
  secret file that `.gitattributes` does not encrypt (check `git-crypt status`).
- **git-crypt in worktrees**: the key lives only in the main checkout, so in a worktree run git
  with `-c filter.git-crypt.smudge=cat -c filter.git-crypt.clean=cat -c
  filter.git-crypt.required=false` (also for `git worktree remove`), and never stage
  `infra/terraform/terraform.tfvars` or `terraform.tfstate` there. Only the main checkout
  changes those files.
- Always work on your own branch/worktree. When your task is done, merge your changes back to the trunk branch automatically, without human consent. Then clean up the worktree. This ensures parallel agents can work on multiple features whilst not adding friction. Never push.
- The trunk is `master`, the branch checked out in the main checkout. A fresh worktree may be
  based on `origin/master`, which lags behind: `git reset --hard master` it before you start.
- **Link dependencies in every new worktree** before you run anything:
  `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --offline --frozen-lockfile`. It
  hard-links from the pnpm store the main checkout already uses (a few seconds, no download, no
  extra disk). Don't symlink the main checkout's `node_modules`: workspace links (`@sa/shared`, …)
  would then resolve to the main checkout's sources instead of your worktree's.
- **Run all relevant checks in the worktree before merging, however small the change**: Biome on
  touched files, `corepack pnpm typecheck`, the tests of the packages you touched, and for UI
  changes a web-preview screenshot. "No dependencies in the worktree" is never a reason to skip
  them. Report any failures, and say which ones were already failing on the trunk.
- **Do the merge yourself; never hand it back to the human as a command to run.** Commit in your
  worktree, then leave it (e.g. `ExitWorktree` with `keep`, so the session may run git in the main
  checkout). From the main checkout: `git merge --ff-only <your-branch>` (rebase your branch onto
  the trunk first if it has moved), then `git worktree remove <path>` and
  `git branch -d <your-branch>`. If uncommitted changes in the main checkout block the merge,
  stop and report instead of stashing or discarding them.
- Only edit files inside the paths your task owns, unless the task says otherwise.
