# Kenari Dock Design System

A design system for the dock surface: the floating Kenari usage card rendered over the chat body from the `conversation.session.header.utilities` host slot.

## Current Status

Implemented as a single React component (`src/client/KenariDock.tsx`, ~1000 lines) with inline styles. All sections (KUOTA PAKET, RINGKASAN, PENGGUNAAN 30 HARI, PENGGUNAAN HARI INI), drag, 4-edge resize, collapse, polling, and the auth-error card are live. No separate CSS layer exists.

## Goals

1. One self-contained component that never imports host modules or CSS — the client bundle stays react + `@deepseek-ai/*` externals only.
2. Card chrome (position/size/collapse) persists across sessions via `localStorage` without server support.
3. Numbers read at a glance: dot-separated rupiah (`Rp 136.861`), compact tokens (`rb`/`jt`/`M`), `tabular-nums` alignment, percentage inline to the right of each usage bar.

## Architecture

| Layer | Location | Purpose |
|-------|----------|---------|
| Styling / CSS | inline `CSSProperties` objects in `src/client/KenariDock.tsx` | tokens + section styles; loads with the component, no CSS files |
| Scripts / JS | `src/client/api.ts` (fetch), drag/resize pointer handlers + baseline-diff helpers in `src/client/KenariDock.tsx` | data + interaction logic |
| Components | `src/client/KenariDock.tsx` (registered from `src/client/index.ts`) | the only component; mounted as slot id `kenari-usage-dock` (order 20) |

## Component Rules

1. All styling is inline `CSSProperties`; shared colors/sizes must be module-level constants (`METER_FILL_COLOR`, `CARD_WIDTH_MIN`, …), never magic numbers scattered in JSX.
2. New numeric displays use the existing helpers — `formatInt`, `formatRpId`, `formatCompact`, `formatResetCountdown`, `usedFrac` — and render with `tabular-nums`; do not re-implement formatting inline.
3. Interaction handlers must be pointer-event based with clamping (`clampCardWidth`/`clampCardHeight`) and persist through the `save*` helpers only.
4. The component fetches same-origin only (`fetchDock` in `src/client/api.ts`); no credentials, no secrets, no cross-origin URLs, no host-module imports.
5. Animations that need `@keyframes` (inline styles cannot express them) are injected once into a `<style id="kenari-usage-dock-styles">` by `ensureDockStyles()` in `src/client/KenariDock.tsx`, and the animated element opts in via a class (`.kenari-dock-spin`); honor `prefers-reduced-motion` inside that stylesheet.

## Known Exceptions

- The legacy DOM panel `src/panel.ts` keeps its own (minimal) styling and is unmounted — do not use it as a styling reference; it survives only for tests.
- Meter fill is a fixed amber (`#e3a53d`) rather than theme-derived — intentional, to keep the quota bar readable over both shell themes.

See also:

- Component behavior and data flow: [../../features/02-usage-dock-ui.md](../../features/02-usage-dock-ui.md)
