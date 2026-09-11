# dsh-kenari-usage

A DeepSeek Harness plugin that shows **Kenari provider usage** — official `kn-` Bearer API quota (weekly/monthly Rp + resets) plus 30-day per-model usage.

-   📊 **Quota + 30-day usage** — official Bearer `GET /v1/account/quota` (`{coupon,plan:{name,windows:{week:{used_rp,remaining_rp,resets_at},month:{...}}}}`) plus MCP `kenari_usage` markdown-table usage (30-day per-model + totals) parsed server-side in `src/quota.ts`
-   📌 **Floating usage card** — a Kenari Usage card (KUOTA PAKET Rp rows + bars, RINGKASAN boxes, PENGGUNAAN 30 HARI list) floating bottom-right over the chat body (drag the header to reposition anywhere, position persists in `localStorage`; chevron collapses/expands), auto-polling every 60s, no prompt needed
-   🛠️ **Model tool** — `kenari_usage`, so the agent can query usage on demand
-   🔑 **API key auth** — sends your `kn-` Bearer key as an explicit `Authorization:` header; nothing else leaves your machine
-   🖥️ **Web UI** — floating card (draggable, collapsible, refresh, KUOTA PAKET / RINGKASAN / 30-day list). The framework-free DOM panel in `src/panel.ts` is legacy/unmounted, kept only for tests.
-   ✅ **Tests** — vitest, ~43 tests (quota parse/format + Bearer tool integration + route contract + legacy panel/format)

## Install

### From GitHub (recommended)

```sh
dsh plugin --profile web add github:azmirizkifar20/DSH-Kenari-Usage
```

⚠️ **First install requires build authorization**: pnpm ≥ 10 refuses to run `prepare` scripts of git-hosted dependencies. If the first `add` fails with a hint, copy the exact package key pnpm prints into that profile's `pnpm-workspace.yaml`, then re-run:

```yaml
allowBuilds:
  dsh-kenari-usage: true
```

Pin a commit for reproducible installs: `dsh plugin --profile web add github:azmirizkifar20/DSH-Kenari-Usage#<sha>`.

### Local directory / tarball

```sh
dsh plugin --profile web add /path/to/DSH-Kenari-Usage   # local dir
dsh plugin --profile web add ./dsh-kenari-usage-0.1.0.tgz  # pnpm pack output
```

**Restart `dsh web`** after installing — the client module table is scanned at boot.

Uninstall:

```sh
dsh plugin --profile web remove dsh-kenari-usage
```

## Configuration

Authentication uses the official `kn-` Bearer API key: paste your Kenari API key and set it as `apiKey` — without it, the tool returns a "not configured" error without fetching.

Override the plugin row in the profile's `cordis.patch.yml` to configure:

```yaml
- id: kenari-usage
  config:
    apiKey: 'PASTE_KN_KEY_HERE'                    # secret — plaintext in this file, never share/commit it
    pollIntervalSecs: 0                            # dock auto-poll cadence in seconds; host clamps to min 60 (0 = default 60s)
```

When the API key is invalid (HTTP 401) or shared (HTTP 403), the tool returns a non-retryable error — paste a fresh key and restart `dsh web`.

## Web UI

-   **Floating usage card** — header (plan name + chevron + Refresh) over three sections: KUOTA PAKET (weekly/monthly Rp rows — used/sisa rupiah + thin usage bar + reset date), RINGKASAN (total request/token stat boxes), PENGGUNAAN 30 HARI (scrollable per-model list), floating over the chat body, no prompt needed. Drag the header to reposition anywhere on screen — the position persists in `localStorage`. Click the chevron to collapse/expand. Auto-polls the same-origin `GET /dsh-kenari-usage` every 60s; manual Refresh (disabled while fetching, debounced 1000ms, aborts the prior request) forces `?refresh=1`.
-   **Auth errors** — on 401/403 the dock shows an invalid-key error card, keeps the last known data dimmed, and offers Retry (no retry loop).
-   **Countdown display** — computed once per fetch and ticked locally each second for display only; the tool-call card (`presentCall`/`presentResult`) still works via prompt as before.
-   **PENGGUNAAN HARI INI** — today usage derived client-side by diffing the 30-day payload against a start-of-day localStorage baseline (`kenari-usage-day-baseline`); footnote limitation: dihitung sejak card pertama dibuka hari ini — pemakaian sebelum itu tidak tercatat.

