# Usage Dock UI (Client Half)

## 1) What This Feature Is

A React floating card rendered over the chat body and registered into the host slot `conversation.session.header.utilities` (top-right header utilities). It shows plan quota (KUOTA PAKET), aggregate stat boxes (RINGKASAN), 30-day per-model usage (PENGGUNAAN 30 HARI), and today's usage (PENGGUNAAN HARI INI, derived client-side). The card is draggable anywhere on screen, resizable from all four edges, collapsible, and auto-polls the host route — no prompt needed. It displays no saldo/balance information.

- Slot registration: [src/client/index.ts](../../src/client/index.ts)
- Component: [src/client/KenariDock.tsx](../../src/client/KenariDock.tsx)
- Same-origin fetch + payload types: [src/client/api.ts](../../src/client/api.ts)
- Styling conventions: [../design-system/dock/README.md](../design-system/dock/README.md)

## 2) Flow / Behavior

1. **Boot**: the shell's module loader loads `dist/client.js` (esbuild CJS bundle wrapped in `window.__ModuleLoader__.load`, id `dsh-kenari-usage`). `apply(ctx)` in `src/client/index.ts` calls `ctx.slots.inject('conversation.session.header.utilities', …)`; once the host declares the slot, `slots.register({name, id: 'kenari-usage-dock', order: 20, label: 'Kenari usage dock'}, KenariDock)` mounts the card and returns the disposer.
2. **Data**: `fetchDock(refresh?, signal?)` → same-origin `GET /dsh-kenari-usage` (`cache: 'no-store'`). Initial fetch on mount, then `setInterval` polling at the payload-suggested `pollIntervalMs` (fallback `DEFAULT_POLL_INTERVAL_MS = 6000`).
3. **Manual Refresh**: debounced 1000ms (`REFRESH_DEBOUNCE_MS`), aborts the prior in-flight request via `AbortController`, forces `?refresh=1`; the button is disabled while fetching and the `⟳` glyph swaps to a spinning-arc SVG indicator (animated by the once-injected `kenari-dock-spin` keyframes; slowed under `prefers-reduced-motion`, `aria-busy` set while in flight).
4. **Rendering** (top to bottom): header (`K` glyph + "Kenari" + plan name, chevron collapse, Refresh) over KUOTA PAKET (per-window `Terpakai Rp X · Sisa Rp Y` line, live reset countdown `reset dalam 1h 18j`, and a thin usage bar with the percentage inline to the right), RINGKASAN stat boxes (total request/token), PENGGUNAAN 30 HARI (inline header total `<n> req · <compact> tok`; per-model rows `<n> req · <total> tok` — total tokens only, no in/out split), and PENGGUNAAN HARI INI (inline header total when non-empty; empty state "Belum ada pemakaian hari ini").
5. **Manipulation**: drag the header to reposition anywhere (position persists); resize from all four edges — left/right adjust width, top/bottom adjust height (double-click a top/bottom edge resets height); chevron collapses/expands.

## 3) Domain & Data (client-side)

- Types mirror the route contract exactly: `DockPayload` / `DockFailure` / `DockWindow` / `DockModelUsage` / `DockUsage` in `src/client/api.ts` (including `serverTime` and `pollIntervalMs`).
- **Today usage** (PENGGUNAAN HARI INI): diff of the 30-day payload against a start-of-day baseline snapshot in `localStorage` key `kenari-usage-day-baseline` (`{date: localDayStamp, perModel: {model: {requests, tokens}}}`). The first payload of a new day becomes the baseline; diffs clamp negatives to 0; today rows are models with requests > 0 sorted by today tokens desc. Limitation (footnoted in the dock): counts only usage since the card first opened today — earlier usage is not recorded. The server has no daily endpoint; the host and client bundle separately, so the baseline lives client-side.
- **Persistence keys**: `kenari-usage-dock-position` (dragged position), `kenari-usage-dock-width` (200–520), `kenari-usage-dock-height` (160–800, clamped to `window.innerHeight - 32`, cleared on double-click reset).
- **Formatting helpers** (client-local — the client bundle cannot import host modules): `formatInt` (Indonesian dot separators, `3527` → `3.527`), `formatRpId` (`Rp 136.861`), `formatCompact` (`rb`/`jt`/`M` with one decimal, trailing `.0` trimmed), `formatResetCountdown` (`1h 18j` hari/jam, `3j 45m`, live against the clock so the 1s tick keeps it current), `usedFrac` (used/(used+remaining)).

## 4) UI

- Single component `KenariDock` in `src/client/KenariDock.tsx`; no router, no external UI framework beyond React 18 (provided by the shell as an external).
- All styling is inline `CSSProperties` objects; color/size tokens are module constants — see [../design-system/dock/README.md](../design-system/dock/README.md).
- Numbers use `tabular-nums` so totals and percentages align in rows.

## 5) Edge Cases & Rules

- **Auth errors**: on 401/403 (HTTP-level `fetchDock` throw) the dock renders an error card, keeps the last known data dimmed, and offers Retry (manual, no auto-retry loop).
- **Same-origin only**: every request goes to `/dsh-kenari-usage`; no credentials attached, no secrets in the client bundle, no cross-origin requests, no host-module imports (`react` and `@deepseek-ai/*` resolve as shell-provided externals).
- **No saldo/balance anywhere** in the dock.
- **Polling is dock-only**: the chat tool path never polls; there is no WebSocket/SSE.

## Related Files

- `src/client/index.ts` — module identity (`kenari-usage-client`), slot inject/register
- `src/client/KenariDock.tsx` — the dock component (layout, drag/resize/collapse, polling, today-usage diff)
- `src/client/api.ts` — `fetchDock` + payload/failure types
- `build.mjs` — client bundle (`dist/client.js`)

## Cross-References

- System flow: [../steering/system-flow.md](../steering/system-flow.md)
- Architecture (host/client boundary): [../steering/architecture.md](../steering/architecture.md)
- Design system: [../design-system/dock/README.md](../design-system/dock/README.md)
- Data source (host half): [./01-kenari-usage-tool.md](./01-kenari-usage-tool.md)
