import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { formatUsage, parseSubscription, type ParsedUsage } from './format.js'
import {
  formatResetShort,
  formatRp,
  parseQuota,
  parseUsageMarkdown,
  type ParsedModelUsage,
  type ParsedQuota,
} from './quota.js'

export const name = 'kenari-usage'

export const inject = ['tools']

export interface Config {
  endpoint: string
  cookieName?: string
  sessionCookie?: string
  apiKey?: string
  pollIntervalSecs?: number
}

export const Config: Schema<Config> = Schema.object({
  endpoint: Schema.string()
    .pattern(/^https?:\/\/.+/)
    .default('https://kenari.id/api/subscription')
    .description(
      'Deprecated fallback: Kenari subscription endpoint for the cookie path (unused when apiKey is set).',
    ),
  cookieName: Schema.string()
    .default('kn_session')
    .description('Deprecated fallback: Kenari session cookie name, sent as the Cookie header.'),
  sessionCookie: Schema.string().description(
    'Deprecated fallback: Kenari session cookie value (secret — profile cordis.patch.yml only, never commit). Ignored when apiKey is set.',
  ),
  apiKey: Schema.string().description(
    'Kenari API key (kn-... secret — set via the profile cordis.patch.yml, never commit it). When set and non-empty the official Bearer API is used; otherwise the deprecated sessionCookie fallback applies.',
  ),
  pollIntervalSecs: Schema.number().min(0).default(0).description('Poll interval in seconds, 0 = off.'),
})

/** Per-attempt fetch timeout (ms). */
const FETCH_TIMEOUT_MS = 8000

const DEFAULT_ENDPOINT = 'https://kenari.id/api/subscription'

/** Official Bearer API endpoints. */
export const QUOTA_URL = 'https://kenari.id/v1/account/quota'
export const MCP_URL = 'https://kenari.id/mcp'

/** Config cells set by apply(); endpoint default allows direct tool use in tests. */
let activeEndpoint: string = DEFAULT_ENDPOINT
let activeCookieName: string = 'kn_session'
let activeCookieValue: string | undefined
let activeApiKey: string | undefined
let activePollIntervalSecs: number = 0

interface UsageWindow {
  used_frac: number
  resets_in_secs: number
}

interface SuccessValue {
  week: UsageWindow
  month: UsageWindow
}

interface ModelUsagePayload extends ParsedModelUsage {
  window: '30d'
}

interface QuotaSuccessValue {
  quota: ParsedQuota
  usage: ModelUsagePayload | null
}

interface ErrorValue {
  error: string
  retryable: boolean
}

type ToolValue = SuccessValue | QuotaSuccessValue | ErrorValue

function isErrorValue(value: ToolValue): value is ErrorValue {
  return 'error' in value
}

function isQuotaValue(value: ToolValue): value is QuotaSuccessValue {
  return 'quota' in value
}

type MetaRecord = Record<string, string | boolean>

function errorMeta(scope: string, v: ErrorValue): MetaRecord {
  return { ok: false, window: scope, error: v.error, retryable: v.retryable }
}

function okMeta(scope: string, v: SuccessValue | QuotaSuccessValue): MetaRecord {
  if (isQuotaValue(v)) {
    return {
      ok: true,
      window: scope,
      plan: v.quota.plan ?? '',
      hasUsage: v.usage !== null,
    }
  }
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
        quota: {
          type: 'object',
          required: true,
          additionalProperties: false,
          properties: {
            plan: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            coupon: { type: 'json' },
            week: {
              oneOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    used_rp: { type: 'number', required: true },
                    remaining_rp: { type: 'number', required: true },
                    resets_at: { type: 'string', required: true },
                  },
                },
                { type: 'null' },
              ],
            },
            month: {
              oneOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    used_rp: { type: 'number', required: true },
                    remaining_rp: { type: 'number', required: true },
                    resets_at: { type: 'string', required: true },
                  },
                },
                { type: 'null' },
              ],
            },
          },
        },
        usage: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                window: { type: 'string', required: true },
                models: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      model: { type: 'string', required: true },
                      requests: { type: 'number', required: true },
                      input_tok: { type: 'number', required: true },
                      output_tok: { type: 'number', required: true },
                    },
                  },
                },
                total_requests: { type: 'number', required: true },
                total_tokens: { type: 'number', required: true },
              },
            },
            { type: 'null' },
          ],
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

