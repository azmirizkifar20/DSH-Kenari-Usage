/**
 * Client-half entry of the kenari-usage plugin (bundled by build.mjs into
 * dist/client.js, loaded by the shell's module loader).
 *
 * Registers one surface: the usage card in the host's
 * `conversation.session.header.utilities` slot (top-right header bar).
 * The proven registration pattern is the
 * same one dsh-better-sidebar uses — `slots.inject(key, ...)` waits for the
 * host to declare the slot, then `slots.register(...)` contributes the
 * component and returns the disposer.
 *
 * Same-origin fetches only (`src/client/api.ts`); no secrets, no settings
 * section, no host-module imports — the browser bundle resolves react and
 * @deepseek-ai/* as platform externals provided by the shell.
 */

import { KenariDock } from './KenariDock.js'

/** Module identity in the client module table. */
export const name = 'kenari-usage-client'

/** Services required from the client runtime before apply runs. */
export const inject = ['slots']

/** The slice of the client slots service this plugin consumes (structural,
 *  mirrored from the runtime contract proven by dsh-better-sidebar). */
interface DockSlotsService {
  /** Contribute a component to a declared slot; returns the disposer. */
  register(
    options: {
      name: string
      id?: string
      order?: number
      label?: string | (() => string)
    },
    component: unknown,
  ): () => void
  /** Run the callback once the named slot is declared (no-op until then). */
  inject(key: string, callback: () => () => void): () => void
}

/** The client context face this plugin needs (minimal structural type). */
export interface KenariClientContext {
  slots: DockSlotsService
}

/**
 * Client plugin body: mounts the Kenari usage card into the session header.
 * @param ctx - the client cordis context (slots service).
 */
export function apply(ctx: KenariClientContext): void {
  ensureLayoutLane()
  ctx.slots.inject('conversation.session.header.utilities', () => {
    // Best-effort idempotent re-inject: if the host cleared <head>, restore it.
    ensureLayoutLaneQuiet()
    const disposeDock = ctx.slots.register(
      {
        name: 'conversation.session.header.utilities',
        id: 'kenari-usage-dock',
        order: 20,
        label: 'Kenari usage dock',
      },
      KenariDock,
    )
    return () => {
      disposeDock()
      removeLayoutLane()
    }
  })
}

// Right-lane width override: supersedes the host width-drag while mounted
// (accepted tradeoff — the !important custom property wins over drag state).
const LAYOUT_CSS =
  '@media (min-width: 1150px) { *, :root { --dsh-chat-user-width: max(480px, min(720px, calc(100vw - 640px))) !important; } }'

function ensureLayoutLane(): void {
  console.info('[kenari-usage] layout lane inject: attempting')
  try {
    if (typeof document === 'undefined') {
      throw new Error('no document')
    }
    if (document.querySelector('style[data-kenari-layout]')) {
      console.info('[kenari-usage] layout lane active: style tag present')
      return
    }
    const style = document.createElement('style')
    style.setAttribute('data-kenari-layout', '1')
    style.textContent = LAYOUT_CSS
    ;(document.head ?? document.documentElement).appendChild(style)
    console.info('[kenari-usage] layout lane active: style tag present')
  } catch (err) {
    console.warn('[kenari-usage] layout lane inactive:', err instanceof Error ? err.message : err)
  }
}

function ensureLayoutLaneQuiet(): void {
  try {
    if (typeof document === 'undefined') return
    if (document.querySelector('style[data-kenari-layout]')) return
    const style = document.createElement('style')
    style.setAttribute('data-kenari-layout', '1')
    style.textContent = LAYOUT_CSS
    ;(document.head ?? document.documentElement).appendChild(style)
  } catch {
    // Best-effort only — apply() already reported the lane state.
  }
}

function removeLayoutLane(): void {
  try {
    document.querySelector('style[data-kenari-layout]')?.remove()
  } catch {
    // Throw-safe teardown.
  }
}
