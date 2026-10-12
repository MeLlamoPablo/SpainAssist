# Reusable Framer app screens

The Framer project **Spain Assist** has a canvas component, **App/Screen**, for the
30 desktop states on **App Screens**. Insert it from Assets and choose the screen with its
**Variant** control. It is an editable 1280 × 820 composition with Spanish copy and mock data.
Use Framer's scale tool to reduce the complete composition for a landing-page visual; changing
its width alone does not scale the fixed-size screen content.

The phone app (`apps/mobile`, Spain Assist) has its own component, **Firma/Screen**,
for 15 states at 411 × 914 (the emulator screen in dp). Its frames are named «Móvil · …» and sit
in a row below the desktop frames. They are built from the **Firma** folder (status bar,
banner, buttons, text field, card illustration), which follows `shared/.../ui` (Material 3,
Roboto).

App Screens keeps one named 1280 × 820 frame per state. Each frame contains an App/Screen
instance. The component's primary variant holds the state compositions; replica variants
select which composition is visible. Change shared structure in the primary variant rather
than detaching or rebuilding the instances. These are design snapshots, not an interactive
or embedded desktop app.

## Shared UI

The **App** folder in Assets also contains canvas components corresponding to renderer UI:

| Framer group | App source |
| --- | --- |
| Brand | `components/brand.tsx` |
| Shell, Navigation | `features/shell`, `features/vault/VaultView.tsx` |
| Chat | `features/chat` |
| Buttons, Controls | `components/ui/button.tsx`, `components/ui/controls.tsx` |
| Procedures, Prompts | `features/procedures`, `features/chat/prompts` |
| Vault, Privacy | `features/vault` |
| Settings | `features/settings` |
| Onboarding | `features/onboarding` |

Repeated panels, headers, composers, procedure events, buttons, cards, tabs and privacy notes
use shared instances. Button components expose label and icon controls where applicable.
The existing color tokens remain shared with the app; see [DESIGN_COLORS.md](DESIGN_COLORS.md).
Some presentations remain separate components because their existing geometry differs.

## Updating screens

- Inspect the live component and its controls before editing. Preserve users' canvas edits.
- Update a shared component once when the corresponding app UI changes, then inspect all
  affected screen variants. Do not replace instances with detached copies.
- For a new state, add its composition to the App/Screen primary variant, create a replica
  variant, hide the default composition and show the new one there, and add an instance in
  a named App Screens frame. Use mock data only.
- Keep the source design pages and landing page outside a screen-sync task's edit scope.
- Capture the affected Framer frames and compare them with the offline web preview at
  1280 × 820. Also compare before/after captures for a component-only refactor.
- Do not publish unless asked.

Framer components and React components are separate implementations. Updating one does not
update the other automatically. Throwaway synchronization and capture scripts belong in the
job's temporary directory, not the repository.
