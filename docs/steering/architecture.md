# System Architecture

## Overview

A dual-half DSH plugin. The **host half** (Node/TypeScript, tsc-compiled to `dist/kenari-usage.js`) owns all secrets and upstream I/O; the **client half** (React, esbuild-bundled to `dist/client.js`) renders the floating dock and talks only to the host route. The halves communicate exclusively over same-origin HTTP (`GET /dsh-kenari-usage`) — the client bundle physically cannot import host modules because they are built and loaded separately.

## Architecture Diagram

```
┌─ dsh web host (Node, cordis) ──────────────────────────────┐
│  apply() src/kenari-usage.ts                               │
│    ├─ kenari_usage tool ──► loadQuotaUsage ──► quota.ts    │
│    │     (presentCall/presentResult cards, pure render)    │
│    └─ GET /dsh-kenari-usage route ──► loadQuotaUsage       │
│                │                                            │
│                ▼  Bearer kn-… (secrets stay here)          │
│      https://kenari.id/v1/account/quota                    │
│      https://kenari.id/mcp  (tools/call kenari_usage)      │
└──────────────┬─────────────────────────────────────────────┘
               │ same-origin GET /dsh-kenari-usage (JSON, no-store)
┌─ browser (shell) ─┴────────────────────────────────────────┐
│  dist/client.js (window.__ModuleLoader__, id kenari-usage) │
│   src/client/index.ts → slots.inject('…header.utilities')  │
│   src/client/api.ts → fetchDock()                          │
│   src/client/KenariDock.tsx → floating card + localStorage │
└─────────────────────────────────────────────────────────────┘
```

## Layers & Boundaries

- **Presentation / API layer**: `src/kenari-usage.ts` — tool definition (`parameters`, `output.render`, `presentationMeta`, `presentCall`, `presentResult`) and the route handler `handleUsageRequest`. Pure render functions; no I/O in render paths.
- **Application / orchestration layer**: `loadQuotaUsage`, `fetchQuota`, `fetchModelUsage`, `installUsageRoute` in `src/kenari-usage.ts` — retry/timeouts, retryability classification, best-effort degradation.
- **Domain layer**: `src/quota.ts` — pure strict parsers (`parseQuota`, `parseUsageMarkdown`) and formatters (`formatRp`, `formatCompactId`, `formatResetShort`, `usedFracWindow`). No I/O, no clock, no random.
- **Infrastructure layer**: `fetchBearerOnce` (per-attempt 8s timeout + caller-abort plumbing), `parseMcpRpcPayload`/`unwrapMcpText` (MCP/SSE framing), native `fetch`. Client side: `src/client/api.ts` (fetch + contract types), `src/client/KenariDock.tsx` (UI + localStorage persistence).
- **Dependency direction**: host layers point inward (`kenari-usage.ts` → `quota.ts`); client points outward to HTTP only (`KenariDock.tsx` → `api.ts` → host route). Neither half imports the other; `react`/`@deepseek-ai/*` are shell-provided externals in the client bundle.

## Key Components

| Component | Responsibility | Key Files |
|-----------|----------------|-----------|
| `kenari_usage` tool | Agent-facing usage query; pure text/card render | `src/kenari-usage.ts`, `src/quota.ts` |
| `GET /dsh-kenari-usage` route | Dock payload (JSON, no-store, no secrets) | `src/kenari-usage.ts` |
| Quota parsers/formatters | Strict upstream → typed domain; all display math | `src/quota.ts` |
| Client slot registration | Mounts the dock into `conversation.session.header.utilities` | `src/client/index.ts` |
| `KenariDock` component | Floating card: layout, drag/4-edge resize/collapse, polling, today-usage diff | `src/client/KenariDock.tsx` |
| `fetchDock` | Same-origin fetch + payload/failure types | `src/client/api.ts` |
| `build.mjs` | Dual build: tsc host emit + esbuild client CJS bundle | `build.mjs` |

## Cross-Module Communication

- Host ↔ client: HTTP only — same-origin `GET /dsh-kenari-usage`, JSON contract documented in [api-conventions.md](./api-conventions.md) and mirrored by `DockPayload`/`DockFailure` in `src/client/api.ts`.
- Host ↔ Kenari: Bearer `Authorization` header (quota) + JSON-RPC `tools/call` (MCP usage), with SSE-tolerant response parsing.
- No events, queues, or message brokers. Host-side services are consumed through structural mirrors (`UsageWebServer` in `src/kenari-usage.ts`, `DockSlotsService` in `src/client/index.ts`) rather than direct imports.

## Data Flow

1. Kenari upstream → host `fetchQuota`/`fetchModelUsage` → strict parse into `ParsedQuota`/`ParsedModelUsage`.
2. Host route → JSON payload (aggregates + precomputed fields only, `serverTime`, `pollIntervalMs`).
3. Client state → React render → `localStorage` (position/width/height + start-of-day baseline for PENGGUNAAN HARI INI).
4. Today usage never touches the server: the client diffs each 30-day payload against its `kenari-usage-day-baseline` snapshot.

## Concurrency & Multi-Tenancy Notes

- No tenants; single-user local harness.
- The tool is concurrency-safe (`isConcurrencySafe: () => true`); the route fetches fresh per request under a 30s outer abort budget, with ≤2 upstream attempts of 8s each.
- Client-side requests are abortable and superseded responses are discarded (`inFlight !== ctrl` guard in `KenariDock`); manual refresh is debounced 1000ms.
