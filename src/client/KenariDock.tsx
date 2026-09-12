/**
 * Kenari usage dock — the browser-half React component rendered into the
 * host's `conversation.composer.dock` slot.
 *
 * Refresh behavior: the button is disabled while fetching (the ⟳ glyph
 * swaps to a spinning arc), rapid clicks collapse (1000ms debounce +
 * abort-prior), failures show an error card with Retry while the last
 * data dims, and the display is recomputed on a 1s display timer that
 * never refetches. The dock ALSO auto-polls: every `pollIntervalMs`
 * (host-provided, default 6000) it refetches the same-origin
 * `/dsh-kenari-usage` route.
 *
 * Layout is a compact card rendered as a FLOATING surface over the chat
 * body, draggable by its header to anywhere on screen (position persists in
 * localStorage): a header row (`k` glyph + Kenari + plan pill on the left,
 * chevron + Refresh icon buttons on the right; drag anywhere else on the
 * row) over three sections —
 * KUOTA PAKET (weekly/monthly quota rows with used/sisa rupiah and a thin
 * bar), RINGKASAN (total request/token stat boxes), PENGGUNAAN 30 HARI
 * (scrollable per-model list) and PENGGUNAAN HARI INI (today usage derived
 * client-side by diffing the 30-day payload against a start-of-day
 * localStorage baseline snapshot — the server has no daily endpoint). The
 * chevron button collapses/expands the body.
 *
 * Display values are derived client-side from the host payload's raw numbers
 * (`used_rp` / `remaining_rp` → bar width, token counts → compact strings);
 * host and client bundle separately, so nothing is shared beyond the JSON
 * contract.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { fetchDock, type DockPayload, type DockUsage, type DockWindow } from './api.js'

/** Minimum gap between non-forced loads (ms). */
const REFRESH_DEBOUNCE_MS = 1000

/** Local display-tick cadence (ms) — refreshes display only, never fetches. */
const DISPLAY_TICK_MS = 1000

/** Auto-poll cadence (ms) when the host payload omits pollIntervalMs — 6s. */
const DEFAULT_POLL_INTERVAL_MS = 6000

/** Card width (px) — default/fallback; user-resizable 200–520 via the left/right edge handles. */
const CARD_WIDTH = 270
const CARD_WIDTH_MIN = 200
const CARD_WIDTH_MAX = 520

/** Default position (bottom-right over the chat, level with the composer)
 *  before the user has ever dragged the card. */
const DEFAULT_CARD_BOTTOM = 100
const DEFAULT_CARD_RIGHT = 24

/** localStorage key for the user-dragged position. */
const POSITION_STORAGE_KEY = 'kenari-usage-dock-position'

/** localStorage key for the user-resized card width. */
const WIDTH_STORAGE_KEY = 'kenari-usage-dock-width'

/** Card height (px) — null = auto/content-driven (default). User-resizable
 *  160–min(800, viewport-32) via the top/bottom edge handles. */
const CARD_HEIGHT_MIN = 160
const CARD_HEIGHT_MAX = 800

/** localStorage key for the user-resized card height. */
const HEIGHT_STORAGE_KEY = 'kenari-usage-dock-height'

const METER_FILL_COLOR = '#e3a53d'
const METER_TRACK_COLOR = 'rgba(255,255,255,0.12)'
const STAT_BOX_COLOR = 'rgba(255,255,255,0.06)'
/** Header plan chip background: amber tint keyed to the k badge fill. */
const PLAN_CHIP_BG = 'rgba(227,165,61,0.16)'

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

function clampCardWidth(n: number): number {
  return Math.min(CARD_WIDTH_MAX, Math.max(CARD_WIDTH_MIN, Math.round(n)))
}

function loadCardWidth(): number {
  try {
    const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY)
    if (raw === null) return CARD_WIDTH
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? clampCardWidth(parsed) : CARD_WIDTH
  } catch {
    return CARD_WIDTH
  }
}

function saveCardWidth(width: number): void {
  try {
    window.localStorage.setItem(WIDTH_STORAGE_KEY, String(clampCardWidth(width)))
  } catch {
    // Private-browsing/storage-disabled: resizing still works, just doesn't persist.
  }
}

