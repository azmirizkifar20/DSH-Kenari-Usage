import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { formatUsage, parseSubscription, type ParsedUsage } from './format.js'

export const name = 'kenari-usage'

export const inject = ['tools']

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

/** Per-attempt fetch timeout (ms). */
const FETCH_TIMEOUT_MS = 8000

const DEFAULT_ENDPOINT = 'https://kenari.id/api/subscription'

/** Endpoint cell set by apply(); defaults to the plan endpoint for direct tool use. */
let activeEndpoint: string = DEFAULT_ENDPOINT

interface UsageWindow {
  used_frac: number
  resets_in_secs: number
}

interface SuccessValue {
  week: UsageWindow
  month: UsageWindow
}

interface ErrorValue {
  error: string
  retryable: boolean
}

type ToolValue = SuccessValue | ErrorValue

function isErrorValue(value: ToolValue): value is ErrorValue {
  return 'error' in value
}

type MetaRecord = Record<string, string | boolean>

function errorMeta(scope: string, v: ErrorValue): MetaRecord {
  return { ok: false, window: scope, error: v.error, retryable: v.retryable }
}

function okMeta(scope: string, v: SuccessValue): MetaRecord {
  const formatted = formatUsage(v)
  return {
    ok: true,
    window: scope,
    overQuota: formatted.meta.overQuota,
    resetsNowWeek: formatted.meta.resetsNow.week,
    resetsNowMonth: formatted.meta.resetsNow.month,
    weekPercent: formatted.card.week.percent,
    monthPercent: formatted.card.month.percent,
  }
}

const outputSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        week: {
          type: 'object',
          additionalProperties: false,
          required: true,
          properties: {
            used_frac: { type: 'number', required: true },
            resets_in_secs: { type: 'number', required: true },
          },
        },
        month: {
          type: 'object',
          additionalProperties: false,
          required: true,
          properties: {
            used_frac: { type: 'number', required: true },
            resets_in_secs: { type: 'number', required: true },
          },
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        error: { type: 'string', required: true },
        retryable: { type: 'boolean', required: true },
      },
    },
  ],
} as const

function errorText(value: ErrorValue): string {
  return value.error
}

/** Fetch with per-attempt timeout, honoring caller cancellation. Throws on caller abort. */
async function fetchJsonOnce(endpoint: string, callerSignal: AbortSignal): Promise<Response> {
  const ctrl = new AbortController()
  const onCallerAbort = (): void => {
    ctrl.abort(callerSignal.reason)
  }
  if (callerSignal.aborted) {
    throw callerSignal.reason instanceof Error
      ? callerSignal.reason
      : new Error('aborted')
  }
  callerSignal.addEventListener('abort', onCallerAbort, { once: true })
  const timer = setTimeout(() => {
    ctrl.abort(new Error('fetch timeout after 8000ms'))
  }, FETCH_TIMEOUT_MS)
  try {
    return await fetch(endpoint, {
      credentials: 'include',
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
    callerSignal.removeEventListener('abort', onCallerAbort)
  }
}

async function loadUsage(endpoint: string, callerSignal: AbortSignal): Promise<ToolValue> {
  let lastNetworkError: string = 'unknown fetch failure'
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let res: Response
    try {
      res = await fetchJsonOnce(endpoint, callerSignal)
    } catch (err) {
      if (callerSignal.aborted) throw err
      lastNetworkError = err instanceof Error ? err.message : String(err)
      if (attempt === 0) continue
      return { error: `Kenari subscription fetch failed: ${lastNetworkError}`, retryable: true }
    }
    if (!res.ok) {
      if (res.status >= 400 && res.status < 500) {
        if (res.status === 401) {
          return {
            error: 'Kenari session expired (401) — re-login in browser, then retry.',
            retryable: false,
          }
        }
        return { error: `Kenari subscription request failed (${res.status})`, retryable: false }
      }
      if (attempt === 0) continue
      return { error: `Kenari subscription request failed (${res.status})`, retryable: true }
    }
    let json: unknown
    try {
      json = await res.json()
    } catch {
      return { error: 'Kenari subscription response malformed: invalid JSON', retryable: false }
    }
    try {
      const parsed: ParsedUsage = parseSubscription(json)
      return {
        week: { used_frac: parsed.week.used_frac, resets_in_secs: parsed.week.resets_in_secs },
        month: { used_frac: parsed.month.used_frac, resets_in_secs: parsed.month.resets_in_secs },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { error: `Kenari subscription response malformed: ${msg}`, retryable: false }
    }
  }
  return { error: `Kenari subscription fetch failed: ${lastNetworkError}`, retryable: true }
}

export const kenariUsageTool = defineTool({
  name: 'kenari_usage',
  description:
    'Show Kenari weekly and monthly usage as percentages plus reset countdowns. No arguments returns both windows.',
  parameters: {
    window: {
      type: 'string',
      enum: ['week', 'month'],
      description: "Optional scope filter for display only; execute always returns both windows.",
    },
  },
  output: {
    schema: outputSchema,
    render: (args, value) => {
      void args
      const v = value as ToolValue
      if (isErrorValue(v)) {
        return [{ type: 'text', text: errorText(v) }]
      }
      return [{ type: 'text', text: formatUsage(v).text }]
    },
    presentationMeta: (args, value) => {
      const v = value as ToolValue
      const scope = (args as { window?: string }).window ?? 'both'
      if (isErrorValue(v)) return errorMeta(scope, v)
      return okMeta(scope, v)
    },
  },
  isConcurrencySafe: () => true,
  async execute(args, exec) {
    void args
    return loadUsage(activeEndpoint, exec.signal) as Promise<SuccessValue | ErrorValue>
  },
  presentCall: (args) => {
    const scope = (args as { window?: string }).window
    return {
      card: 'generic',
      title: scope === 'week' || scope === 'month' ? `Check Kenari usage (${scope})` : 'Check Kenari usage',
      kind: 'fetch',
      rawInput: args,
    }
  },
  presentResult: (_args, result) => {
    if (result.isError) {
      return { card: 'generic', title: 'Kenari usage — error', content: result.content }
    }
    const meta = result.meta as
      | { ok?: boolean; error?: string; retryable?: boolean }
      | undefined
    if (meta !== undefined && meta !== null && (meta as { ok?: unknown }).ok === false) {
      const err = typeof meta.error === 'string' ? meta.error : ''
      const needsLogin = /401|re-login|session expired/i.test(err)
      return {
        card: 'generic',
        title: needsLogin ? 'Kenari usage — re-login required' : 'Kenari usage — error',
        content: result.content,
      }
    }
    return { card: 'generic', title: 'Kenari usage', content: result.content }
  },
})

export function apply(ctx: Context, config: Config) {
  activeEndpoint = config.endpoint
  ctx.tools.register(kenariUsageTool)
  console.log('[kenari-usage] plugin loaded!')
}
