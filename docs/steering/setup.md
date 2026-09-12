# Setup & Running

How to run, debug, and work on this project locally.

## Prerequisites

- Node.js with ES2022 support (Node 18+; the dev machine runs Windows/Laragon).
- pnpm ≥ 10 (git-hosted installs need build-script approval — see below).
- The DSH harness CLI (`dsh`) with a `web` profile for end-to-end runs.
- No database, no external services besides https://kenari.id.

## Install & Configure

1. `pnpm install`
2. Configure the API key by overriding the plugin row in the **profile's** `cordis.patch.yml`:

   ```yaml
   - id: kenari-usage
     config:
       apiKey: 'PASTE_KN_KEY_HERE'   # secret — never share/commit this file
       pollIntervalSecs: 0           # dock poll cadence in seconds; host floors at 60
   ```

3. pnpm ≥ 10 build-script approval (first `dsh plugin add` from GitHub): copy the package key pnpm prints into that profile's `pnpm-workspace.yaml`:

   ```yaml
   allowBuilds:
     dsh-kenari-usage: true
   ```

4. No migrations or seed data (no database).

## Run

- Build both halves: `pnpm build` (also runs via `prepare`).
- Typecheck: `pnpm typecheck` (tsc `--noEmit`).
- Tests: `pnpm test` (vitest run; 5 files, ~39 tests). Focused: `npx vitest run src/route.test.ts`.
- End-to-end: `dsh plugin --profile web add /path/to/kenari-usage-dh-plugin` (or `github:azmirizkifar20/DSH-Kenari-Usage`), then **restart `dsh web`** — the client module table is scanned at boot, so a restart is required after every install/rebuild for the dock to appear.
- **After a push** (standard workflow, also wired into `AGENTS.md`/`CLAUDE.md`): re-add the plugin from the just-pushed source — `dsh plugin --profile web add github:azmirizkifar20/DSH-Kenari-Usage` (run `dsh plugin --profile web remove dsh-kenari-usage` first if the add reports it already exists) — then restart `dsh web`.

## Debug

- Host: `apply` logs `[kenari-usage] plugin loaded!` to the harness console. Upstream failures surface as `{ok: false, error, retryable}` from the route and as tool error text — the messages name the cause (401 invalid key, 403 shared key, timeout, malformed JSON).
- Route smoke test: `curl http://127.0.0.1:<dsh-web-port>/dsh-kenari-usage` (same-origin contract; 502 body tells you why).
- Client: browser DevTools in the `dsh web` window — check `window.__ModuleLoader__` loaded id `dsh-kenari-usage`, the `/dsh-kenari-usage` network calls, and `localStorage` keys (`kenari-usage-dock-position`, `kenari-usage-dock-width`, `kenari-usage-dock-height`, `kenari-usage-day-baseline`).
- Common issues: dock missing after rebuild → restart `dsh web`; "invalid API key (401)" → create a fresh `kn-` key in the Kenari dashboard and update `apiKey`; "shared key not allowed (403)" → use a personal key; `prepare` script blocked → `allowBuilds` above.

## DB / Tooling Access

- No database. The only persistent stores are the profile's `cordis.patch.yml` (config, secret) and browser `localStorage` (dock layout + day baseline).
