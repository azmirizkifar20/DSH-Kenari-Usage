import type { Context } from '@deepseek-ai/cordis'

export const name = 'kenari-usage'

export function apply(ctx: Context) {
  // Minimal loadable plugin — no fetch/format logic yet (Todo 3-4).
  void ctx
  console.log('[kenari-usage] plugin loaded!')
}