function clampCardHeight(n: number): number {
  const max = Math.max(CARD_HEIGHT_MIN, Math.min(CARD_HEIGHT_MAX, window.innerHeight - 32))
  return Math.min(max, Math.max(CARD_HEIGHT_MIN, Math.round(n)))
}

function loadCardHeight(): number | null {
  try {
    const raw = window.localStorage.getItem(HEIGHT_STORAGE_KEY)
    if (raw === null) return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? clampCardHeight(parsed) : null
  } catch {
    return null
  }
}

function saveCardHeight(height: number): void {
  try {
    window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(clampCardHeight(height)))
  } catch {
    // Private-browsing/storage-disabled: resizing still works, just doesn't persist.
  }
}

function clearCardHeight(): void {
  try {
    window.localStorage.removeItem(HEIGHT_STORAGE_KEY)
  } catch {
    // Storage-disabled: in-memory state still resets to auto.
  }
}

/** localStorage key for the start-of-today usage baseline (snapshot diff). */
const DAY_BASELINE_STORAGE_KEY = 'kenari-usage-day-baseline'

/** One model's baseline counters at the first fetch of the local day. */
interface DayBaselinePerModel {
  requests: number
  tokens: number
}

/**
 * Start-of-day usage baseline: the 30-day aggregate as first seen today.
 * Today usage = current 30-day payload − this snapshot (the server exposes
 * no daily endpoint, so "today" is derived client-side by snapshot diffing).
 */
interface DayBaseline {
  /** Local calendar day the snapshot was taken on, `YYYY-MM-DD`. */
  date: string
  total_requests: number
  total_tokens: number
  perModel: Record<string, DayBaselinePerModel>
}

/** Today usage derived from the payload minus the baseline (negatives clamped to 0). */
interface TodayUsage {
  requests: number
  tokens: number
  /** Models with today requests > 0, sorted desc by today tokens. */
  models: Array<{ model: string; requests: number; tokens: number }>
}

