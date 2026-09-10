/**
 * Kenari usage dock — the browser-half React component rendered into the
 * host's `conversation.composer.dock` slot.
 *
 * UX mirrors the framework-free panel (`src/panel.ts`): Refresh is disabled
 * while fetching, rapid clicks collapse (1000ms debounce + abort-prior),
 * failures show an error card with Retry while the last data dims, and the
 * reset countdown is computed once per fetch and decremented locally by a
 * 1s display timer that never refetches. Unlike the panel, the dock ALSO
 * auto-polls: every `pollIntervalMs` (host-provided, default 60000) it
 * refetches the same-origin `/dsh-kenari-usage` route.
 *
 * Percent strings come from the host payload (single formatting path stays
 * host-side). Only the tiny ticking-countdown display ("Xd Yh Zm" /
 * "resets now") is duplicated here — the browser cannot import
 * `../format.ts` because host and client bundle separately.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { fetchDock, type DockPayload } from './api.js'

/** Minimum gap between non-forced loads (ms) — mirrors REFRESH_DEBOUNCE_MS in panel.ts. */
const REFRESH_DEBOUNCE_MS = 1000

/** Local display-tick cadence (ms) — updates countdown text only, never fetches. */
const DISPLAY_TICK_MS = 1000

/** Auto-poll cadence (ms) when the host payload omits pollIntervalMs. */
const DEFAULT_POLL_INTERVAL_MS = 60000

/**
 * Local ticking-countdown display. Pure duplicate of the tiny slice of
 * format.ts the dock must re-derive as time passes (the host's pre-formatted
 * `countdown` string is frozen at fetch time).
 */
function tickCountdown(remainingSecs: number): string {
  if (remainingSecs <= 0) return 'resets now'
  const total = Math.floor(remainingSecs)
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  return `resets in ${d}d ${h}h ${m}m`
}

/** Seconds elapsed since the fetch, floored (display decrement only). */
function elapsedSecs(fetchedAt: number): number {
  return Math.max(0, Math.floor((Date.now() - fetchedAt) / 1000))
}

/** One fetched payload plus the wall-clock moment it arrived. */
interface DockSnapshot {
  payload: DockPayload
  fetchedAt: number
}

/**
 * The composer dock line: `Week 88.3% · resets in 3d 12h 7m | Month … [Refresh]`.
 * Dark/light agnostic — inherits the app's text color, no theme CSS vars.
 */
export function KenariDock() {
  const [snapshot, setSnapshot] = useState<DockSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [pollIntervalMs, setPollIntervalMs] = useState(DEFAULT_POLL_INTERVAL_MS)
  // Bumped by the display timer so the countdown re-renders each second.
  const [, setTick] = useState(0)

  const inFlight = useRef<AbortController | null>(null)
  const lastAttempt = useRef<number>(Number.NEGATIVE_INFINITY)
  const mounted = useRef(true)

  const load = useCallback((force: boolean): void => {
    const now = Date.now()
    if (!force && now - lastAttempt.current < REFRESH_DEBOUNCE_MS) return
    lastAttempt.current = now
    // Abort-prior: a superseded request never settles into state.
    if (inFlight.current !== null) inFlight.current.abort()
    const ctrl = new AbortController()
    inFlight.current = ctrl
    setRefreshing(true)
    void fetchDock(force, ctrl.signal).then(
      (res) => {
        if (inFlight.current !== ctrl) return
        inFlight.current = null
        if (!mounted.current) return
        setRefreshing(false)
        if (res.ok) {
          setSnapshot({ payload: res, fetchedAt: Date.now() })
          setPollIntervalMs(res.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS)
          setError(null)
        } else {
          setError(res.error)
        }
      },
      (err: unknown) => {
        if (inFlight.current !== ctrl) return
        inFlight.current = null
        if (ctrl.signal.aborted || !mounted.current) return
        setRefreshing(false)
        setError(err instanceof Error ? err.message : String(err))
      },
    )
  }, [])

  // Unmount cleanup: abort any in-flight request and freeze state writes.
  useEffect(() => {
    return () => {
      mounted.current = false
      if (inFlight.current !== null) inFlight.current.abort()
      inFlight.current = null
    }
  }, [])

  // Initial load (debounce window is empty, so the dock is never blank).
  useEffect(() => {
    load(false)
  }, [load])

  // Auto-poll: refetch on the host-suggested cadence. Re-armed when the
  // interval changes (first payload) and torn down on unmount.
  useEffect(() => {
    const id = window.setInterval(() => {
      load(false)
    }, pollIntervalMs)
    return () => {
      window.clearInterval(id)
    }
  }, [pollIntervalMs, load])

  // Display-only tick: re-renders the countdown from fetchedAt each second.
  useEffect(() => {
    const id = window.setInterval(() => {
      setTick((t) => t + 1)
    }, DISPLAY_TICK_MS)
    return () => {
      window.clearInterval(id)
    }
  }, [])

  const snap = snapshot
  const dimmed = error !== null && snap !== null

  const lineStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    color: 'inherit',
    fontSize: '0.85em',
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
    opacity: dimmed ? 0.5 : 1,
  }

  const buttonStyle: CSSProperties = {
    color: 'inherit',
    font: 'inherit',
    padding: '0 6px',
    cursor: refreshing ? 'default' : 'pointer',
    opacity: refreshing ? 0.5 : 1,
  }

  return (
    <div style={lineStyle} data-testid="kenari-dock">
      {snap !== null && (
        <span data-testid="kenari-usage-line">
          {`Week ${snap.payload.week.percent} · ${tickCountdown(snap.payload.week.resets_in_secs - elapsedSecs(snap.fetchedAt))}`}
          {' | '}
          {`Month ${snap.payload.month.percent} · ${tickCountdown(snap.payload.month.resets_in_secs - elapsedSecs(snap.fetchedAt))}`}
        </span>
      )}
      {error !== null && (
        <span
          style={{ color: 'inherit', opacity: 0.8 }}
          data-testid="kenari-error"
          role="alert"
        >
          {`Kenari usage: ${error}`}
          <button
            type="button"
            style={buttonStyle}
            data-testid="kenari-retry"
            onClick={() => load(true)}
          >
            Retry
          </button>
        </span>
      )}
      <button
        type="button"
        style={buttonStyle}
        data-testid="kenari-refresh"
        disabled={refreshing}
        onClick={() => load(false)}
      >
        Refresh
      </button>
    </div>
  )
}
