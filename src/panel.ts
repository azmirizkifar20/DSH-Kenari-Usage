/**
 * Kenari usage panel — thin DOM wrapper over the shared `formatUsage`.
 *
 * Slot support (checked against the installed harness):
 * - `node_modules/@deepseek-ai` contains only cordis, dsh-llm, dsh-tools and
 *   schemastery — no `@deepseek-ai/dsh-client-*` packages, so the reference
 *   plugin's `conversation.composer.dock` / `settings.section` seats do NOT
 *   exist in this install.
 * - The surface this install DOES support is tool-owned UI presentation
 *   (`presentCall` / `presentResult` generic card, already wired in
 *   `kenari-usage.ts`).
 * - This module is therefore a framework-free DOM panel: mount it into any
 *   host-provided slot element via `createKenariPanel(root, load)`. All
 *   percentages/countdowns come from the SAME `formatUsage` as the tool —
 *   no duplicated formatting logic.
 *
 * Behavior: manual Refresh only (debounced 1000ms, aborts the prior
 * request, button disabled while fetching); the reset countdown is computed
 * once per fetch and decremented locally for display (1s display timer,
 * never refetches — `pollIntervalSecs` stays 0/off). Offline/401 failures
 * render an error card, dim the last data, and offer Retry.
 */

import { formatCountdown, formatUsage, type ParsedUsage } from './format.js'

/** Minimum gap between manual refreshes (ms). Rapid clicks collapse to one fetch. */
export const REFRESH_DEBOUNCE_MS = 1000

/** Local display-tick cadence (ms). Updates countdown text only — never fetches. */
export const DISPLAY_TICK_MS = 1000

/** Loads usage windows; throws on offline/401/malformed (surfaced in the error card). */
export type PanelLoader = (signal: AbortSignal) => Promise<ParsedUsage>

export interface PanelOptions {
  /** Clock override (tests). Defaults to Date.now. */
  now?: () => number
}

export interface PanelHandle {
  /** Manual refresh; `force` bypasses the debounce (used by Retry + initial load). */
  refresh: (force?: boolean) => void
  /** Abort in-flight fetch, stop the display timer, unmount. */
  destroy: () => void
}

interface LastData {
  weekPercent: string
  monthPercent: string
  weekSecs: number
  monthSecs: number
  fetchedAt: number
}

function describeCountdown(secs: number): string {
  if (secs === 0) return 'resets now'
  return `resets in ${formatCountdown(secs)}`
}

export function createKenariPanel(
  root: HTMLElement,
  load: PanelLoader,
  options: PanelOptions = {},
): PanelHandle {
  const now = options.now ?? Date.now
  const doc = root.ownerDocument

  const panel = doc.createElement('div')
  panel.setAttribute('data-testid', 'kenari-panel')

  const weekRow = doc.createElement('div')
  weekRow.setAttribute('data-testid', 'kenari-week')
  weekRow.textContent = 'Week: —'
  const monthRow = doc.createElement('div')
  monthRow.setAttribute('data-testid', 'kenari-month')
  monthRow.textContent = 'Month: —'

  const errorCard = doc.createElement('div')
  errorCard.setAttribute('data-testid', 'kenari-error')
  errorCard.style.display = 'none'
  const errorText = doc.createElement('span')
  errorText.setAttribute('data-testid', 'kenari-error-text')
  const retryBtn = doc.createElement('button')
  retryBtn.setAttribute('data-testid', 'kenari-retry')
  retryBtn.textContent = 'Retry'
  errorCard.appendChild(errorText)
  errorCard.appendChild(retryBtn)

  const refreshBtn = doc.createElement('button')
  refreshBtn.setAttribute('data-testid', 'kenari-refresh')
  refreshBtn.textContent = 'Refresh'

  panel.appendChild(weekRow)
  panel.appendChild(monthRow)
  panel.appendChild(errorCard)
  panel.appendChild(refreshBtn)
  root.appendChild(panel)

  let destroyed = false
  let inFlight: AbortController | null = null
  let lastAttempt = Number.NEGATIVE_INFINITY
  let last: LastData | null = null

  const setFetching = (active: boolean): void => {
    refreshBtn.disabled = active
  }

  const renderCountdowns = (): void => {
    if (last === null) return
    const elapsedSecs = Math.max(0, Math.floor((now() - last.fetchedAt) / 1000))
    const weekLeft = Math.max(0, last.weekSecs - elapsedSecs)
    const monthLeft = Math.max(0, last.monthSecs - elapsedSecs)
    weekRow.textContent = `Week: ${last.weekPercent} — ${describeCountdown(weekLeft)}`
    monthRow.textContent = `Month: ${last.monthPercent} — ${describeCountdown(monthLeft)}`
  }

  const onSuccess = (parsed: ParsedUsage): void => {
    const formatted = formatUsage(parsed)
    last = {
      weekPercent: formatted.card.week.percent,
      monthPercent: formatted.card.month.percent,
      weekSecs: parsed.week.resets_in_secs,
      monthSecs: parsed.month.resets_in_secs,
      fetchedAt: now(),
    }
    errorCard.style.display = 'none'
    weekRow.style.opacity = ''
    monthRow.style.opacity = ''
    renderCountdowns()
  }

  const onError = (err: unknown, ctrl: AbortController): void => {
    // A superseded request settling after abort is not a failure.
    if (destroyed || ctrl.signal.aborted) return
    const message = err instanceof Error ? err.message : String(err)
    errorText.textContent = message
    errorCard.style.display = ''
    if (last !== null) {
      weekRow.style.opacity = '0.5'
      monthRow.style.opacity = '0.5'
    }
  }

  const refresh = (force = false): void => {
    if (destroyed) return
    const startedAt = now()
    if (!force && startedAt - lastAttempt < REFRESH_DEBOUNCE_MS) return
    lastAttempt = startedAt
    if (inFlight !== null) inFlight.abort()
    const ctrl = new AbortController()
    inFlight = ctrl
    setFetching(true)
    void load(ctrl.signal).then(
      (parsed) => {
        if (inFlight !== ctrl) return
        inFlight = null
        setFetching(false)
        onSuccess(parsed)
      },
      (err: unknown) => {
        if (inFlight !== ctrl) return
        inFlight = null
        setFetching(false)
        onError(err, ctrl)
      },
    )
  }

  refreshBtn.addEventListener('click', () => {
    refresh(false)
  })
  retryBtn.addEventListener('click', () => {
    refresh(true)
  })

  // Display-only tick: decrements the shown countdown from the stored
  // fetched-at timestamp. Never fetches (polling stays off).
  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    if (!destroyed) renderCountdowns()
  }, DISPLAY_TICK_MS)

  // Initial load (forced: bypasses the debounce so the panel is never blank).
  refresh(true)

  return {
    refresh,
    destroy: () => {
      destroyed = true
      clearInterval(timer)
      if (inFlight !== null) inFlight.abort()
      inFlight = null
      panel.remove()
    },
  }
}
