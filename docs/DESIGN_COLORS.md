# App and Framer colors

The canonical palette is `apps/desktop/src/renderer/src/design/color-tokens.json`.
Each entry contains a CSS variable, a named Framer color style, its stable Framer ID,
and matching light/dark sRGB values. The 79 shared color styles cover the ink accent (the app's text colour, no brand hue),
surfaces, typography, semantic statuses, flag, window controls, map markers,
translucent fills and shadow colors. sRGB values preserve the former OKLCH palette
at the 8-bit precision used in Framer's App Screens.

The app imports committed `design/colors.css` through `styles.css`. It is generated
explicitly from the local palette JSON, never from Framer during a build. Builds
neither generate nor check this file and never contact Framer. Components
continue to use semantic Tailwind utilities (`bg-surface`, `text-fg`, `border-line`, etc.). Brand stripes and preview window controls now use
tokens too. Text and icons on accent fills (and a checked switch's thumb) use
`App/accent-fg`: white in light mode, dark in dark mode, where the accent turns light.
Fixed white/black tokens are intentional for unchecked switch thumbs, camera
surfaces and image viewing. Mock government screenshots, document illustrations
and map-tile artwork have their own content colors; they are not app theme colors.

All 22 Framer App Screens use color styles for fills, text, icons, borders,
gradient stops and shadow colors. Shared white fills use the surface style;
white text uses the fixed white style, except on accent fills (`App/accent-fg`). The wordmark uses the app foreground
style. The Design source logo retains its existing outline style; other pages
were not edited.

## Background consolidation

Surface is the shared app background: white (`#FFFFFF`) in light mode and
`#1E1B19` in dark mode. The former canvas color is removed. Uses temporarily
redirected to sidebar were corrected to surface; original sidebar uses retain
their sidebar color. The translucent background variant is `App/surface/95%`.

## Surface levels

The palette has three surface levels. Light mode uses white surface,
`#FCFBF9` for surface-2 (the former canvas), and `#F9F7F3` for surface-3.
The former light surface-3 shade `#F0ECE7` is retired. Dark mode keeps its
existing values: `#1E1B19`, `#24211E`, and `#2E2A27`.

Translucent variants use their base surface's RGB values and retain their
opacity: surface-2/50%, surface-2/60%, and surface-3/70%. Surface/95% stays
unchanged. Names, style IDs and component references stay unchanged.

## Palette cleanup

Procedure question sections inherit the card surface; they no longer have an amber
background. Status badges, the card outline, and focused/selected controls retain
their semantic colors.

Unused teja ramp colors and the old question tint were removed from both sides.
Action and danger foreground utilities share fixed white. Neutral status utilities
share the existing muted foreground, third surface, line and faint foreground.
Small elevation shadows share one color while keeping their distinct geometry.

Keep a style when either the app or any Framer page uses it. A style absent from
the current App Screens can still serve an app hover, dark theme or another state.
Framer opacity variants remain shared tokens when the canvas references them, even
if Tailwind computes that opacity from the base token in the app.

## Changing the palette

1. Edit the palette JSON, then run `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm design:colors`.
2. Update the corresponding Framer styles by their IDs through the Framer skill.
   Updating a style updates every linked App Screens instance automatically.
3. Run `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm design:colors:check`.
   This is an optional maintenance check; desktop and web builds do not run it.
4. Export `await framer.getColorStyles()` to a temporary JSON file through the
   current Framer session, then verify it offline with
   `node tools/design-colors.mjs --check --framer-styles /tmp/framer-colors.json`.
5. Review the app in both themes and compare the affected Framer screens.

Framer edits do not automatically write into the repository. Always update both
sides and run the comparison check. Color styles are reusable across the project,
but this migration only rewired App Screens, preserving the other design pages.
