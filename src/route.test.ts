import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './kenari-usage.js'

interface FakeReq {
  method?: string
  url?: string
}

interface FakeRes {
  status: number
  headers: Record<string, string>
  body: string
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string): void
}

interface CapturedRoute {
  path: string
  handler: (req: FakeReq, res: FakeRes) => void | Promise<void>
}

function makeRes(): FakeRes {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status: number, headers?: Record<string, string>): void {
      this.status = status
      this.headers = headers ?? {}
    },
    end(body?: string): void {
      this.body = body ?? ''
    },
  }
}

async function captureRoute(cfg: Record<string, unknown>): Promise<CapturedRoute> {
  const mod = await import('./kenari-usage.js')
  let captured: CapturedRoute | undefined
  const ctx = {
    tools: { register: () => undefined },
    get: (name: string): unknown => {
      if (name !== 'webServer') return undefined
      return {
        register: (route: CapturedRoute): (() => void) => {
          captured = route
          return () => undefined
        },
      }
    },
    on: () => undefined,
    effect: () => undefined,
  } as unknown as Context
  mod.apply(ctx, cfg as unknown as Config)
  if (captured === undefined) throw new Error('route was not registered')
  return captured
}

const QUOTA_JSON = {
  coupon: null,
  plan: {
    name: 'Kreator',
    windows: {
      week: { used_rp: 136861, remaining_rp: 13139, resets_at: '2026-09-14T02:37:44Z' },
      month: { used_rp: 136861, remaining_rp: 463139, resets_at: '2026-10-07T02:37:44Z' },
    },
  },
}

const MCP_TEXT = [
  '| model | request | input tok | output tok | biaya |',
  '|---|---|---|---|---|',
  '| glm-5-3-flash | 3527 | 292944237 | 2139620 | Rp 143239 |',
  '| tiny | 10 | 100 | 200 | Rp 1 |',
].join('\n')

function mockQuotaMcp(opts?: { mcpFails?: boolean; quotaJson?: unknown }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      if (String(url).includes('/mcp')) {
        if (opts?.mcpFails === true) return new Response('boom', { status: 500 })
        const rpc = {
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: MCP_TEXT }] },
        }
        return new Response(JSON.stringify(rpc), { status: 200 })
      }
      return new Response(JSON.stringify(opts?.quotaJson ?? QUOTA_JSON), { status: 200 })
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GET /dsh-kenari-usage Bearer route (frozen contract)', () => {
  it('returns plan/coupon/week/month/usage/serverTime/pollIntervalMs', async () => {
    mockQuotaMcp()
    const route = await captureRoute({ apiKey: 'kn-test' })
    expect(route.path).toBe('/dsh-kenari-usage')
    const res = makeRes()
    await route.handler({ method: 'GET', url: '/dsh-kenari-usage?refresh=1' }, res)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const payload = JSON.parse(res.body) as Record<string, unknown>
    expect(payload['ok']).toBe(true)
    expect(payload['plan']).toBe('Kreator')
    expect(payload['coupon']).toBeNull()
    expect(payload['week']).toEqual({
      used_rp: 136861,
      remaining_rp: 13139,
      resets_at: '2026-09-14T02:37:44Z',
    })
    expect(payload['month']).toEqual({
      used_rp: 136861,
      remaining_rp: 463139,
      resets_at: '2026-10-07T02:37:44Z',
    })
    const usage = payload['usage'] as Record<string, unknown>
    expect(usage['window']).toBe('30d')
    const models = usage['models'] as Array<Record<string, unknown>>
    expect(models[0]?.['model']).toBe('glm-5-3-flash')
    expect(usage['total_requests']).toBe(3537)
    expect(usage['total_tokens']).toBe(292944237 + 2139620 + 100 + 200)
    expect(typeof payload['serverTime']).toBe('number')
    expect(payload['pollIntervalMs']).toBe(60000)
  })

  it('MCP failure -> 200 with usage null (quota card still renders)', async () => {
    mockQuotaMcp({ mcpFails: true })
    const route = await captureRoute({ apiKey: 'kn-test' })
    const res = makeRes()
    await route.handler({ method: 'GET' }, res)
    expect(res.status).toBe(200)
    const payload = JSON.parse(res.body) as Record<string, unknown>
    expect(payload['ok']).toBe(true)
    expect(payload['usage']).toBeNull()
    expect(payload['plan']).toBe('Kreator')
  })

  it('absent windows -> week/month null', async () => {
    mockQuotaMcp({ quotaJson: { coupon: null, plan: { name: 'Kreator', windows: {} } } })
    const route = await captureRoute({ apiKey: 'kn-test' })
    const res = makeRes()
    await route.handler({ method: 'GET' }, res)
    const payload = JSON.parse(res.body) as Record<string, unknown>
    expect(payload['week']).toBeNull()
    expect(payload['month']).toBeNull()
  })

  it('non-GET -> 405', async () => {
    mockQuotaMcp()
    const route = await captureRoute({ apiKey: 'kn-test' })
    const res = makeRes()
    await route.handler({ method: 'POST' }, res)
    expect(res.status).toBe(405)
  })

  it('cookie fallback path keeps the legacy percent/countdown shape', async () => {
    const sample = {
      window_week: { resets_in_secs: 322311, used_frac: 0.842881845 },
      window_month: { resets_in_secs: 2309511, used_frac: 0.21072046125 },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(sample), { status: 200 })),
    )
    const route = await captureRoute({
      endpoint: 'https://kenari.id/api/subscription',
      sessionCookie: 'dummy',
    })
    const res = makeRes()
    await route.handler({ method: 'GET' }, res)
    expect(res.status).toBe(200)
    const payload = JSON.parse(res.body) as Record<string, unknown>
    const week = payload['week'] as Record<string, unknown>
    expect(week['percent']).toBe('84.3%')
    expect(typeof week['countdown']).toBe('string')
  })
})
