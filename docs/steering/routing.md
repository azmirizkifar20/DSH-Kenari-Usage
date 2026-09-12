# Routing Structure

## Overview

This project is a DSH plugin, not a web application — there are no route files. It exposes exactly one host HTTP route, two upstream Kenari endpoints it calls, and one client slot surface.

## Routes

| Method | Path | Kind | Handler | Source |
|--------|------|------|---------|--------|
| GET | `/dsh-kenari-usage` | exact | `handleUsageRequest` | `src/kenari-usage.ts` |

- Registered via the host `webServer` service: `webServer.register({kind: 'exact', path: USAGE_ROUTE_PATH, handler})` inside `installUsageRoute` (`src/kenari-usage.ts`).
- Installation is lazy: if the `webServer` service is not mounted yet, the plugin retries when the `internal/service` event announces it; the disposer is registered through `ctx.effect`.
- No other routes exist. `?refresh=1` is accepted on the route but is a no-op (the handler always fetches fresh).

## Upstream Endpoints (host → Kenari)

| Method | URL | Constant | Purpose |
|--------|-----|----------|---------|
| GET | `https://kenari.id/v1/account/quota` | `QUOTA_URL` | Plan quota (weekly/monthly Rp windows) |
| POST | `https://kenari.id/mcp` | `MCP_URL` | JSON-RPC `tools/call` for `kenari_usage` (30-day per-model usage) |

- Legacy: `https://kenari.id/api/subscription` appears only as `config.endpoint` in `cordis.yml` (local dev patch) and is consumed by the unmounted legacy module `src/format.ts`. The current `Config` schema ignores it.

## Client Surfaces (not URL routes)

- Host slot `conversation.session.header.utilities`, component id `kenari-usage-dock`, order 20 — registered in `src/client/index.ts` via `slots.inject` + `slots.register`.
- All client HTTP traffic is same-origin `GET /dsh-kenari-usage` (`src/client/api.ts`).
