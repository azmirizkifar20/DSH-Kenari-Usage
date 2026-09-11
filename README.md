# dsh-kenari-usage

A DeepSeek Harness plugin that shows **Kenari provider usage** — weekly and monthly consumption as percentages plus reset countdowns.

-   📊 **Weekly + monthly usage** — reads the Kenari `/subscription` endpoint (`window_week` / `window_month`): `used_frac` rendered as a percentage and `resets_in_secs` as a human countdown
-   📌 **Floating usage card** — a Kenari Usage card (`◷ Kenari Usage`, rows Week/Month with reset date + **used** % + usage bar + Refresh) floating bottom-right over the chat body (default level with the composer; drag the header to reposition anywhere, position persists in `localStorage`; chevron collapses/expands), auto-polling every 60s, no prompt needed
-   🛠️ **Model tool** — `kenari_usage`, so the agent can query usage on demand
-   🔑 **Session cookie auth** — sends your `kn_session` value (configured in the profile patch) as an explicit `Cookie:` header; nothing else leaves your machine
-   🖥️ **Web UI** — floating card (draggable, collapsible, usage bars). The framework-free DOM panel in `src/panel.ts` is legacy/unmounted, kept only for tests.
-   ✅ **Tests** — vitest, 24 tests (format/parse + mocked tool integration + legacy panel behavior)

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

The endpoint is resolved from plugin config (override without code edits). Authentication uses an explicit session cookie: copy the `kn_session` value from your logged-in Kenari browser session (DevTools → Application → Cookies → `kenari.id`) and set it as `sessionCookie`. Without it the tool returns a "not configured" error without fetching.

Override the plugin row in the profile's `cordis.patch.yml` to configure (note: a patch replaces the row's whole `config`, so restate `endpoint` too):

```yaml
- id: kenari-usage
  config:
    endpoint: https://kenari.id/api/subscription  # Kenari subscription endpoint
    sessionCookie: 'PASTE_KN_SESSION_VALUE_HERE'   # secret — plaintext in this file, never share/commit it
    cookieName: kn_session                         # optional, defaults to kn_session
    pollIntervalSecs: 0                            # dock auto-poll cadence in seconds; host clamps to min 60 (0 = default 60s)
```

When the cookie expires (HTTP 401), open Kenari in the browser to refresh the session, paste the new `kn_session` value, and restart `dsh web`.

## Web UI

-   **Floating usage card** — `◷ Kenari Usage ⌄ … ⟳` header over `Week Fri, Sep 11, 1:20 AM … 89%` / `Month … … 79%` meter rows (used quota, whole percent, plus a usage bar), floating over the chat body (registered in the `conversation.session.header.utilities` slot, surfaced as a floating card positioned by CSS since the host has no dedicated body slot), no prompt needed. Drag the header to reposition anywhere on screen — the position persists in `localStorage`. Click the chevron to collapse/expand. Auto-polls the same-origin `GET /dsh-kenari-usage` every 60s; manual Refresh (disabled while fetching, debounced 1000ms, aborts the prior request) forces `?refresh=1`.
-   **Expired session** — on 401 the dock shows a refresh-cookie error card, keeps the last known data dimmed, and offers Retry (no retry loop).
-   **Countdown display** — computed once per fetch and ticked locally each second for display only; the tool-call card (`presentCall`/`presentResult`) still works via prompt as before.

## Model tool

The agent can call `kenari_usage`:

-   no arguments: weekly + monthly usage (percentages + reset countdowns)
-   `window`: `week` / `month` to scope the display to one window (execute always returns both)

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
├── kenari-usage.ts  # host half: Config, defineTool kenari_usage, GET /dsh-kenari-usage route
├── format.ts        # pure shared logic: parseSubscription, formatPercent, formatCountdown, formatUsage
├── panel.ts         # legacy framework-free DOM panel (unmounted; kept for tests)
├── client/
│   ├── index.ts     # browser half: registers conversation.session.header.utilities
│   ├── api.ts       # same-origin fetch to /dsh-kenari-usage + payload types
│   └── KenariDock.tsx  # dock component (auto-poll 60s + Refresh + error card)
├── format.test.ts   # unit tests: percent, countdown, edges
├── tool.test.ts     # tool integration tests with mocked fetch
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

-   **Week/month only** — other `/subscription` fields (plan name, micro-IDR balances, free tier, web search, coupons, perks) are parsed past but intentionally never rendered in v1.
-   **Auto-poll, dock only** — the dock refetches every 60s (host-suggested `pollIntervalMs`, floored at 60s even when `pollIntervalSecs` is 0); the chat tool path never polls. No WebSocket/SSE.
-   **Single formatting path** — the tool and the host route share `formatUsage` (host-side); the dock re-derives its used-% and reset-date display client-side from the raw `used_frac` / `serverTime + resets_in_secs` numbers (host and client bundle separately).

## Security

The fetch sends the configured `sessionCookie` as an explicit `Cookie:` header from the harness host (Node), so Kenari CORS headers don't apply to the tool path. The cookie value lives only in your profile's `cordis.patch.yml` — it is never bundled into `dist/`, never written to logs, and never committed to this repo. Treat that file as secret: don't share or commit it, and rotate the value if exposed. As with any third-party plugin, review the source before installing.