## Model tool

The agent can call `kenari_usage`:

-   no arguments: quota (weekly/monthly Rp + resets) + 30-day per-model usage with totals
-   `window`: `week` / `month` to scope the quota display to one window (execute always returns both)

## Development

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest unit tests (format + tool, mocked fetch)
pnpm build       # node build.mjs → dist/ (host tsc + client esbuild bundle)
```

### Structure

```text
src/
├── kenari-usage.ts  # host half: Config (apiKey Bearer), defineTool kenari_usage, GET /dsh-kenari-usage route
├── quota.ts         # pure Bearer-API logic: parseQuota, parseUsageMarkdown (MCP usage source), formatRp, formatResetShort
├── format.ts        # legacy pure shared logic: parseSubscription, formatPercent, formatCountdown, formatUsage (unmounted; kept for tests)
├── panel.ts         # legacy framework-free DOM panel (unmounted; kept for tests)
├── client/
│   ├── index.ts     # browser half: registers conversation.session.header.utilities
│   ├── api.ts       # same-origin fetch to /dsh-kenari-usage + payload types
│   └── KenariDock.tsx  # dock component (auto-poll 60s + Refresh + error card)
├── format.test.ts   # unit tests: percent, countdown, edges
├── quota.test.ts    # quota + MCP markdown-table parse/format tests
├── tool.test.ts     # tool integration tests with mocked fetch (Bearer quota+MCP + missing-apiKey)
├── route.test.ts    # GET /dsh-kenari-usage frozen contract tests
└── panel.test.ts    # panel behavior tests with mocked DOM
build.mjs           # dual build: tsc (host) + esbuild browser CJS + __ModuleLoader__ banner
cordis.yml          # local dev patch (points at dist/)
cordis.patch.yml    # bundle patch manifest (package name)
```

### Build notes

-   `build.mjs` runs `tsc -p tsconfig.json` for the host half (`dist/kenari-usage.js` + `format.js`; Node ESM cannot resolve the TS sibling `./format.js` from source), then esbuild-bundles `src/client/index.ts` → `dist/client.js` (browser CJS wrapped in `window.__ModuleLoader__.load`, id `dsh-kenari-usage`; react/react-dom/`@deepseek-ai/*` stay external, resolved by the shell).
-   `package.json` declares `exports` (`./dist/kenari-usage.js`, `./dist/client.js`) + `dsh.client` (`platform: web`, inject runtime/locale/ui-slots) so the shell loads the dock after `dsh plugin add github:`.
-   `@deepseek-ai/cordis` is a peer dependency; `@deepseek-ai/dsh-tools` / `dsh-llm` are pinned via `pnpm.overrides` to a coherent `0.1.0-rc.8` tree (caret rc ranges otherwise resolve across rc lines).
-   Tool render/card functions (`output.render`, `presentResult`, `presentationMeta`) are pure — no I/O, clock, or random — so they replay safely.

## Scope notes

-   **Quota + 30-day usage** — quota comes from the official Bearer `GET /v1/account/quota` (plan name, coupon, weekly/monthly used/remaining Rp + reset timestamps); per-model 30-day usage comes from the MCP `kenari_usage` markdown table, parsed server-side.
-   **Auto-poll, dock only** — the dock refetches every 60s (host-suggested `pollIntervalMs`, floored at 60s even when `pollIntervalSecs` is 0); the chat tool path never polls. No WebSocket/SSE.
-   **Single formatting path** — the tool and the host route share `formatUsage` (host-side); the dock re-derives its used-% and reset-date display client-side from the raw `used_frac` / `serverTime + resets_in_secs` numbers (host and client bundle separately).

## Security

The host sends the configured `apiKey` as an explicit `Authorization: Bearer` header from the harness host (Node) to the official quota/MCP endpoints, so Kenari CORS headers don't apply to the tool path. The key value lives only in your profile's `cordis.patch.yml` — it is never bundled into `dist/`, never written to logs, and never committed to this repo. Treat that file as secret: don't share or commit it, and rotate the value if exposed. As with any third-party plugin, review the source before installing.
