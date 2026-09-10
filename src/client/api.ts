/**
 * Browser-half API for the kenari-usage dock.
 *
 * Same-origin only: every request goes to the plugin's host route
 * `/dsh-kenari-usage`, which the host half serves (host team implements the
 * handler in parallel — this file codes against that exact JSON contract).
 * No cookies are attached by hand, no secrets live here, and no request is
 * ever cross-origin.
 */

/** One usage window as the host route returns it (pre-formatted display strings). */
export interface DockWindow {
  /** Fraction of the quota consumed (0.883 → the host formats "88.3%"). */
  used_frac: number
  /** Whole seconds until the window resets. */
  resets_in_secs: number
  /** Host-formatted percent string (single formatting path stays host-side). */
  percent: string
  /** Host-formatted countdown string at fetch time. */
  countdown: string
}

/** Success body of GET /dsh-kenari-usage. */
export interface DockPayload {
  ok: true
  week: DockWindow
  month: DockWindow
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
