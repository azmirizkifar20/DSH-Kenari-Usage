# dsh-kenari-usage

A DeepSeek Harness plugin that shows **Kenari provider usage** — weekly and monthly consumption as percentages plus reset countdowns.

-   📊 **Weekly + monthly usage** — reads the Kenari `/subscription` endpoint (`window_week` / `window_month`): `used_frac` rendered as a percentage and `resets_in_secs` as a human countdown
-   🖥️ **Panel UI** — a framework-free DOM panel with manual Refresh (`[data-testid="kenari-refresh"]`), debounced, abort-safe, with error card + dimmed last data + Retry on 401/offline
-   🛠️ **Model tool** — `kenari_usage`, so the agent can query usage on demand
-   🔑 **Session cookie auth** — sends your `kn_session` value (configured in the profile patch) as an explicit `Cookie:` header; nothing else leaves your machine
-   ✅ **Tests** — vitest unit tests (format/parse) + mocked tool integration tests

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

The endpoint is resolved from plugin config (override without code edits — HMR picks it up). Authentication uses an explicit session cookie: copy the `kn_session` value from your logged-in Kenari browser session (DevTools → Application → Cookies → `kenari.id`) and set it as `sessionCookie`. Without it the tool returns a "not configured" error without fetching.

Override the plugin row in the profile's `cordis.patch.yml` to configure (note: a patch replaces the row's whole `config`, so restate `endpoint` too):

```yaml
- id: kenari-usage
  config:
    endpoint: https://kenari.id/api/subscription  # Kenari subscription endpoint
    sessionCookie: 'PASTE_KN_SESSION_VALUE_HERE'   # secret — plaintext in this file, never share/commit it
    cookieName: kn_session                         # optional, defaults to kn_session
    pollIntervalSecs: 0                            # 0 = off (manual Refresh only), min 60 if enabled
```

When the cookie expires (HTTP 401), open Kenari in the browser to refresh the session, paste the new `kn_session` value, and restart `dsh web`.

## Web UI

-   **Usage panel** — weekly percent + reset countdown · monthly percent + reset countdown, with a manual Refresh button (disabled while fetching, debounced 1000ms, aborts the prior request).
-   **Expired session** — on 401 the panel shows a refresh-cookie error card, keeps the last known data dimmed, and offers Retry (no retry loop).
-   **Countdown display** — computed once per fetch and ticked locally for display only; the plugin never polls the endpoint on its own (`pollIntervalSecs` defaults to 0).

> Slot note: this plugin renders its card through the tool result (`presentCall`/`presentResult`) and ships a framework-free DOM panel (`src/panel.ts`, `createKenariPanel(root, load)`) mountable into any host-provided slot element — the `conversation.composer.dock` / `settings.section` seats from other plugins are not assumed.

## Model tool

The agent can call `kenari_usage`:

-   no arguments: weekly + monthly usage (percentages + reset countdowns)
-   `window`: `week` / `month` to scope the display to one window (execute always returns both)

## Development

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest unit tests (format + tool, mocked fetch)
pnpm build       # tsc → dist/ (host entry + shared formatter + panel)
```

### Structure

```text
src/
├── kenari-usage.ts  # host half: Config, defineTool kenari_usage, fetch + render + cards
├── format.ts        # pure shared logic: parseSubscription, formatPercent, formatCountdown, formatUsage
├── panel.ts         # framework-free DOM panel (thin wrapper over formatUsage)
├── format.test.ts   # unit tests: percent, countdown, edges
├── tool.test.ts     # tool integration tests with mocked fetch
└── panel.test.ts    # panel behavior tests with mocked DOM
cordis.yml          # local dev patch (points at dist/)
cordis.patch.yml    # bundle patch manifest (package name)
```

### Build notes

-   `tsc` compiles `src/` to `dist/`; the local `cordis.yml` patch points at the **built** `dist/kenari-usage.js` (Node ESM cannot resolve the TS sibling `./format.js` from source).
-   `@deepseek-ai/cordis` is a peer dependency; `@deepseek-ai/dsh-tools` / `dsh-llm` are pinned via `pnpm.overrides` to a coherent `0.1.0-rc.8` tree (caret rc ranges otherwise resolve across rc lines).
-   Tool render/card functions (`output.render`, `presentResult`, `presentationMeta`) are pure — no I/O, clock, or random — so they replay safely.

## Scope notes

-   **Week/month only** — other `/subscription` fields (plan name, micro-IDR balances, free tier, web search, coupons, perks) are parsed past but intentionally never rendered in v1.
-   **No live polling** — no `setInterval` fetching, no WebSocket/SSE; `pollIntervalSecs` defaults to 0 (off) with a 60s floor if ever enabled.
-   **Single formatting path** — the tool and the panel share `formatUsage`; there is deliberately no second formatting implementation to drift.

## Security

The fetch sends the configured `sessionCookie` as an explicit `Cookie:` header from the harness host (Node), so Kenari CORS headers don't apply to the tool path. The cookie value lives only in your profile's `cordis.patch.yml` — it is never bundled into `dist/`, never written to logs, and never committed to this repo. Treat that file as secret: don't share or commit it, and rotate the value if exposed. As with any third-party plugin, review the source before installing.
