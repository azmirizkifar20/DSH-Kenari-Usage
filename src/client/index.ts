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
 * viewports so ~310px stays free on the right for the floating Kenari card.
 *
 * Derivation (read from the installed host bundle
 * `@deepseek-ai/dsh-client-ui-conversation` lib/client.js, classes quoted
 * here for provenance only — they are hashed/fragile and NOT referenced):
 * - The conversation root declares
 *   `--dsh-chat-content-width:var(--dsh-chat-user-width,clamp(680px,
 *   calc(var(--dsh-conversation-column-width,0px) * .64), 920px))` (line
 *   14652), and the transcript column is
 *   `width:100%; max-width:var(--dsh-chat-content-width); margin:0 auto`
 *   (centered); composer widths derive via
 *   `--dsh-composer-card-max-width:calc(var(--dsh-chat-content-width)+32px)`.
 * - Overriding `--dsh-chat-user-width` therefore narrows the whole family at
 *   once with no hashed selectors. The `!important` is load-bearing, not
 *   cosmetic: bundle lines 14818-14819 (`if (preference === null)
 *   root.style.removeProperty("--dsh-chat-user-width"); else
 *   root.style.setProperty(...)`) plus line 14843 (drag handler
 *   `setProperty`) and the `dsh.conversation.contentWidth` localStorage key
 *   (line 14691) prove the host writes `--dsh-chat-user-width` INLINE on the
 *   conversation root whenever a width preference exists — and an author
 *   `!important` declaration beats a normal inline style, custom props
 *   included. The `*` selector (not just `:root`) matters for the same
 *   reason: an inherited `:root` value loses to a direct inline value on the
 *   descendant, but `*` gives the conversation root itself a cascaded author
 *   `!important` value, which wins. Tradeoff, stated openly: while this tag
 *   is mounted a stored drag preference is superseded; removing the plugin
 *   restores it (host removes its own inline prop when no preference exists).
 * - Lane math (treating the conversation column as ~100vw): the card is
 *   270px wide at right:24, i.e. a 294px lane; wanting 294 + ~16 breathing =
 *   ~310px free on the right of a centered column of width W in viewport V
 *   gives (V-W)/2 >= 310, i.e. W <= V-620. `calc(100vw - 640px)` holds a
 *   constant 320px margin on each side while unclamped (left margin
 *   recenters equally, so the column max is 100vw - 310 - leftGutter with
 *   leftGutter = 330 absorbed symmetrically); the `max(480px, …)` floor
 *   keeps text readable and the `min(720px, …)` ceiling lets the lane keep
 *   growing on ultrawide.
 *   Worked examples (right margin = (V-W)/2, need >= 310):
 *   - V=1280: W = max(480, min(720, 1280-640=640)) = 640;
 *     margin = (1280-640)/2 = 320 >= 310 ✓ (stock ~819 → ~230, overlap).
 *   - V=1920: W = max(480, min(720, 1920-640=1280)) = 720 (ceiling binds);
 *     margin = (1920-720)/2 = 600 >= 310 ✓.
 *   - V=1150 (breakpoint edge): W = 1150-640 = 510;
 *     margin = (1150-510)/2 = 320 >= 310 ✓.
 * - `@media (min-width:1150px)` releases the override below 1150px, so
 *   narrow windows keep the stock centered layout untouched (the prior
 *   1400px breakpoint never fired on typical <1400px-wide windows, which is
 *   why the screenshot showed no effect even where the cascade won).
 */
const KENARI_LAYOUT_CSS = `@media (min-width: 1150px) {
  *, :root {
    --dsh-chat-user-width: max(480px, min(720px, calc(100vw - 640px))) !important;
  }
}
`

/**
 * Ensures the single host-layout `<style>` override tag exists and returns
 * its remover for the callback disposer chain. Reuses the existing tag when
 * called twice (guarded by the data-attribute check) and is a no-op without
 * a DOM. Throw-safe: any DOM exception (missing head, CSP, SSR quirk) falls
 * back to `documentElement` and finally to a no-op remover, so a style
 * failure can never break slot registration.
 */
function ensureKenariLayoutStyle(): () => void {
  try {
    if (typeof document === 'undefined') return () => undefined
    const existing = document.querySelector(`style[${LAYOUT_STYLE_ATTR}="${LAYOUT_STYLE_VALUE}"]`)
    if (existing !== null) return () => existing.remove()
    const el = document.createElement('style')
    el.setAttribute(LAYOUT_STYLE_ATTR, LAYOUT_STYLE_VALUE)
    el.textContent = KENARI_LAYOUT_CSS
    const parent = document.head ?? document.documentElement
    if (parent == null) return () => undefined
    parent.appendChild(el)
    return () => el.remove()
  } catch {
    return () => undefined
  }
}

/**
 * Client plugin body: mounts the Kenari usage card into the session header
 * and applies the host-column layout override while the slot is live.
 * @param ctx - the client cordis context (slots service).
 */
export function apply(ctx: KenariClientContext): void {
  // Eager top-level injection: the slots.inject callback only fires once the
  // host declares the slot, which may never happen on some shells/routes —
  // and the screenshot showed exactly that (no effect at all). Injecting here
  // too (guarded by the data-attribute check, so the callback adopts the same
  // tag and its disposer still removes it) makes the lane override live from
  // boot regardless of slot timing.
  ensureKenariLayoutStyle()
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
