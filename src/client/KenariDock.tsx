/**
 * Kenari usage dock — the browser-half React component rendered into the
 * host's `conversation.composer.dock` slot.
 *
 * UX mirrors the framework-free panel (`src/panel.ts`): Refresh is disabled
 * while fetching, rapid clicks collapse (1000ms debounce + abort-prior),
 * failures show an error card with Retry while the last data dims, and the
 * reset display is recomputed from `fetchedAt` by a 1s display timer that
 * never refetches. Unlike the panel, the dock ALSO auto-polls: every
 * `pollIntervalMs` (host-provided, default 60000) it refetches the
 * same-origin `/dsh-kenari-usage` route.
 *
 * Layout is a compact usage card rendered as a FLOATING surface fixed at the
 * bottom-right of the viewport (level with the composer input): a header row
 * ("◷ Usage ⌄" left, muted "Left" label + Refresh right) over two data rows
 * (Week / Month), each showing the reset date on the left and the REMAINING
 * quota as a whole percent on the right.
 *
 * Display values are derived client-side from the host payload's raw numbers
 * (`used_frac` → remaining %, `serverTime + resets_in_secs` → reset date):
 * the browser cannot import `../format.ts` because host and client bundle
 * separately.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { fetchDock, type DockPayload, type DockWindow } from './api.js'

/** Minimum gap between non-forced loads (ms) — mirrors REFRESH_DEBOUNCE_MS in panel.ts. */
const REFRESH_DEBOUNCE_MS = 1000

/** Local display-tick cadence (ms) — updates reset-date freshness only, never fetches. */
const DISPLAY_TICK_MS = 1000

/** Auto-poll cadence (ms) when the host payload omits pollIntervalMs. */
const DEFAULT_POLL_INTERVAL_MS = 60000

/** Remaining quota as a whole percent string (e.g. used 0.894 → "11%"). */
function remainingPct(usedFrac: number): string {
  return `${Math.max(0, Math.round((1 - usedFrac) * 100))}%`
}

/** Format a reset moment like "Fri, Sep 11, 1:20 AM" (en-US, host locale agnostic). */
function formatResetDate(date: Date): string {
  const day = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return `${day}, ${time}`
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
 * The composer dock card: a floating surface pinned bottom-right of the
 * viewport (fixed, clear of the composer input), rendering the
 * `◷ Usage ⌄ … Left ⟳` header over Week/Month rows
 * (`Fri, Sep 11, 1:20 AM … 21%`). Themed via the host's CSS vars
 * (`--dsw-alias-bg-base` / `--dsw-alias-border-l1`) with neutral fallbacks,
 * so it reads as a floating card over chat content in both light and dark.
 */
export function KenariDock() {
  const [snapshot, setSnapshot] = useState<DockSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [pollIntervalMs, setPollIntervalMs] = useState(DEFAULT_POLL_INTERVAL_MS)
  // Bumped by the display timer so the reset dates re-render each second.
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

  // Display-only tick: re-renders the reset dates from fetchedAt each second.
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

  const cardStyle: CSSProperties = {
    position: 'fixed',
    bottom: 100,
    right: 24,
    zIndex: 50,
    display: 'flex',
    flexDirection: 'column',
    maxWidth: 320,
    background: 'var(--dsw-alias-bg-base, #1e1e1e)',
    border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.12))',
    borderRadius: 10,
    padding: '8px 12px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
    color: 'inherit',
    fontSize: '0.85em',
    lineHeight: 1.5,
    opacity: dimmed ? 0.5 : 1,
  }

  const rowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
    whiteSpace: 'nowrap',
  }

  const mutedStyle: CSSProperties = {
    opacity: 0.55,
  }

  const buttonStyle: CSSProperties = {
    color: 'inherit',
    font: 'inherit',
    background: 'none',
    border: 'none',
    padding: '0 2px',
    cursor: refreshing ? 'default' : 'pointer',
    opacity: refreshing ? 0.5 : 1,
  }

  /** Reset date for one window, ticked forward from fetchedAt for display. */
  const resetDate = (serverTime: number, win: DockWindow, fetchedAt: number): string =>
    formatResetDate(new Date(serverTime + win.resets_in_secs * 1000 - elapsedSecs(fetchedAt) * 1000))

  /** One data row: label + reset date left, remaining percent right. */
  const usageRow = (label: string, serverTime: number, win: DockWindow, fetchedAt: number) => (
    <div style={rowStyle}>
      <span>
        {`${label} `}
        <span style={mutedStyle}>{resetDate(serverTime, win, fetchedAt)}</span>
      </span>
      <strong>{remainingPct(win.used_frac)}</strong>
    </div>
  )

  return (
    <div style={cardStyle} data-testid="kenari-dock">
      <div style={rowStyle}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span aria-hidden="true">◷</span>
          <strong>Usage</strong>
          <span style={{ ...mutedStyle, fontSize: '0.8em' }} aria-hidden="true">
            ⌄
          </span>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={mutedStyle}>Left</span>
          <button
            type="button"
            style={buttonStyle}
            data-testid="kenari-refresh"
            aria-label="Refresh"
            title="Refresh"
            disabled={refreshing}
            onClick={() => load(false)}
          >
            ⟳
          </button>
        </span>
      </div>
      {snap !== null && (
        <div data-testid="kenari-usage-line">
          {usageRow('Week', snap.payload.serverTime, snap.payload.week, snap.fetchedAt)}
          {usageRow('Month', snap.payload.serverTime, snap.payload.month, snap.fetchedAt)}
        </div>
      )}
      {error !== null && (
        <div style={{ ...rowStyle, opacity: 0.8 }} data-testid="kenari-error" role="alert">
          <span>{`Kenari usage: ${error}`}</span>
          <button
            type="button"
            style={buttonStyle}
            data-testid="kenari-retry"
            onClick={() => load(true)}
          >
            Retry
          </button>
        </div>
      )}
    </div>
  )
}