function formatQuotaText(v: QuotaSuccessValue): string {
  const parts: string[] = []
  const planLabel = v.quota.plan ?? 'unknown plan'
  if (v.quota.week !== null) {
    const w = v.quota.week
    parts.push(
      `Week used ${formatRp(w.used_rp)} / remaining ${formatRp(w.remaining_rp)} (resets ${formatResetShort(w.resets_at)})`,
    )
  }
  if (v.quota.month !== null) {
    const m = v.quota.month
    parts.push(
      `Month used ${formatRp(m.used_rp)} / remaining ${formatRp(m.remaining_rp)} (resets ${formatResetShort(m.resets_at)})`,
    )
  }
  const windows = parts.length > 0 ? parts.join('; ') : 'no quota windows'
  const totals =
    v.usage !== null
      ? `30d totals: ${v.usage.total_requests} requests, ${v.usage.total_tokens} tokens across ${v.usage.models.length} models`
      : 'per-model usage unavailable'
  return `Plan ${planLabel} — ${windows}; ${totals}`
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

/** Bearer fetch with the same per-attempt timeout + caller-abort pattern. */
async function fetchBearerOnce(
  url: string,
  apiKey: string,
  callerSignal: AbortSignal,
  init?: { method?: string; body?: string; accept?: string },
): Promise<Response> {
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
      Authorization: `Bearer ${apiKey}`,
      Accept: init?.accept ?? 'application/json',
    }
    if (init?.body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }
    return await fetch(url, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body,
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

/** Extract the MCP `tools/call` markdown payload, tolerating SSE framing. */
function parseMcpRpcPayload(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === '') {
    throw new TypeError('MCP response is empty')
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed) as unknown
  }
  const payloads: string[] = []
  for (const line of trimmed.split('\n')) {
    const t = line.trim()
    if (t.startsWith('data:')) {
      const payload = t.slice('data:'.length).trim()
      if (payload !== '' && payload !== '[DONE]') payloads.push(payload)
    }
  }
  if (payloads.length === 0) {
    throw new TypeError('MCP response is not JSON (unsupported SSE framing)')
  }
  return JSON.parse(payloads[payloads.length - 1] as string) as unknown
}

function unwrapMcpText(rpc: unknown): string {
  if (typeof rpc !== 'object' || rpc === null) {
    throw new TypeError('MCP response malformed: expected a JSON-RPC object')
  }
  const record = rpc as Record<string, unknown>
  if ('error' in record && record['error'] !== undefined && record['error'] !== null) {
    const msg =
      typeof record['error'] === 'object' && record['error'] !== null
        ? JSON.stringify(record['error'])
        : String(record['error'])
    throw new Error(`MCP tools/call error: ${msg}`)
  }
  const result = record['result']
  if (typeof result !== 'object' || result === null) {
    throw new TypeError('MCP response malformed: missing result')
  }
  const content = (result as Record<string, unknown>)['content']
  if (!Array.isArray(content) || content.length === 0) {
    throw new TypeError('MCP response malformed: missing result.content[0]')
  }
  const first = content[0] as Record<string, unknown>
  if (typeof first['text'] !== 'string') {
    throw new TypeError('MCP response malformed: result.content[0].text is not a string')
  }
  return first['text'] as string
}

async function fetchQuota(apiKey: string, callerSignal: AbortSignal): Promise<ParsedQuota> {
  let res: Response
  let lastNetworkError = 'unknown fetch failure'
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      res = await fetchBearerOnce(QUOTA_URL, apiKey, callerSignal)
    } catch (err) {
      if (callerSignal.aborted) throw err
      lastNetworkError = err instanceof Error ? err.message : String(err)
      if (attempt === 0) continue
      throw new Error(`Kenari quota fetch failed: ${lastNetworkError}`)
    }
    if (!res.ok) {
      if (res.status === 401) {
        throw Object.assign(
          new Error(
            'invalid API key (401) — create a fresh kn- key in the Kenari dashboard and update apiKey in the profile cordis.patch.yml (id: kenari-usage)',
          ),
          { retryable: false, status: 401 },
        )
      }
      if (res.status === 403) {
        throw Object.assign(
          new Error('shared key not allowed (403) — use a personal kn- API key, not a shared one'),
          { retryable: false, status: 403 },
        )
      }
      if (res.status >= 400 && res.status < 500) {
        throw Object.assign(new Error(`Kenari quota request failed (${res.status})`), {
          retryable: false,
          status: res.status,
        })
      }
      if (attempt === 0) continue
      throw Object.assign(new Error(`Kenari quota request failed (${res.status})`), {
        retryable: true,
        status: res.status,
      })
    }
    let json: unknown
    try {
      json = await res.json()
    } catch {
      throw Object.assign(new Error('Kenari quota response malformed: invalid JSON'), {
        retryable: false,
      })
    }
    try {
      return parseQuota(json)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw Object.assign(new Error(`Kenari quota response malformed: ${msg}`), {
        retryable: false,
      })
    }
  }
  throw new Error(`Kenari quota fetch failed: ${lastNetworkError}`)
}

