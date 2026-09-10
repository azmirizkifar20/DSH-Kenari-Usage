import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { formatUsage, parseSubscription, type ParsedUsage } from './format.js'

export const name = 'kenari-usage'

export const inject = ['tools']

export interface Config {
  endpoint: string
  cookieName?: string
  sessionCookie?: string
  pollIntervalSecs?: number
}

export const Config: Schema<Config> = Schema.object({
  endpoint: Schema.string()
    .pattern(/^https?:\/\/.+/)
    .default('https://kenari.id/api/subscription')
    .description('Kenari subscription endpoint (override via cordis.yml, no code edit needed).'),
  cookieName: Schema.string()
    .default('kn_session')
    .description('Kenari session cookie name, sent as the Cookie header.'),
  sessionCookie: Schema.string().description(
    'Kenari session cookie value (secret — set via the profile cordis.patch.yml, never committed to git).',
  ),
  pollIntervalSecs: Schema.number().min(0).default(0).description('Poll interval in seconds, 0 = off.'),
})

/** Per-attempt fetch timeout (ms). */
const FETCH_TIMEOUT_MS = 8000

const DEFAULT_ENDPOINT = 'https://kenari.id/api/subscription'

/** Config cells set by apply(); endpoint default allows direct tool use in tests. */
let activeEndpoint: string = DEFAULT_ENDPOINT
let activeCookieName: string = 'kn_session'
let activeCookieValue: string | undefined
let activePollIntervalSecs: number = 0

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
    const headers: Record<string, string> = {
      Cookie: `${activeCookieName}=${activeCookieValue}`,
    }
    return await fetch(endpoint, {
      headers,
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
    callerSignal.removeEventListener('abort', onCallerAbort)
  }
}

async function loadUsage(endpoint: string, callerSignal: AbortSignal): Promise<ToolValue> {
  if (activeCookieValue === undefined || activeCookieValue === '') {
    return {
      error:
        'Kenari sessionCookie is not configured — set sessionCookie in the profile cordis.patch.yml (id: kenari-usage), then restart dsh web.',
      retryable: false,
    }
  }
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
            error:
              'Kenari session expired (401) — copy the fresh kn_session cookie value into sessionCookie in the profile cordis.patch.yml (id: kenari-usage), then restart dsh web.',
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
  if (config.cookieName !== undefined && config.cookieName !== '') {
    activeCookieName = config.cookieName
  }
  activeCookieValue = config.sessionCookie
  activePollIntervalSecs = config.pollIntervalSecs ?? 0
  ctx.tools.register(kenariUsageTool)
  installUsageRoute(ctx)
  console.log('[kenari-usage] plugin loaded!')
}

/** Same-origin host route path for the usage panel (no secrets in URL). */
const USAGE_ROUTE_PATH = '/dsh-kenari-usage'

/** Outer budget for one route request (covers both 8s fetch attempts). */
const ROUTE_TIMEOUT_MS = 30000

/** Structural mirror of the host-webserver request face (subset the route reads). */
interface UsageHttpRequest {
  url?: string
  method?: string
}

/** Structural mirror of the host-webserver response face (subset the route writes). */
interface UsageHttpResponse {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string): void
}

/** Structural mirror of the host-webserver exact route registration. */
interface UsageWebServer {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: UsageHttpRequest, res: UsageHttpResponse) => void | Promise<void>
  }): () => void
}

function pollIntervalMsOf(secs: number): number {
  return secs >= 60 ? Math.floor(secs * 1000) : 60000
}

function writeUsageJson(res: UsageHttpResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

/**
 * GET /dsh-kenari-usage handler. Fetches fresh on every request (no caching;
 * `?refresh=1` is accepted as a no-op). Never includes secrets in the
 * response — only aggregate numbers and precomputed display strings.
 */
async function handleUsageRequest(
  req: UsageHttpRequest,
  res: UsageHttpResponse,
): Promise<void> {
  if (req.method !== undefined && req.method !== 'GET') {
    writeUsageJson(res, 405, {
      ok: false,
      error: 'Method not allowed — use GET /dsh-kenari-usage',
      retryable: false,
    })
    return
  }
  let value: ToolValue
  try {
    value = await loadUsage(activeEndpoint, AbortSignal.timeout(ROUTE_TIMEOUT_MS))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    writeUsageJson(res, 502, {
      ok: false,
      error: `Kenari usage request failed: ${message}`,
      retryable: true,
    })
    return
  }
  if (isErrorValue(value)) {
    writeUsageJson(res, 502, { ok: false, error: value.error, retryable: value.retryable })
    return
  }
  const formatted = formatUsage(value)
  writeUsageJson(res, 200, {
    ok: true,
    week: {
      used_frac: value.week.used_frac,
      resets_in_secs: value.week.resets_in_secs,
      percent: formatted.card.week.percent,
      countdown: formatted.card.week.countdown,
    },
    month: {
      used_frac: value.month.used_frac,
      resets_in_secs: value.month.resets_in_secs,
      percent: formatted.card.month.percent,
      countdown: formatted.card.month.countdown,
    },
    serverTime: Date.now(),
    pollIntervalMs: pollIntervalMsOf(activePollIntervalSecs),
  })
}

/** Lazy webServer lookup — undefined until the host mounts the service. */
function getUsageWebServer(ctx: Context): UsageWebServer | undefined {
  try {
    const svc = ctx.get('webServer') as UsageWebServer | undefined
    if (svc === undefined || svc === null) return undefined
    if (typeof svc.register !== 'function') return undefined
    return svc
  } catch {
    return undefined
  }
}

/**
 * Register the exact host route, retrying when the webServer service appears
 * later. All lookups are guarded so direct tool use (mock ctx without
 * get/on/effect) keeps working. The route disposer runs on ctx dispose.
 */
function installUsageRoute(ctx: Context): void {
  let disposeRoute: (() => void) | undefined
  const tryInstall = (): void => {
    if (disposeRoute !== undefined) return
    const webServer = getUsageWebServer(ctx)
    if (webServer === undefined) return
    disposeRoute = webServer.register({
      kind: 'exact',
      path: USAGE_ROUTE_PATH,
      handler: handleUsageRequest,
    })
  }
  tryInstall()
  try {
    if (typeof ctx.on === 'function') {
      ctx.on('internal/service', (name: unknown) => {
        if (name === 'webServer') tryInstall()
      })
    }
  } catch {
    // No event surface (direct tool use) — the tool registration above stands alone.
  }
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        disposeRoute?.()
        disposeRoute = undefined
      })
    }
  } catch {
    // No effect surface — nothing to clean up.
  }
}
