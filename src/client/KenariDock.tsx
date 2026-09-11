/**
 * Kenari usage dock — the browser-half React component rendered into the
 * host's `conversation.composer.dock` slot.
 *
 * UX mirrors the framework-free panel (`src/panel.ts`): Refresh is disabled
 * while fetching, rapid clicks collapse (1000ms debounce + abort-prior),
 * failures show an error card with Retry while the last data dims, and the
 * display is recomputed on a 1s display timer that never refetches. Unlike
 * the panel, the dock ALSO auto-polls: every `pollIntervalMs`
 * (host-provided, default 60000) it refetches the same-origin
 * `/dsh-kenari-usage` route.
 *
 * Layout is a compact card rendered as a FLOATING surface over the chat
 * body, draggable by its header to anywhere on screen (position persists in
 * localStorage): a header row (`k` glyph + Kenari + plan name, chevron
 * toggle, Refresh; drag anywhere else on the row) over three sections —
 * KUOTA PAKET (weekly/monthly quota rows with used/sisa rupiah and a thin
 * bar), RINGKASAN (total request/token stat boxes) and PENGGUNAAN 30 HARI
 * (scrollable per-model list). The chevron button collapses/expands the
 * body.
 *
 * Display values are derived client-side from the host payload's raw numbers
 * (`used_rp` / `remaining_rp` → bar width, token counts → compact strings):
 * the browser cannot import `../format.ts` because host and client bundle
 * separately.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { fetchDock, type DockPayload, type DockUsage, type DockWindow } from './api.js'

/** Minimum gap between non-forced loads (ms) — mirrors REFRESH_DEBOUNCE_MS in panel.ts. */
const REFRESH_DEBOUNCE_MS = 1000

/** Local display-tick cadence (ms) — refreshes display only, never fetches. */
const DISPLAY_TICK_MS = 1000

/** Auto-poll cadence (ms) when the host payload omits pollIntervalMs. */
const DEFAULT_POLL_INTERVAL_MS = 60000

/** Card width (px) — fixed regardless of where it's dragged. */
const CARD_WIDTH = 270

/** Default position (bottom-right over the chat, level with the composer)
 *  before the user has ever dragged the card. */
const DEFAULT_CARD_BOTTOM = 100
const DEFAULT_CARD_RIGHT = 24

/** localStorage key for the user-dragged position. */
const POSITION_STORAGE_KEY = 'kenari-usage-dock-position'

const METER_FILL_COLOR = '#e3a53d'
const METER_TRACK_COLOR = 'rgba(255,255,255,0.12)'
const STAT_BOX_COLOR = 'rgba(255,255,255,0.06)'

/** English month abbreviations for the UTC reset stamp (host locale agnostic). */
const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

interface DockPosition {
  top: number
  left: number
}

function isDockPosition(value: unknown): value is DockPosition {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as DockPosition).top === 'number' &&
    typeof (value as DockPosition).left === 'number'
  )
}

/** Reads the persisted drag position; `null` means "use the default corner". */
function loadPosition(): DockPosition | null {
  try {
    const raw = window.localStorage.getItem(POSITION_STORAGE_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    return isDockPosition(parsed) ? parsed : null
  } catch {
    return null
  }
}

function savePosition(pos: DockPosition): void {
  try {
    window.localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(pos))
  } catch {
    // Private-browsing/storage-disabled: dragging still works, just doesn't persist.
  }
}

/** Raw rupiah as `Rp 143239` (plain integer, no separators). */
function formatRp(n: number): string {
  return `Rp ${n}`
}

/** Fraction of the window consumed, clamped to [0, 1]. */
function usedFrac(win: DockWindow): number {
  const total = win.used_rp + win.remaining_rp
  if (total <= 0) return 0
  return Math.min(1, Math.max(0, win.used_rp / total))
}

/**
 * Compact count format: >=1e9 → "1.84M", >=1e6 → "732.2jt", >=1e3 → "14.2rb",
 * else the plain number. One decimal, trailing ".0" trimmed.
 */
function formatCompact(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e9) return trimZero((n / 1e9).toFixed(1)) + 'M'
  if (abs >= 1e6) return trimZero((n / 1e6).toFixed(1)) + 'jt'
  if (abs >= 1e3) return trimZero((n / 1e3).toFixed(1)) + 'rb'
  return `${n}`
}

/** Drops a trailing ".0" from a one-decimal string ("14.0" → "14"). */
function trimZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

/**
 * Format an ISO reset timestamp as `13 Sep 20:30` in UTC (fixed, not
 * locale-derived, so the display matches the reference exactly). Returns the
 * raw string when the timestamp is unparseable.
 */
