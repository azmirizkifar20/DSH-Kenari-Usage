import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Config, kenariUsageTool as KenariUsageTool } from './kenari-usage.js'

type Tool = typeof KenariUsageTool
type ExecCtx = Parameters<Tool['execute']>[1]

const SAMPLE = {
  window_week: { resets_in_secs: 322311, used_frac: 0.842881845 },
  window_month: { resets_in_secs: 2309511, used_frac: 0.21072046125 },
}

function execCtx(): ExecCtx {
  return { signal: new AbortController().signal } as ExecCtx
}

const OMIT_COOKIE = Symbol('omit-cookie')

async function loadTool(
  cookie: string | typeof OMIT_COOKIE = 'test-cookie-value',
): Promise<Tool> {
  const mod = await import('./kenari-usage.js')
  const ctx = { tools: { register: () => undefined } } as unknown as Context
  const cfg: Record<string, unknown> = { endpoint: 'https://kenari.id/api/subscription' }
  if (cookie !== OMIT_COOKIE) cfg['sessionCookie'] = cookie
  mod.apply(ctx, cfg as unknown as Config)
  return mod.kenariUsageTool as Tool
}

async function loadToolWithKey(apiKey: string): Promise<Tool> {
  const mod = await import('./kenari-usage.js')
  const ctx = { tools: { register: () => undefined } } as unknown as Context
  mod.apply(ctx, { endpoint: 'https://kenari.id/api/subscription', apiKey } as unknown as Config)
  return mod.kenariUsageTool as Tool
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
  '| glm-5-3-flash | 3,527 | 292,944,237 | 2,139,620 | Rp 143239 |',
  '| tiny | 10 | 100 | 200 | Rp 1 |',
  '',
  'Total: 3537 request, Rp 143240 (30 hari).',
].join('\n')

function mockBearerFetch(opts?: { mcpFails?: boolean; quotaStatus?: number }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      const u = String(url)
      if (u.includes('/mcp')) {
        if (opts?.mcpFails === true) {
          return new Response('boom', { status: 500 })
        }
        const rpc = {
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: MCP_TEXT }] },
        }
        return new Response(JSON.stringify(rpc), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (opts?.quotaStatus !== undefined && opts.quotaStatus !== 200) {
        return new Response('err', { status: opts.quotaStatus })
      }
      return new Response(JSON.stringify(QUOTA_JSON), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
}

function renderText(tool: Tool, value: unknown): string {
  const renderValue = value as Parameters<Tool['output']['render']>[1]
  const blocks = tool.output.render({}, renderValue) as Array<{ type: string; text?: string }>
  return blocks.map((b) => b.text ?? '').join('\n')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('kenariUsageTool.execute with mocked fetch', () => {
  it('sample fixture -> canonical week/month equal, render contains 84.3%/21.1%', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify(SAMPLE), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    const tool = await loadTool()
    const value = await tool.execute({}, execCtx())
    expect(value).toEqual({
      week: { used_frac: 0.842881845, resets_in_secs: 322311 },
      month: { used_frac: 0.21072046125, resets_in_secs: 2309511 },
    })
    const text = renderText(tool, value)
    expect(text).toContain('84.3%')
    expect(text).toContain('21.1%')
  })

  it('401 -> error retryable:false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })))
    const tool = await loadTool()
    const value = (await tool.execute({}, execCtx())) as { error: string; retryable: boolean }
    expect(value.retryable).toBe(false)
    expect(value.error).toMatch(/401/)
    expect(renderText(tool, value)).toMatch(/401/)
  })

  it('malformed JSON -> error retryable:false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json{{{', { status: 200 })))
    const tool = await loadTool()
    const value = (await tool.execute({}, execCtx())) as { error: string; retryable: boolean }
    expect(value.retryable).toBe(false)
    expect(value.error).toMatch(/malformed/i)
  })

  it('sends Cookie header with the configured kn_session value', async () => {
    const seen: Array<Record<string, string>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
        seen.push(init?.headers ?? {})
        return new Response(JSON.stringify(SAMPLE), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    const tool = await loadTool('dummy-session-value')
    await tool.execute({}, execCtx())
    expect(seen).toHaveLength(1)
    expect(seen[0]['Cookie']).toBe('kn_session=dummy-session-value')
  })

  it('missing sessionCookie -> error retryable:false without fetching', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify(SAMPLE), { status: 200 }))
    vi.stubGlobal('fetch', spy)
    const tool = await loadTool(OMIT_COOKIE)
    const value = (await tool.execute({}, execCtx())) as { error: string; retryable: boolean }
    expect(value.retryable).toBe(false)
    expect(value.error).toMatch(/sessionCookie/)
    expect(spy).not.toHaveBeenCalled()
  })

  it(
    'fetch timeout -> error retryable:true',
    async () => {
      vi.useFakeTimers()
      try {
        vi.stubGlobal(
          'fetch',
          vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => {
            const signal = init?.signal
            return new Promise<never>((_resolve, reject) => {
              if (signal?.aborted) {
                reject(
                  signal.reason instanceof Error ? signal.reason : new Error('aborted'),
                )
                return
              }
              signal?.addEventListener(
                'abort',
                () => {
                  reject(
                    signal.reason instanceof Error ? signal.reason : new Error('aborted'),
                  )
                },
                { once: true },
              )
            })
          }),
        )
        const tool = await loadTool()
        const pending = tool.execute({}, execCtx())
        await vi.advanceTimersByTimeAsync(8000)
        await vi.advanceTimersByTimeAsync(8000)
        const value = (await pending) as { error: string; retryable: boolean }
        expect(value.retryable).toBe(true)
        expect(value.error).toMatch(/fetch failed/i)
      } finally {
        vi.useRealTimers()
      }
    },
    30000,
  )
})

