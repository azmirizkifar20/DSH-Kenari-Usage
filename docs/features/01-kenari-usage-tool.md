# Kenari Usage Tool & Host Route (Host Half)

## 1) What This Feature Is

The Node-side half of the `dsh-kenari-usage` plugin. It registers the `kenari_usage` model tool (so the agent can query Kenari usage on demand) and serves the same-origin HTTP route `GET /dsh-kenari-usage` that feeds the browser dock. Both surfaces share one data path: the official Kenari Bearer API for plan quota (weekly/monthly Rp windows + resets) plus the Kenari MCP server for 30-day per-model usage. No saldo/balance data is fetched or exposed — `balance_rp` was deliberately removed from the payload, the output schema, and the tool text.

- Entry/plugin body: [src/kenari-usage.ts](../../src/kenari-usage.ts)
- Parsers & formatters: [src/quota.ts](../../src/quota.ts)
- Tool integration tests: [src/tool.test.ts](../../src/tool.test.ts)
- Route contract tests: [src/route.test.ts](../../src/route.test.ts)
- Parser tests: [src/quota.test.ts](../../src/quota.test.ts)

## 2) Flow / Behavior

**Plugin bootstrap** — `apply(ctx, config)` in `src/kenari-usage.ts`:

1. Stores config (`apiKey`, `pollIntervalSecs`) in module state.
2. Registers the `kenari_usage` tool via `ctx.tools.register`.
3. `installUsageRoute` lazily looks up the host `webServer` service and registers the exact route `/dsh-kenari-usage`; it retries when the `internal/service` event announces `webServer`, and disposes the route via `ctx.effect`.

**Tool execute** — `kenari_usage` → `loadQuotaUsage`:

1. `fetchQuota`: `GET https://kenari.id/v1/account/quota` (`QUOTA_URL`) with `Authorization: Bearer <apiKey>`, 8s per-attempt timeout, 2 attempts. HTTP 401 → non-retryable "invalid API key (401)"; 403 → non-retryable "shared key not allowed (403)"; other 4xx → non-retryable; 5xx/network → retryable after the second attempt. Response JSON is strictly parsed by `parseQuota`.
2. `fetchModelUsage` (best-effort): `POST https://kenari.id/mcp` (`MCP_URL`) JSON-RPC `tools/call` for `kenari_usage`; `parseMcpRpcPayload` tolerates plain JSON or SSE `data:` framing, `unwrapMcpText` extracts `result.content[0].text`, and `parseUsageMarkdown` parses the markdown table. On any failure here, `usage` becomes `null` and quota-only success is still returned.
3. Output render: `formatQuotaText` produces plain text (`Week used Rp 143239 / remaining Rp 9761 (resets 13 Sep 20:30); ...` — `formatRp` has no thousand separators; only the dock localizes). `presentationMeta` reports `{ok, window, plan, hasUsage}` or `{ok: false, window, error, retryable}`.

**Route** — `GET /dsh-kenari-usage` → `handleUsageRequest`:

1. Non-GET → `405` with `{ok: false, error, retryable: false}`.
2. Missing/empty `apiKey` → `502` "Kenari apiKey is not configured…".
3. Upstream failure → `502` `{ok: false, error, retryable}` (30s outer budget via `AbortSignal.timeout`).
4. Success → `200` `{ok: true, plan, coupon, week, month, usage, serverTime, pollIntervalMs}`. `pollIntervalMs = pollIntervalSecs * 1000` floored at `60000` (min 60s cadence). Fresh fetch per request (no caching); `?refresh=1` is accepted as a no-op.

## 3) Domain & Data

- `QuotaWindow {used_rp, remaining_rp, resets_at}` (raw rupiah integers, ISO reset timestamp); `ParsedQuota {plan, coupon, week, month}` with `null` for missing windows.
- `ModelUsage {model, requests, input_tok, output_tok}`; `parseUsageMarkdown` sorts models by total tokens (input+output) desc and computes `total_requests` / `total_tokens`.
- `parseQuota` tolerates three upstream shapes: `{plan: {name, windows: {week, month}}}` (live shape), `{plan: "Name", windows: {...}}`, and a flat `{week, month}` object.
- Tool output schema (`outputSchema`): `oneOf` success `{quota, usage}` vs error `{error, retryable}`; `additionalProperties: false` throughout.
- `presentResult` titles: "Kenari usage — re-login required" when the error matches 401/invalid-key, otherwise "Kenari usage" / "Kenari usage — error".

## 4) UI

- No host-side UI. The tool result renders as a generic card (`presentCall` title "Check Kenari usage", optional `(week)`/`(month)` scope suffix; `kind: 'fetch'`).
- The browser surface consuming this data is documented in [02-usage-dock-ui.md](./02-usage-dock-ui.md).

## 5) Edge Cases & Rules

- **No saldo/balance**: the payload, output schema, and tool text carry no balance fields — the saldo removal was a deliberate breaking change (see git history).
- Quota is required; per-model usage is best-effort (`null` on MCP failure). Quota-only success is a valid result.
- Secrets never leave the host: the apiKey is sent only in the `Authorization` header to kenari.id, never logged, never bundled into `dist/`, never returned by the route.
- The tool's `window` parameter (`week` | `month`) scopes display only — `execute` always returns both windows.
- The tool is concurrency-safe (`isConcurrencySafe: () => true`).
- Tool render/card functions (`output.render`, `presentationMeta`, `presentCall`, `presentResult`) are pure — no I/O, clock, or random — so they replay safely.

## Related Files

- `src/kenari-usage.ts` — tool, route handler, upstream fetchers, route install
- `src/quota.ts` — `parseQuota`, `parseUsageMarkdown`, `formatRp`, `formatCompactId`, `formatResetShort`, `usedFracWindow`
- `src/tool.test.ts`, `src/route.test.ts`, `src/quota.test.ts` — vitest coverage
- `build.mjs` — host emit (`dist/kenari-usage.js`)
- `cordis.patch.yml` — config surface (`apiKey`, `pollIntervalSecs`)

## Cross-References

- System flow: [../steering/system-flow.md](../steering/system-flow.md)
- Architecture: [../steering/architecture.md](../steering/architecture.md)
- API conventions (upstream + route contract): [../steering/api-conventions.md](../steering/api-conventions.md)
- Dock UI (browser half): [./02-usage-dock-ui.md](./02-usage-dock-ui.md)
