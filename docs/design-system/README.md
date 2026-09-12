# Design System

This folder documents the front-end design system of this plugin: a single UI surface, the floating usage dock.

**Updated**: 2026-09-12 — documented the refresh-spinner convention (once-injected keyframes stylesheet) in the dock module rules.

## Structure

| Folder | Module / Surface | Status |
|--------|------------------|--------|
| [`dock/`](dock/README.md) | Floating Kenari usage card over the chat body (host slot `conversation.session.header.utilities`) | ✅ Active |

Shared building blocks that are not module-scoped live at the top level:

| Doc | Covers |
|-----|--------|
| (none yet) | — |

## Multi-Surface Architecture

There is exactly one UI surface. Its single entry point is the esbuild bundle `dist/client.js` (built from `src/client/index.ts`), which registers one component into the host slot:

```
dist/client.js  (src/client/index.ts)
  └─ KenariDock (src/client/KenariDock.tsx)
       ├─ KUOTA PAKET / RINGKASAN / PENGGUNAAN 30 HARI / PENGGUNAAN HARI INI sections
       └─ localStorage: position, width, height, day-baseline
```

## Modules

- **dock** — directory [`dock/`](dock/README.md). The floating draggable/resizable usage card; all styling is inline `CSSProperties` in one React component.

## Design Tokens (shared)

- **Colors**: module constants in `src/client/KenariDock.tsx` — meter fill `METER_FILL_COLOR` `#e3a53d` (amber), meter track `METER_TRACK_COLOR` `rgba(255,255,255,0.12)`, stat boxes `STAT_BOX_COLOR` `rgba(255,255,255,0.06)`. All other surfaces are translucent overlays so the card inherits the host shell theme; there is no local palette file.
- **Typography**: inherits the host shell fonts; numeric displays use `tabular-nums` so aligned rows (req/tok/% columns) stay aligned.
- **Spacing / Radius / Shadows**: defined inline in `KenariDock.tsx` styles; the only size constants are the card geometry ones (`CARD_WIDTH` 270 default, `CARD_WIDTH_MIN` 200 / `CARD_WIDTH_MAX` 520, `CARD_HEIGHT_MIN` 160 / `CARD_HEIGHT_MAX` 800, default offsets `DEFAULT_CARD_BOTTOM` 100 / `DEFAULT_CARD_RIGHT` 24).
- **Dark mode**: none of its own — translucent `rgba` overlays over the shell mean the dock adapts to the host theme automatically.

## State Management (shared)

- Plain React hooks (`useState`/`useRef`/`useEffect`/`useCallback`) local to `KenariDock`; no external store.
- Server state: the dock payload from `GET /dsh-kenari-usage` (`src/client/api.ts`), polled on an interval; today-usage is derived client-side by diffing the payload against the `kenari-usage-day-baseline` localStorage snapshot.
- Persistence: `localStorage` keys `kenari-usage-dock-position`, `kenari-usage-dock-width`, `kenari-usage-dock-height`, `kenari-usage-day-baseline`.
