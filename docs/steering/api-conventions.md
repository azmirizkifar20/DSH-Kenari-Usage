# API Conventions

Conventions every endpoint/handler in this plugin should follow. For use when adding/editing route or upstream-fetch code.

## Response Envelope

- **Route success** (`GET /dsh-kenari-usage` → 200): `{ok: true, plan, coupon, week, month, usage, serverTime, pollIntervalMs}` — mirrors `DockPayload` in `src/client/api.ts`. Fields may be `null` while unknown; `week`/`month` are `{used_rp, remaining_rp, resets_at}`; `usage` is `{window: "30d", models, total_requests, total_tokens}`.
- **Route failure**: `{ok: false, error: string, retryable: boolean}` — shape-level failures return 502; non-GET returns 405. Mirrors `DockFailure`.
- **Tool value**: `QuotaSuccessValue {quota, usage}` vs `ErrorValue {error, retryable}` (`ToolValue` in `src/kenari-usage.ts`); the output schema is `oneOf` with `additionalProperties: false`.
- **Upstream field naming**: upstream snake_case (`used_rp`, `input_tok`) is passed through as-is; host-added fields are camelCase (`serverTime`, `pollIntervalMs`).
- HTTP status usage: 200 success; 405 wrong method; 502 missing config / upstream failure / shape failure. No 4xx-only error mapping on the route (all upstream errors collapse to 502 with `retryable` classification).

## Error Handling

- **Retryability**: 401/403/other 4xx and malformed upstream JSON → `retryable: false`; 5xx and network errors → `retryable: true` after the second attempt. Classification lives in `fetchQuota`/`loadQuotaUsage` (`src/kenari-usage.ts`).
- **Retries**: every upstream fetch attempts twice (`for attempt < 2`), 8s per attempt (`FETCH_TIMEOUT_MS`), route-wide 30s outer budget (`ROUTE_TIMEOUT_MS` via `AbortSignal.timeout`). Caller aborts always propagate immediately.
- **Degradation**: quota is required; per-model usage is best-effort — `fetchModelUsage` failure yields `usage: null` rather than failing the whole result.
- **Actionable messages**: 401 tells the user to create a fresh `kn-` key and where to set it; 403 says a shared key is not allowed; the missing-key message names `cordis.patch.yml` and the restart step.
- MCP framing: `parseMcpRpcPayload` accepts plain JSON or SSE `data:` lines (takes the last, ignores `[DONE]`); `unwrapMcpText` maps JSON-RPC `error` / missing `result.content[0].text` to thrown `TypeError`/`Error` with shape names.
- Never log the apiKey; never include it in any response.

## Naming & Routing

- Exactly one route: exact match `GET /dsh-kenari-usage` (constant `USAGE_ROUTE_PATH`), registered through the host `webServer` service with `{kind: 'exact', path, handler}`.
- Query params: `?refresh=1` accepted as a no-op (handler always fetches fresh, `cache-control: no-store`).
- Upstream constants: `QUOTA_URL`, `MCP_URL` exported from `src/kenari-usage.ts`; no URL construction elsewhere.

## Auth & Permissions

- Auth is a static `Authorization: Bearer <apiKey>` header attached host-side in `fetchBearerOnce`; the key never reaches the browser bundle, logs, or route payloads.
- No user-level permissions: the route is same-origin (served by the harness host) and the tool runs with harness privileges. No middleware chain beyond the route guards (method, `hasApiKey`).

## Data Access

- No database and no persistence host-side; config lives in module state set by `apply()`. Client persistence is `localStorage` (see [system-flow.md](./system-flow.md) Environment section).
- Response construction is single-shot per request (`writeUsageJson` sets `content-type: application/json; charset=utf-8` + `cache-control: no-store`).
- Upstream parse contract is strict (`src/quota.ts`): wrong types, negatives, NaN, or invalid dates throw `TypeError`/`RangeError` with a field-labeled message; extra fields are ignored; missing week/month windows become `null`.
