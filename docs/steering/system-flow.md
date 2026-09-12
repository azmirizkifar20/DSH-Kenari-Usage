# System Flow

How the plugin boots, initializes, and routes requests at runtime. This is the starting point for tracing any feature end-to-end.

## Bootstrap & Entry Points

- **Host bootstrap**: `dsh web` boots the cordis harness, which loads this plugin per the profile's `cordis.patch.yml` (package mode) or `cordis.yml` (local dev patch pointing at `dist/kenari-usage.js` via a `file://` URL). The plugin body is `apply(ctx, config)` in `src/kenari-usage.ts` — it registers the `kenari_usage` tool, installs the `/dsh-kenari-usage` route, and logs `[kenari-usage] plugin loaded!`.
- **Client bootstrap**: at boot the shell scans the client module table and loads `dist/client.js` — an esbuild browser-CJS bundle wrapped in `window.__ModuleLoader__.load({id: "dsh-kenari-usage", …})` (see `build.mjs`). The plugin body is `apply(ctx)` in `src/client/index.ts`.
- **Build**: `build.mjs` runs first (`tsc -p tsconfig.json` for the host, then esbuild for the client) — `pnpm build` or the `prepare` script.
- No standalone server process, queue workers, or cron jobs of its own; no startup DB connections (there is no database).

## Request Lifecycle

**Tool path** (agent-initiated):

1. The agent invokes `kenari_usage` → `execute` in `src/kenari-usage.ts`.
2. Guard: `hasApiKey()` — without a configured key it returns `{error: "…not configured…", retryable: false}` without fetching.
3. `loadQuotaUsage` → `fetchQuota` (`GET /v1/account/quota`, Bearer auth, ≤2 attempts × 8s timeout) then `fetchModelUsage` (`POST /mcp`, `tools/call kenari_usage`, best-effort).
4. `parseQuota` / `parseUsageMarkdown` in `src/quota.ts` turn raw responses into the strict `ParsedQuota` / `ParsedModelUsage` shapes.
5. `output.render` → `formatQuotaText` (plain text) and `presentationMeta` (`{ok, window, plan, hasUsage}`); `presentCall`/`presentResult` shape the generic card.

**Route path** (browser-initiated):

1. The dock fetches `GET /dsh-kenari-usage?refresh=1` (same-origin) → `handleUsageRequest`.
2. Guards: method must be GET (else 405); `hasApiKey()` (else 502).
3. Same `loadQuotaUsage` as the tool path, under a 30s outer budget (`AbortSignal.timeout(ROUTE_TIMEOUT_MS)`).
4. Success → `200` JSON `{ok: true, plan, coupon, week, month, usage, serverTime, pollIntervalMs}` with `cache-control: no-store`; upstream/shape failure → `502` `{ok: false, error, retryable}`.

**Client mount flow**:

1. `apply(ctx)` → `ctx.slots.inject('conversation.session.header.utilities', …)` — waits for the host to declare the slot.
2. `slots.register({name, id: 'kenari-usage-dock', order: 20}, KenariDock)` → React mounts the floating card.
3. `KenariDock` fetches the dock payload once on mount, then polls on an interval.

## Background / Scheduled Flows

- **Dock auto-poll**: `setInterval` inside `KenariDock` (`src/client/KenariDock.tsx`), cadence = the payload's `pollIntervalMs` (host-suggested, floored at 60s; config `pollIntervalSecs: 0` means the default 60s).
- **Display tick**: a 1s local interval (`DISPLAY_TICK_MS`) updates countdown/relative display text only — it never fetches.
- The chat tool path never polls; there is no WebSocket/SSE.

## Environment & Config

- No `.env` file. All config arrives via the plugin `Config` schema (`src/kenari-usage.ts`): `apiKey` (the `kn-` secret) and `pollIntervalSecs`, set by overriding the plugin row in the profile's `cordis.patch.yml`. Treat that file as secret — never share or commit it.
- Client-side persistence uses `window.localStorage` (see `src/client/KenariDock.tsx`): `kenari-usage-dock-position`, `kenari-usage-dock-width`, `kenari-usage-dock-height`, `kenari-usage-day-baseline`.
- `cordis.yml` is a local dev patch (inserts the plugin from `dist/` via `file://`); its `config.endpoint` value is a legacy leftover ignored by the current `Config` schema.