describe('kenariUsageTool.execute Bearer path with mocked fetch', () => {
  it('quota + MCP -> {quota, usage} with sorted models and totals', async () => {
    mockBearerFetch()
    const tool = await loadToolWithKey('kn-test')
    const value = await tool.execute({}, execCtx())
    expect(value).toEqual({
      quota: {
        plan: 'Kreator',
        coupon: null,
        week: {
          used_rp: 136861,
          remaining_rp: 13139,
          resets_at: '2026-09-14T02:37:44Z',
        },
        month: {
          used_rp: 136861,
          remaining_rp: 463139,
          resets_at: '2026-10-07T02:37:44Z',
        },
      },
      usage: {
        window: '30d',
        models: [
          {
            model: 'glm-5-3-flash',
            requests: 3527,
            input_tok: 292944237,
            output_tok: 2139620,
          },
          { model: 'tiny', requests: 10, input_tok: 100, output_tok: 200 },
        ],
        total_requests: 3537,
        total_tokens: 292944237 + 2139620 + 100 + 200,
      },
    })
    const text = renderText(tool, value)
    expect(text).toContain('Kreator')
    expect(text).toContain('Rp 136861')
  })

  it('sends Authorization Bearer header, never Cookie, on quota+MCP', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: { headers?: Record<string, string> }) => {
        seen.push({ url: String(url), headers: init?.headers ?? {} })
        if (String(url).includes('/mcp')) {
          const rpc = {
            jsonrpc: '2.0',
            id: 1,
            result: { content: [{ type: 'text', text: MCP_TEXT }] },
          }
          return new Response(JSON.stringify(rpc), { status: 200 })
        }
        return new Response(JSON.stringify(QUOTA_JSON), { status: 200 })
      }),
    )
    const tool = await loadToolWithKey('kn-test-key')
    await tool.execute({}, execCtx())
    expect(seen).toHaveLength(2)
    for (const call of seen) {
      expect(call.headers['Authorization']).toBe('Bearer kn-test-key')
      expect(call.headers['Cookie']).toBeUndefined()
    }
  })

  it('MCP failure -> usage null, quota still returned', async () => {
    mockBearerFetch({ mcpFails: true })
    const tool = await loadToolWithKey('kn-test')
    const value = (await tool.execute({}, execCtx())) as {
      quota: { plan: string }
      usage: null
    }
    expect(value.quota.plan).toBe('Kreator')
    expect(value.usage).toBeNull()
  })

  it('quota 401 -> invalid API key error retryable:false', async () => {
    mockBearerFetch({ quotaStatus: 401 })
    const tool = await loadToolWithKey('kn-bad')
    const value = (await tool.execute({}, execCtx())) as { error: string; retryable: boolean }
    expect(value.retryable).toBe(false)
    expect(value.error).toMatch(/invalid API key \(401\)/)
  })

  it('quota 403 -> shared key error retryable:false', async () => {
    mockBearerFetch({ quotaStatus: 403 })
    const tool = await loadToolWithKey('kn-shared')
    const value = (await tool.execute({}, execCtx())) as { error: string; retryable: boolean }
    expect(value.retryable).toBe(false)
    expect(value.error).toMatch(/shared key not allowed/)
  })
})
