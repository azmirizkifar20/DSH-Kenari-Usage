import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'kenari-usage'

export interface Config {
  endpoint: string
  cookieName?: string
  pollIntervalSecs?: number
}

export const Config: Schema<Config> = Schema.object({
  endpoint: Schema.string()
    .pattern(/^https?:\/\/.+/)
    .default('https://kenari.id/api/subscription')
    .description('Kenari subscription endpoint (override via cordis.yml, no code edit needed).'),
  cookieName: Schema.string().description('Optional ambient session cookie name (no secret value stored).'),
  pollIntervalSecs: Schema.number().min(0).default(0).description('Poll interval in seconds, 0 = off.'),
})

export function apply(ctx: Context, config: Config) {
  // Minimal loadable plugin — no fetch/format logic yet (Todo 3-4).
  // Config is validated by Schemastery; never log config values (no secrets).
  void ctx
  void config
  console.log('[kenari-usage] plugin loaded!')
}
