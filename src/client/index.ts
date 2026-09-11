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
 * While mounted, the client half also injects one
 * `<style data-kenari-layout="1">` tag that narrows the host's centered chat
 * column at wide viewports, freeing a ~300px right lane for the floating
 * Kenari card (fixed, right:24, w:270). The tag is removed by the disposer
 * returned from the slots.inject callback chain. See KENARI_LAYOUT_CSS for
 * the calc derivation.
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

/** Marker attribute/value for the injected host-layout override tag. */
const LAYOUT_STYLE_ATTR = 'data-kenari-layout'
const LAYOUT_STYLE_VALUE = '1'

/**
 * Host-column override CSS: narrows the centered chat column at wide
 * viewports so ~300px stays free on the right for the floating Kenari card.
 *
 * Derivation (read from the host bundle
 * `@deepseek-ai/dsh-client-ui-conversation` lib/client.js, classes quoted
 * here for provenance only — they are hashed/fragile and NOT referenced):
 * - The conversation root (`.wSkVaW_root`) declares
 *   `--dsh-chat-content-width: var(--dsh-chat-user-width, clamp(680px,
 *   calc(var(--dsh-conversation-column-width,0px) * .64), 920px))`, and the
 *   transcript column (chat bundle `.EvIC1a_column`) is
 *   `width:100%; max-width:var(--dsh-chat-content-width); margin:0 auto`
 *   (centered); composer widths derive via
 *   `--dsh-composer-card-max-width: calc(var(--dsh-chat-content-width)+32px)`.
 * - Overriding `--dsh-chat-user-width` on `:root` (stable semantic var,
 *   inherited down) therefore narrows the whole family at once with no
 *   hashed selectors and no `!important`. Host JS only sets
 *   `--dsh-chat-user-width` inline on the conversation root when the user has
 *   an explicit width preference (localStorage `dsh.conversation.contentWidth`,
 *   clamped to `[640, column-176]`) — inline wins over the inherited value,
 *   so an explicit user width still takes precedence over this override.
 * - Lane math (treating the conversation column as ~100vw): the card is
 *   270px wide at right:24, i.e. a 294px ≈ 300px lane. A centered column of
 *   width W in viewport V leaves (V-W)/2 on the right; wanting ≥ ~310px
 *   (lane + clearance) gives W ≤ V-620. `calc(100vw - 720px)` holds a
 *   constant 360px margin while unclamped; the `max(560px, …)` floor keeps
 *   text readable and the `min(760px, …)` ceiling lets the lane keep growing
 *   on ultrawide. At V=1400: W=680 (vs stock 896), right margin 360 vs the
 *   294 the card needs → 66px gap, where stock overlapped by ~42px.
 * - `@media (min-width:1400px)` releases the override below 1400px, so narrow
 *   windows keep the stock centered layout untouched.
 */
const KENARI_LAYOUT_CSS = `@media (min-width: 1400px) {
  :root {
    --dsh-chat-user-width: max(560px, min(760px, calc(100vw - 720px)));
  }
}
`

/**
 * Ensures the single host-layout `<style>` override tag exists and returns
 * its remover for the callback disposer chain. Reuses the existing tag when
 * called twice (guarded by the data-attribute check) and is a no-op without
 * a DOM.
 */
function ensureKenariLayoutStyle(): () => void {
  if (typeof document === 'undefined') return () => undefined
  const existing = document.querySelector(`style[${LAYOUT_STYLE_ATTR}="${LAYOUT_STYLE_VALUE}"]`)
  if (existing !== null) return () => existing.remove()
  const el = document.createElement('style')
  el.setAttribute(LAYOUT_STYLE_ATTR, LAYOUT_STYLE_VALUE)
  el.textContent = KENARI_LAYOUT_CSS
  document.head.appendChild(el)
  return () => el.remove()
}

/**
 * Client plugin body: mounts the Kenari usage card into the session header
 * and applies the host-column layout override while the slot is live.
 * @param ctx - the client cordis context (slots service).
 */
export function apply(ctx: KenariClientContext): void {
  ctx.slots.inject('conversation.session.header.utilities', () => {
    const removeLayoutStyle = ensureKenariLayoutStyle()
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
      removeLayoutStyle()
    }
  })
}