/** Local calendar day stamp `YYYY-MM-DD` (local time, not UTC). */
function localDayStamp(d: Date): string {
  const month = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

function isDayBaseline(value: unknown): value is DayBaseline {
  if (typeof value !== 'object' || value === null) return false
  const b = value as DayBaseline
  return (
    typeof b.date === 'string' &&
    typeof b.total_requests === 'number' &&
    typeof b.total_tokens === 'number' &&
    typeof b.perModel === 'object' &&
    b.perModel !== null
  )
}

function loadDayBaseline(): DayBaseline | null {
  try {
    const raw = window.localStorage.getItem(DAY_BASELINE_STORAGE_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    return isDayBaseline(parsed) ? parsed : null
  } catch {
    return null
  }
}

function saveDayBaseline(baseline: DayBaseline): void {
  try {
    window.localStorage.setItem(DAY_BASELINE_STORAGE_KEY, JSON.stringify(baseline))
  } catch {
    // Private-browsing/storage-disabled: today usage still renders, just
    // resets on every reload instead of persisting across the day.
  }
}

/** Snapshot the current 30-day payload as the baseline for `date`. */
function baselineFromUsage(usage: DockUsage, date: string): DayBaseline {
  const perModel: Record<string, DayBaselinePerModel> = {}
  for (const m of usage.models) {
    perModel[m.model] = { requests: m.requests, tokens: m.input_tok + m.output_tok }
  }
  return { date, total_requests: usage.total_requests, total_tokens: usage.total_tokens, perModel }
}

/**
 * Diff the current 30-day payload against the baseline: today = max(0,
 * current − baseline) per totals and per model (tokens = input + output).
 * Negatives are upstream corrections (backfills, window shifts) — clamped
 * to 0 rather than shown as negative usage.
 */
function diffToday(usage: DockUsage, baseline: DayBaseline): TodayUsage {
  const clamp0 = (n: number): number => Math.max(0, n)
  const models: TodayUsage['models'] = []
  for (const m of usage.models) {
    const base: DayBaselinePerModel = baseline.perModel[m.model] ?? { requests: 0, tokens: 0 }
    const requests = clamp0(m.requests - base.requests)
    if (requests > 0) {
      models.push({
        model: m.model,
        requests,
        tokens: clamp0(m.input_tok + m.output_tok - base.tokens),
      })
    }
  }
  models.sort((a, b) => b.tokens - a.tokens)
  return {
    requests: clamp0(usage.total_requests - baseline.total_requests),
    tokens: clamp0(usage.total_tokens - baseline.total_tokens),
    models,
  }
}

/** Integer with Indonesian dot thousand separators: 3527 → `3.527`. */
function formatInt(n: number): string {
  return `${Math.trunc(n)}`.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

/** Raw rupiah as `Rp 136.861` (integer, Indonesian dot separators). */
function formatRpId(n: number): string {
  return `Rp ${formatInt(n)}`
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
 * Countdown to an ISO reset timestamp as an abbreviated Indonesian duration:
 * `1h 18j` (hari + jam), `3j 45m`, `12m`, `<1m`, or `segera` once past.
 * Compared against the live clock so the 1s display tick keeps it current.
 * Returns the raw string when the timestamp is unparseable.
 */
function formatResetCountdown(iso: string): string {
  const target = new Date(iso).getTime()
  if (Number.isNaN(target)) return iso
  const totalMinutes = Math.floor((target - Date.now()) / 60000)
  if (totalMinutes < 1) return 'segera'
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}h ${hours}j`
  if (hours > 0) return `${hours}j ${minutes}m`
  return `${minutes}m`
}

/** id for the once-injected dock stylesheet (keyframes the spinner needs). */
const DOCK_STYLE_ID = 'kenari-usage-dock-styles'

/**
 * Inline styles cannot express @keyframes, so the dock injects one tiny
 * stylesheet once (idempotent by id) for the refresh spinner. The spinning
 * element opts in via the .kenari-dock-spin class.
 */
function ensureDockStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(DOCK_STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = DOCK_STYLE_ID
  style.textContent = [
    '@keyframes kenari-dock-spin { to { transform: rotate(360deg); } }',
    '.kenari-dock-spin { animation: kenari-dock-spin 0.8s linear infinite; }',
    '@media (prefers-reduced-motion: reduce) { .kenari-dock-spin { animation-duration: 2.4s; } }',
  ].join('\n')
  document.head.appendChild(style)
}

/** One fetched payload plus the wall-clock moment it arrived. */
interface DockSnapshot {
  payload: DockPayload
  fetchedAt: number
}

/**
 * The composer dock card: a floating surface over the chat body, draggable
 * by its header to anywhere on screen (position persists in localStorage),
 * rendering a collapsible `k Kenari ⟨KREATOR⟩ … ⌄ ⟳` header over KUOTA PAKET /
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
  const [cardWidth, setCardWidth] = useState(() => loadCardWidth())
  const [cardHeight, setCardHeight] = useState<number | null>(() => loadCardHeight())
  const [resizing, setResizing] = useState(false)
  const [dayBaseline, setDayBaseline] = useState<DayBaseline | null>(() => loadDayBaseline())
  // Bumped by the display timer so derived displays re-render each second.
  const [, setTick] = useState(0)

  const inFlight = useRef<AbortController | null>(null)
  const lastAttempt = useRef<number>(Number.NEGATIVE_INFINITY)
  const mounted = useRef(true)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const dragOffset = useRef<{ x: number; y: number } | null>(null)
  const resizeStart = useRef<{ edge: 'left' | 'right'; startX: number; startWidth: number; startLeft: number | null; startTop: number } | null>(null)
  const resizeVStart = useRef<{ edge: 'top' | 'bottom'; startY: number; startHeight: number; startTop: number | null } | null>(null)

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

  const handleResizeMove = useCallback((e: PointerEvent) => {
    const rs = resizeStart.current
    if (rs === null) return
    const delta = rs.edge === 'left' ? rs.startX - e.clientX : e.clientX - rs.startX
    const newWidth = clampCardWidth(rs.startWidth + delta)
    setCardWidth(newWidth)
    // Only the left edge needs anchor math (keep the right edge fixed); a
    // right-edge drag grows away from the fixed opposite edge in both anchor
    // modes (CSS left when top-anchored, CSS right when bottom-right default).
    if (rs.edge === 'left' && rs.startLeft !== null) {
      const newLeft = rs.startLeft + rs.startWidth - newWidth
      setPosition((pos) => ({ top: pos?.top ?? rs.startTop, left: newLeft }))
    }
  }, [])

  const handleResizeUp = useCallback(() => {
    resizeStart.current = null
    setResizing(false)
    window.removeEventListener('pointermove', handleResizeMove)
    window.removeEventListener('pointerup', handleResizeUp)
    setCardWidth((w) => {
      saveCardWidth(w)
      return w
    })
    setPosition((pos) => {
      if (pos !== null) savePosition(pos)
      return pos
    })
  }, [handleResizeMove])

  const handleResizePointerDown = useCallback(
    (edge: 'left' | 'right') => (e: ReactPointerEvent<HTMLDivElement>) => {
      e.stopPropagation()
      resizeStart.current = {
        edge,
        startX: e.clientX,
        startWidth: cardWidth,
        startLeft: position?.left ?? null,
        startTop: position?.top ?? 0,
      }
      setResizing(true)
      window.addEventListener('pointermove', handleResizeMove)
      window.addEventListener('pointerup', handleResizeUp)
    },
    [cardWidth, position, handleResizeMove, handleResizeUp],
  )

  // Top-edge vertical resize: dragging up grows the card (bottom edge stays
  // fixed), dragging down shrinks it. The start height is measured from the
  // card (state may be null=auto); when the card was moved (top-anchored),
  // `top` is adjusted so the bottom edge stays fixed — mirroring the width
  // logic. In the default bottom-anchored state position stays null and the
  // bottom stays fixed automatically.
  const handleResizeVMove = useCallback((e: PointerEvent) => {
    const rs = resizeVStart.current
    if (rs === null) return
    const delta = rs.edge === 'top' ? rs.startY - e.clientY : e.clientY - rs.startY
    const newHeight = clampCardHeight(rs.startHeight + delta)
    setCardHeight(newHeight)
    // Only the top edge needs anchor math (keep the bottom edge fixed); a
    // bottom-edge drag grows away from the fixed opposite edge in both modes.
    if (rs.edge === 'top' && rs.startTop !== null) {
      const newTop = rs.startTop + rs.startHeight - newHeight
      setPosition((pos) => ({ top: newTop, left: pos?.left ?? 0 }))
    }
  }, [])

  const handleResizeVUp = useCallback(() => {
    resizeVStart.current = null
    setResizing(false)
    window.removeEventListener('pointermove', handleResizeVMove)
    window.removeEventListener('pointerup', handleResizeVUp)
    setCardHeight((h) => {
      if (h !== null) saveCardHeight(h)
      return h
    })
    setPosition((pos) => {
      if (pos !== null) savePosition(pos)
      return pos
    })
  }, [handleResizeVMove])

  const handleResizeVPointerDown = useCallback(
    (edge: 'top' | 'bottom') => (e: ReactPointerEvent<HTMLDivElement>) => {
      e.stopPropagation()
      if (cardRef.current === null) return
      resizeVStart.current = {
        edge,
        startY: e.clientY,
        startHeight: cardRef.current.offsetHeight,
        startTop: position?.top ?? null,
      }
      setResizing(true)
      window.addEventListener('pointermove', handleResizeVMove)
      window.addEventListener('pointerup', handleResizeVUp)
    },
    [position, handleResizeVMove, handleResizeVUp],
  )

  // Double-click the vertical handle to reset to auto (content-driven) height.
  const handleResizeVDoubleClick = useCallback(() => {
    clearCardHeight()
    setCardHeight(null)
  }, [])

  // Drag listeners are only ever attached while a drag is in progress
  // (added in handleHeaderPointerDown), but detach them on unmount too in
  // case the component goes away mid-drag.
  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointermove', handleResizeMove)
      window.removeEventListener('pointerup', handleResizeUp)
      window.removeEventListener('pointermove', handleResizeVMove)
      window.removeEventListener('pointerup', handleResizeVUp)
    }
  }, [handlePointerMove, handlePointerUp, handleResizeMove, handleResizeUp, handleResizeVMove, handleResizeVUp])

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
  // Also injects the once-only stylesheet the refresh spinner animates with.
  useEffect(() => {
    ensureDockStyles()
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

  // Today-usage baseline: after each successful fetch lands in state, keep
  // the start-of-day snapshot current. First fetch of a new local day (or a
  // missing/corrupt baseline) overwrites the stored snapshot with the
  // current payload — the diff against a stale day is never rendered. The
  // baseline is only persisted from ok:true payloads (this effect only runs
  // when a snapshot exists).
  useEffect(() => {
    const usage = snapshot?.payload.usage
    if (usage === undefined || usage === null) return
    const today = localDayStamp(new Date())
    const stored = loadDayBaseline()
    if (stored !== null && stored.date === today) {
      setDayBaseline(stored)
      return
    }
    const baseline = baselineFromUsage(usage, today)
    saveDayBaseline(baseline)
    setDayBaseline(baseline)
  }, [snapshot])

  const snap = snapshot
  const dimmed = error !== null && snap !== null
  const plan = snap?.payload.plan ?? null
  const usage = snap?.payload.usage ?? null
  // Today usage = current 30-day payload − start-of-day baseline. Hidden
  // until both a payload and a same-day baseline exist; the first fetch of
  // a new day installs the baseline so the diff starts at 0, never at a
  // stale day's full 30-day total. Baseline is null mid-day only if
  // storage is unavailable — today usage stays hidden rather than lying.
  const today =
    usage !== null && dayBaseline !== null && dayBaseline.date === localDayStamp(new Date())
      ? diffToday(usage, dayBaseline)
      : null

  const cardStyle: CSSProperties = {
    position: 'fixed',
    ...(position !== null
      ? { top: position.top, left: position.left }
      : { bottom: DEFAULT_CARD_BOTTOM, right: DEFAULT_CARD_RIGHT }),
    width: cardWidth,
    ...(cardHeight !== null ? { height: cardHeight, overflow: 'hidden' as const } : {}),
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
    userSelect: dragging || resizing ? 'none' : undefined,
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

  /** Margin variant for section labels in the body column. */
  const sectionLabelBlockStyle: CSSProperties = {
    ...sectionLabelStyle,
    marginTop: 12,
  }

  /** Header row for sections that carry an inline total on the right
   *  (Penggunaan 30 Hari / Penggunaan Hari Ini). */
  const secHeadStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 12,
  }

  const secTotalStyle: CSSProperties = {
    ...mutedStyle,
    fontSize: '0.78em',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  }

  const buttonStyle: CSSProperties = {
    color: 'inherit',
    font: 'inherit',
    background: 'none',
    border: 'none',
    padding: '0 2px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: refreshing ? 'default' : 'pointer',
    opacity: refreshing ? 0.75 : 1,
  }

  const trackStyle: CSSProperties = {
    height: 4,
    borderRadius: 3,
    flex: 1,
    background: METER_TRACK_COLOR,
    overflow: 'hidden',
  }

  /** Meter row: thin bar filling the row with the inline % pinned right. */
  const meterRowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
  }

  const pctStyle: CSSProperties = {
    width: 34,
    textAlign: 'right',
    flexShrink: 0,
    fontWeight: 600,
    fontSize: '0.9em',
    fontVariantNumeric: 'tabular-nums',
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

  /** One quota group row (Mingguan / Bulanan): label + reset stamp, used/sisa
   *  line, then a meter row with the inline % pinned to the right. */
  const quotaRow = (label: string, win: DockWindow) => (
    <div>
      <div style={quotaLabelRowStyle}>
        <strong>{label}</strong>
        <span style={{ ...mutedStyle, fontSize: '0.78em' }}>{`reset dalam ${formatResetCountdown(win.resets_at)}`}</span>
      </div>
      <div style={{ ...mutedStyle, fontSize: '0.8em', marginTop: 3 }}>
        {`Terpakai ${formatRpId(win.used_rp)} · Sisa ${formatRpId(win.remaining_rp)}`}
      </div>
      <div style={meterRowStyle}>
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
        <span style={pctStyle}>{`${Math.round(usedFrac(win) * 100)}%`}</span>
      </div>
    </div>
  )

  return (
    <div ref={cardRef} style={cardStyle} data-testid="kenari-dock">
      <div
        data-testid="kenari-resize"
        title="Resize card width (left edge)"
        aria-label="Resize card width"
        onPointerDown={handleResizePointerDown('left')}
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: 8,
          cursor: 'ew-resize',
          touchAction: 'none',
        }}
      />
      <div
        data-testid="kenari-resize-r"
        title="Resize card width (right edge)"
        aria-label="Resize card width"
        onPointerDown={handleResizePointerDown('right')}
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          right: 0,
          width: 8,
          cursor: 'ew-resize',
          touchAction: 'none',
        }}
      />
      <div
        data-testid="kenari-resize-v"
        title="Resize card height (top edge) — double-click to reset auto height"
        aria-label="Resize card height"
        onPointerDown={handleResizeVPointerDown('top')}
        onDoubleClick={handleResizeVDoubleClick}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 8,
          cursor: 'ns-resize',
          touchAction: 'none',
        }}
      />
      <div
        data-testid="kenari-resize-b"
        title="Resize card height (bottom edge) — double-click to reset auto height"
        aria-label="Resize card height"
        onPointerDown={handleResizeVPointerDown('bottom')}
        onDoubleClick={handleResizeVDoubleClick}
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: 8,
          cursor: 'ns-resize',
          touchAction: 'none',
        }}
      />
      <div style={headerStyle} data-testid="kenari-drag-handle" onPointerDown={handleHeaderPointerDown}>
        <button
          type="button"
          style={{ ...buttonStyle, display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}
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
          {plan !== null && (
            <span
              style={{
                background: PLAN_CHIP_BG,
                color: METER_FILL_COLOR,
                borderRadius: 999,
                padding: '2px 8px',
                fontSize: '0.7em',
                fontWeight: 600,
                letterSpacing: '0.07em',
                textTransform: 'uppercase',
                lineHeight: 1.4,
              }}
            >
              {plan.toUpperCase()}
            </span>
          )}
        </button>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            style={{ ...buttonStyle, padding: '2px 4px', borderRadius: 6 }}
            data-testid="kenari-chevron"
            aria-expanded={!collapsed}
            aria-controls="kenari-usage-body"
            title={collapsed ? 'Expand' : 'Collapse'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setCollapsed((c) => !c)}
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 12 12"
              fill="none"
              aria-hidden="true"
              style={{
                display: 'block',
                opacity: 0.6,
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
            aria-busy={refreshing}
            title={refreshing ? 'Refreshing…' : 'Refresh'}
            disabled={refreshing}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => load(false)}
          >
            {refreshing ? (
              <svg
                className="kenari-dock-spin"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
                style={{ display: 'block' }}
              >
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
                <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
            ) : (
              '⟳'
            )}
          </button>
        </span>
      </div>
      {!collapsed && (
        <div
          id="kenari-usage-body"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            ...(cardHeight !== null
              ? { flex: 1, minHeight: 0, overflowY: 'auto' }
              : {}),
          }}
        >
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
                  <div style={secHeadStyle}>
                    <span style={sectionLabelStyle}>Penggunaan 30 Hari</span>
                    <span style={secTotalStyle}>{`${formatInt(usage.total_requests)} req · ${formatCompact(usage.total_tokens)} tok`}</span>
                  </div>
                  <div style={{ maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {usage.models.map((m) => (
                      <div key={m.model} style={modelRowStyle}>
                        <span style={{ ...mutedStyle, overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.model}</span>
                        <span style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                          <strong>{`${formatInt(m.requests)} req`}</strong>
                          {` · ${formatCompact(m.input_tok + m.output_tok)} tok`}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {usage !== null && today !== null && (
                <div data-testid="kenari-today" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={secHeadStyle}>
                    <span style={sectionLabelStyle}>Penggunaan Hari Ini</span>
                    {today.models.length > 0 && (
                      <span style={secTotalStyle}>{`${formatInt(today.requests)} req · ${formatCompact(today.tokens)} tok`}</span>
                    )}
                  </div>
                  {today.models.length > 0 ? (
                    <div style={{ maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {today.models.map((m) => (
                        <div key={m.model} style={modelRowStyle}>
                          <span style={{ ...mutedStyle, overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.model}</span>
                          <span style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                            <strong>{`${formatInt(m.requests)} req`}</strong>
                            {` · ${formatCompact(m.tokens)} tok`}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div data-testid="kenari-today-empty" style={{ ...modelRowStyle, ...mutedStyle }}>
                      <span>Belum ada pemakaian hari ini</span>
                    </div>
                  )}
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
