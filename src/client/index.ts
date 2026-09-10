/**
 * Client-half entry of the kenari-usage plugin (bundled by build.mjs into
 * dist/client.js, loaded by the shell's module loader).
 *
 * Registers one surface: the usage dock line in the host's
 * `conversation.composer.dock` slot. The proven registration pattern is the
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
 * Client plugin body: mounts the Kenari usage dock into the composer.
 * @param ctx - the client cordis context (slots service).
 */
export function apply(ctx: KenariClientContext): void {
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.composer.dock',
        id: 'kenari-usage-dock',
        order: 20,
        label: 'Kenari usage dock',
      },
      KenariDock,
    ),
  )
}
