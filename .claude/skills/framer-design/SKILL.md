---
name: framer-design
description: Build or change the desktop app's UI from the Framer designs, and keep the "App Screens" page in sync with the real app. Use when a task touches the renderer's screens or mentions Framer, the designs, or App Screens.
---

# Framer designs

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
  When a state isn't designed, ask instead of guessing.
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

Framer components and React components are separate implementations: changing one never updates
the other.

## Where each area lives in the renderer

Paths are under `apps/desktop/src/renderer/src/`.

| Area | Source |
| --- | --- |
| Brand | `components/brand.tsx` |
| Shell, navigation | `features/shell` |
| Chat and prompts | `features/chat`, `features/chat/prompts` |
| Procedures | `features/procedures` |
| Mis datos, privacy | `features/vault` |
| Settings | `features/settings` |
| Onboarding | `features/onboarding` |
| Buttons, controls | `components/ui` |

Phone screens (`apps/mobile`) are frames named `Móvil · …` at 411×914 (the emulator screen in dp),
in a row below the desktop frames. They follow the phone app's Material 3 UI in
`apps/mobile/shared`.

## Colors

- The palette is `apps/desktop/src/renderer/src/design/color-tokens.json`. Each entry has a CSS
  variable, a Framer color style (name and stable id) and light/dark sRGB values. Components use
  semantic Tailwind utilities (`bg-surface`, `text-fg`, `border-line`…), never raw colors.
- `design/colors.css` is generated from that JSON and committed. Builds never generate or check
  it, and never contact Framer.
- Text and icons on accent fills use `App/accent-fg` (white in light mode, dark in dark mode).
  Mock government screenshots, document illustrations and map tiles have their own colors; they
  aren't theme colors.
- Keep a style while the app or any Framer page uses it, including hover, dark-theme and other
  states that App Screens doesn't show.

To change the palette:

1. Edit the JSON, then run `corepack pnpm design:colors`.
2. Update the matching Framer color styles by id; every linked frame follows.
3. Run `corepack pnpm design:colors:check`.
4. Export `await framer.getColorStyles()` to a JSON file in your tmp dir and check it with
   `node tools/design-colors.mjs --check --framer-styles <file>`.
5. Review the app in both themes and compare the affected Framer frames.