function formatResetShort(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const day = date.getUTCDate()
  const month = MONTHS_ABBR[date.getUTCMonth()]
  const hh = `${date.getUTCHours()}`.padStart(2, '0')
  const mm = `${date.getUTCMinutes()}`.padStart(2, '0')
  return `${day} ${month} ${hh}:${mm}`
}

/** One fetched payload plus the wall-clock moment it arrived. */
interface DockSnapshot {
  payload: DockPayload
  fetchedAt: number
}

/**
 * The composer dock card: a floating surface over the chat body, draggable
 * by its header to anywhere on screen (position persists in localStorage),
 * rendering a collapsible `k Kenari KREATOR ⌄ … ⟳` header over KUOTA PAKET /
 * RINGKASAN / PENGGUNAAN 30 HARI sections. Themed via the host's CSS vars
 * (`--dsw-alias-bg-base` / `--dsw-alias-border-l1`) plus `color: inherit`
 * for all text, so it tracks the host's light/dark theme with no hardcoded
 * foreground colors (rgba neutrals + the amber meter fill only).
 */
export function KenariDock() {
  const [snapshot, setSnapshot] = useState<DockSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [pollIntervalMs, setPollIntervalMs] = useState(DEFAULT_POLL_INTERVAL_MS)
  const [position, setPosition] = useState<DockPosition | null>(() => loadPosition())
  const [dragging, setDragging] = useState(false)
  // Bumped by the display timer so derived displays re-render each second.
  const [, setTick] = useState(0)

  const inFlight = useRef<AbortController | null>(null)
  const lastAttempt = useRef<number>(Number.NEGATIVE_INFINITY)
  const mounted = useRef(true)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const dragOffset = useRef<{ x: number; y: number } | null>(null)

  // Drag-to-reposition: pointerdown on the header starts tracking; move/up
  // listen on window so the drag keeps working even if the pointer leaves
  // the card. Position is clamped to the viewport and persisted on release.
  const handlePointerMove = useCallback((e: PointerEvent) => {
    if (dragOffset.current === null || cardRef.current === null) return
    const { offsetWidth: width, offsetHeight: height } = cardRef.current
    const left = Math.min(
      Math.max(8, e.clientX - dragOffset.current.x),
      window.innerWidth - width - 8,
    )
    const top = Math.min(
      Math.max(8, e.clientY - dragOffset.current.y),
      window.innerHeight - height - 8,
    )
    setPosition({ top, left })
  }, [])

  const handlePointerUp = useCallback(() => {
    dragOffset.current = null
    setDragging(false)
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', handlePointerUp)
    setPosition((pos) => {
      if (pos !== null) savePosition(pos)
      return pos
    })
  }, [handlePointerMove])

  const handleHeaderPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (cardRef.current === null) return
      const rect = cardRef.current.getBoundingClientRect()
      dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      setDragging(true)
      window.addEventListener('pointermove', handlePointerMove)
      window.addEventListener('pointerup', handlePointerUp)
    },
    [handlePointerMove, handlePointerUp],
  )

  // Drag listeners are only ever attached while a drag is in progress
  // (added in handleHeaderPointerDown), but detach them on unmount too in
  // case the component goes away mid-drag.
  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [handlePointerMove, handlePointerUp])

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

  // Display-only tick: re-renders derived displays each second.
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
  const plan = snap?.payload.plan ?? null
  const usage = snap?.payload.usage ?? null

  const cardStyle: CSSProperties = {
    position: 'fixed',
    ...(position !== null
      ? { top: position.top, left: position.left }
      : { bottom: DEFAULT_CARD_BOTTOM, right: DEFAULT_CARD_RIGHT }),
    width: CARD_WIDTH,
    zIndex: 50,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    background: 'var(--dsw-alias-bg-base, #1e1e1e)',
    border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.12))',
    borderRadius: 10,
    padding: '12px 14px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
    color: 'inherit',
    fontSize: '0.85em',
    lineHeight: 1.4,
    opacity: dimmed ? 0.5 : 1,
    userSelect: dragging ? 'none' : undefined,
  }

  const headerStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    whiteSpace: 'nowrap',
    cursor: dragging ? 'grabbing' : 'grab',
    touchAction: 'none',
  }

  const rowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
    whiteSpace: 'nowrap',
  }

  /** Wraps instead of squeezing: the reset stamp drops to its own line
   *  rather than colliding with the window label on narrow cards. */
  const quotaLabelRowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
    flexWrap: 'wrap',
  }

  const modelRowStyle: CSSProperties = {
    ...rowStyle,
    fontSize: '0.82em',
    padding: '2px 0',
  }

  const mutedStyle: CSSProperties = {
    opacity: 0.55,
  }

  const sectionLabelStyle: CSSProperties = {
    opacity: 0.5,
    fontSize: '0.72em',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
  }

  /** Margin variant for section labels in the body column; the header plan
   *  chip shares sectionLabelStyle and must not get the margin. */
  const sectionLabelBlockStyle: CSSProperties = {
    ...sectionLabelStyle,
    marginTop: 12,
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

  const trackStyle: CSSProperties = {
    height: 4,
    borderRadius: 3,
    marginTop: 6,
    background: METER_TRACK_COLOR,
    overflow: 'hidden',
  }

  const statBoxStyle: CSSProperties = {
    flex: 1,
    background: STAT_BOX_COLOR,
    borderRadius: 8,
    padding: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minWidth: 0,
  }

  /** One quota group row (Mingguan / Bulanan): label + reset stamp, used/sisa line, thin bar. */
  const quotaRow = (label: string, win: DockWindow) => (
    <div>
      <div style={quotaLabelRowStyle}>
        <strong>{label}</strong>
        <span style={{ ...mutedStyle, fontSize: '0.78em' }}>{`reset ${formatResetShort(win.resets_at)}`}</span>
      </div>
      <div style={{ ...mutedStyle, fontSize: '0.8em', marginTop: 3 }}>
        {`Terpakai ${formatRp(win.used_rp)} · Sisa ${formatRp(win.remaining_rp)}`}
      </div>
      <div style={trackStyle}>
        <div
          style={{
            height: '100%',
            borderRadius: 3,
            width: `${usedFrac(win) * 100}%`,
            background: METER_FILL_COLOR,
          }}
        />
      </div>
    </div>
  )

  return (
    <div ref={cardRef} style={cardStyle} data-testid="kenari-dock">
      <div style={headerStyle} data-testid="kenari-drag-handle" onPointerDown={handleHeaderPointerDown}>
        <button
          type="button"
          style={{ ...buttonStyle, display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}
          data-testid="kenari-toggle"
          aria-expanded={!collapsed}
          aria-controls="kenari-usage-body"
          title={collapsed ? 'Expand' : 'Collapse'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setCollapsed((c) => !c)}
        >
          <span
            aria-hidden="true"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 16,
              height: 16,
              borderRadius: 4,
              background: METER_FILL_COLOR,
              color: '#1e1e1e',
              fontSize: '0.8em',
              fontWeight: 700,
            }}
          >
            k
          </span>
          <strong>Kenari</strong>
          {plan !== null && <span style={{ ...sectionLabelStyle }}>{plan.toUpperCase()}</span>}
          <svg
            width="10"
            height="10"
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden="true"
            style={{
              opacity: 0.55,
              transform: collapsed ? 'rotate(0deg)' : 'rotate(180deg)',
              transition: 'transform 150ms ease',
            }}
          >
            <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          style={buttonStyle}
          data-testid="kenari-refresh"
          aria-label="Refresh"
          title="Refresh"
          disabled={refreshing}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => load(false)}
        >
          ⟳
        </button>
      </div>
      {!collapsed && (
        <div id="kenari-usage-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {snap !== null && (
            <div data-testid="kenari-usage-line" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              {(snap.payload.week !== null || snap.payload.month !== null) && (
                <div data-testid="kenari-quota" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <span style={sectionLabelBlockStyle}>Kuota Paket</span>
                  {snap.payload.week !== null && quotaRow('Mingguan', snap.payload.week)}
                  {snap.payload.month !== null && quotaRow('Bulanan', snap.payload.month)}
                </div>
              )}
              {usage !== null && (
                <div data-testid="kenari-summary" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={sectionLabelBlockStyle}>Ringkasan</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div style={statBoxStyle}>
                      <strong style={{ fontSize: '1.05em' }}>{formatCompact(usage.total_requests)}</strong>
                      <span style={{ ...mutedStyle, fontSize: '0.75em' }}>Total Request</span>
                    </div>
                    <div style={statBoxStyle}>
                      <strong style={{ fontSize: '1.05em' }}>{formatCompact(usage.total_tokens)}</strong>
                      <span style={{ ...mutedStyle, fontSize: '0.75em' }}>Total Token</span>
                    </div>
                  </div>
                </div>
              )}
              {usage !== null && (
                <div data-testid="kenari-models" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={sectionLabelBlockStyle}>Penggunaan 30 Hari</span>
                  <div style={{ maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {usage.models.map((m) => (
                      <div key={m.model} style={modelRowStyle}>
                        <span style={{ ...mutedStyle, overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.model}</span>
                        <span style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                          <strong>{`${m.requests}x`}</strong>
                          {` ${formatCompact(m.input_tok + m.output_tok)} tok`}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
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
      )}
    </div>
  )
}