async function fetchModelUsage(
  apiKey: string,
  callerSignal: AbortSignal,
): Promise<ParsedModelUsage> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'kenari_usage', arguments: {} },
  })
  let res: Response
  let lastNetworkError = 'unknown fetch failure'
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      res = await fetchBearerOnce(MCP_URL, apiKey, callerSignal, {
        method: 'POST',
        body,
        accept: 'application/json, text/event-stream',
      })
    } catch (err) {
      if (callerSignal.aborted) throw err
      lastNetworkError = err instanceof Error ? err.message : String(err)
      if (attempt === 0) continue
      throw new Error(`Kenari usage fetch failed: ${lastNetworkError}`)
    }
    if (!res.ok) {
      if (res.status >= 400 && res.status < 500 && attempt === 1) {
        throw new Error(`Kenari usage request failed (${res.status})`)
      }
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`Kenari usage request failed (${res.status})`)
      }
      if (attempt === 0) continue
      throw new Error(`Kenari usage request failed (${res.status})`)
    }
    const raw = await res.text()
    const rpc = parseMcpRpcPayload(raw)
    const text = unwrapMcpText(rpc)
    return parseUsageMarkdown(text)
  }
  throw new Error(`Kenari usage fetch failed: ${lastNetworkError}`)
}

function hasApiKey(): boolean {
  return activeApiKey !== undefined && activeApiKey !== ''
}

/** Bearer path: quota is required, per-model usage is best-effort (null on MCP failure). */
async function loadQuotaUsage(apiKey: string, callerSignal: AbortSignal): Promise<ToolValue> {
  let quota: ParsedQuota
  try {
    quota = await fetchQuota(apiKey, callerSignal)
  } catch (err) {
    if (callerSignal.aborted) throw err
    const msg = err instanceof Error ? err.message : String(err)
    const retryable =
      typeof err === 'object' &&
      err !== null &&
      'retryable' in err &&
      typeof (err as Record<string, unknown>)['retryable'] === 'boolean'
        ? ((err as Record<string, unknown>)['retryable'] as boolean)
        : /fetch failed|request failed \(5\d\d\)/i.test(msg)
    return { error: msg, retryable }
  }
  let usage: ModelUsagePayload | null = null
  try {
    const parsed = await fetchModelUsage(apiKey, callerSignal)
    usage = { window: '30d', ...parsed }
  } catch {
    if (callerSignal.aborted) throw callerSignal.reason
    usage = null
  }
  return { quota, usage }
}

export const kenariUsageTool = defineTool({
  name: 'kenari_usage',
  description:
    'Show Kenari plan quota (weekly/monthly used/remaining Rp) plus 30-day per-model usage. No arguments returns both windows.',
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
      if (isQuotaValue(v)) {
        return [{ type: 'text', text: formatQuotaText(v) }]
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
    if (hasApiKey()) {
      return loadQuotaUsage(activeApiKey as string, exec.signal) as Promise<
        QuotaSuccessValue | ErrorValue
      >
    }
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
      const needsLogin = /401|re-login|session expired|invalid API key/i.test(err)
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
  activeApiKey = config.apiKey
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
  if (hasApiKey()) {
    let value: ToolValue
    try {
      value = await loadQuotaUsage(
        activeApiKey as string,
        AbortSignal.timeout(ROUTE_TIMEOUT_MS),
      )
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
    const quota = (value as QuotaSuccessValue).quota
    const usage = (value as QuotaSuccessValue).usage
    writeUsageJson(res, 200, {
      ok: true,
      plan: quota.plan,
      coupon: quota.coupon ?? null,
      week: quota.week,
      month: quota.month,
      usage:
        usage === null
          ? null
          : {
              window: '30d',
              models: usage.models,
              total_requests: usage.total_requests,
              total_tokens: usage.total_tokens,
            },
      serverTime: Date.now(),
      pollIntervalMs: pollIntervalMsOf(activePollIntervalSecs),
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
  const formatted = formatUsage(value as SuccessValue)
  const legacy = value as SuccessValue
  writeUsageJson(res, 200, {
    ok: true,
    week: {
      used_frac: legacy.week.used_frac,
      resets_in_secs: legacy.week.resets_in_secs,
      percent: formatted.card.week.percent,
      countdown: formatted.card.week.countdown,
    },
    month: {
      used_frac: legacy.month.used_frac,
      resets_in_secs: legacy.month.resets_in_secs,
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
