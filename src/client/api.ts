/**
 * Browser-half API for the kenari-usage dock.
 *
 * Same-origin only: every request goes to the plugin's host route
 * `/dsh-kenari-usage`, which the host half serves (host team implements the
 * handler in parallel — this file codes against that exact JSON contract).
 * No credentials are attached by hand, no secrets live here, and no request is
 * ever cross-origin.
 */

/** One quota window (week or month) as the host route returns it. */
export interface DockWindow {
  /** Raw rupiah consumed within the window. */
  used_rp: number
  /** Raw rupiah left within the window. */
  remaining_rp: number
  /** ISO timestamp (UTC) of when the window resets. */
  resets_at: string
}

/** One model's 30-day usage as the host route returns it. */
export interface DockModelUsage {
  /** Model identifier (e.g. "glm-5-3-flash"). */
  model: string
  /** Request count within the 30-day window. */
  requests: number
  /** Total input tokens within the 30-day window. */
  input_tok: number
  /** Total output tokens within the 30-day window. */
  output_tok: number
}

/** 30-day usage aggregate as the host route returns it. */
export interface DockUsage {
  /** Window descriptor the host reports on; always "30d" today. */
  window: string
  /** Per-model usage, already sorted by the host — render as-is. */
  models: DockModelUsage[]
  /** Total request count across all models in the window. */
  total_requests: number
  /** Total token count across all models in the window. */
  total_tokens: number
}

/** Success body of GET /dsh-kenari-usage. All display fields may be null. */
export interface DockPayload {
  ok: true
  /** Plan name (e.g. "Kreator"); null while unknown. */
  plan: string | null
  /** Coupon label, if any; null when none. */
  coupon: string | null
  /** Weekly quota window; null while unknown. */
  week: DockWindow | null
  /** Monthly quota window; null while unknown. */
  month: DockWindow | null
  /** 30-day usage aggregate; null while unknown. */
  usage: DockUsage | null
  /** Host epoch ms when the payload was assembled (advisory). */
  serverTime: number
  /** Suggested auto-poll cadence in ms; the dock falls back to 60000. */
  pollIntervalMs: number
}

/** Failure body of GET /dsh-kenari-usage (shape-level failure, not HTTP). */
export interface DockFailure {
  ok: false
  error: string
  retryable: boolean
}

export type DockResponse = DockPayload | DockFailure

/**
 * Fetch the dock payload from the plugin's same-origin host route.
 * `refresh=true` asks the host to force a fresh upstream fetch (`?refresh=1`).
 * Throws `Error("HTTP <status>")` on a non-2xx response; network failures and
 * aborts surface as native fetch rejections. The optional signal supports
 * aborting a superseded request (mirrors the panel's abort-prior behavior).
 */
export async function fetchDock(refresh: boolean, signal?: AbortSignal): Promise<DockResponse> {
  const res = await fetch(`/dsh-kenari-usage${refresh ? '?refresh=1' : ''}`, {
    cache: 'no-store',
    signal,
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  return (await res.json()) as DockResponse
}
