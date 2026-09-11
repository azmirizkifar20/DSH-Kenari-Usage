import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Config, kenariUsageTool as KenariUsageTool } from './kenari-usage.js'

type Tool = typeof KenariUsageTool
type ExecCtx = Parameters<Tool['execute']>[1]

const SAMPLE_QUOTA = {
  coupon: null,
  plan: {
    name: 'Kreator',
    windows: {
      week: { used_rp: 136861, remaining_rp: 13139, resets_at: '2026-09-14T02:37:44Z' },
      month: { used_rp: 136861, remaining_rp: 463139, resets_at: '2026-10-07T02:37:44Z' },
    },
  },
}

function execCtx(): ExecCtx {
  return { signal: new AbortController().signal } as ExecCtx
}

async function loadTool(apiKey?: string): Promise<Tool> {
  const mod = await import('./kenari-usage.js')
  const ctx = { tools: { register: () => undefined } } as unknown as Context
  mod.apply(ctx, { apiKey } as unknown as Config)
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

const MCP_BALANCE_TEXT = 'Saldo: Rp 97'

function mockBearerFetch(opts?: { mcpFails?: boolean; quotaStatus?: number; balanceFails?: boolean; balanceText?: string }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: { body?: unknown }) => {
      const u = String(url)
      if (u.includes('/mcp')) {
        const body = typeof init?.body === 'string' ? init.body : ''
        const isBalance = body.includes('kenari_balance')
        if ((opts?.mcpFails === true && !isBalance) || (opts?.balanceFails === true && isBalance)) {
          return new Response('boom', { status: 500 })
        }
        const text = isBalance ? (opts?.balanceText ?? MCP_BALANCE_TEXT) : MCP_TEXT
        const rpc = {
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text }] },
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

describe('kenariUsageTool.execute without apiKey', () => {
  it('missing apiKey -> error retryable:false without fetching', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify(SAMPLE_QUOTA), { status: 200 }))
    vi.stubGlobal('fetch', spy)
    const tool = await loadTool(undefined)
    const value = (await tool.execute({}, execCtx())) as { error: string; retryable: boolean }
    expect(value.retryable).toBe(false)
    expect(value.error).toMatch(/apiKey/)
    expect(spy).not.toHaveBeenCalled()
  })

  it('empty apiKey -> error retryable:false without fetching', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify(SAMPLE_QUOTA), { status: 200 }))
    vi.stubGlobal('fetch', spy)
    const tool = await loadTool('')
    const value = (await tool.execute({}, execCtx())) as { error: string; retryable: boolean }
    expect(value.retryable).toBe(false)
    expect(value.error).toMatch(/apiKey/)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('kenariUsageTool.execute Bearer path with mocked fetch', () => {
  it('quota + MCP -> {quota, usage, balance_rp} with sorted models and totals', async () => {
    mockBearerFetch()
    const tool = await loadTool('kn-test')
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
      balance_rp: 97,
    })
    const text = renderText(tool, value)
    expect(text).toContain('Kreator')
    expect(text).toContain('Rp 136861')
  })

  it('sends Authorization Bearer header on quota+MCP', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: { headers?: Record<string, string>; body?: unknown }) => {
        seen.push({ url: String(url), headers: init?.headers ?? {} })
        if (String(url).includes('/mcp')) {
          const body = typeof init?.body === 'string' ? init.body : ''
          const text = body.includes('kenari_balance') ? MCP_BALANCE_TEXT : MCP_TEXT
          const rpc = {
            jsonrpc: '2.0',
            id: 1,
            result: { content: [{ type: 'text', text }] },
          }
          return new Response(JSON.stringify(rpc), { status: 200 })
        }
        return new Response(JSON.stringify(QUOTA_JSON), { status: 200 })
      }),
    )
    const tool = await loadTool('kn-test-key')
    await tool.execute({}, execCtx())
    expect(seen).toHaveLength(3)
    for (const call of seen) {
      expect(call.headers['Authorization']).toBe('Bearer kn-test-key')
    }
  })

  it('MCP failure -> usage null, quota still returned', async () => {
    mockBearerFetch({ mcpFails: true })
    const tool = await loadTool('kn-test')
    const value = (await tool.execute({}, execCtx())) as {
      quota: { plan: string }
      usage: null
      balance_rp: number | null
    }
    expect(value.quota.plan).toBe('Kreator')
    expect(value.usage).toBeNull()
    expect(value.balance_rp).toBe(97)
  })

  it('balance failure -> balance_rp null, payload still ok', async () => {
    mockBearerFetch({ balanceFails: true })
    const tool = await loadTool('kn-test')
    const value = (await tool.execute({}, execCtx())) as {
      quota: { plan: string }
      usage: { window: string } | null
      balance_rp: number | null
    }
    expect(value.quota.plan).toBe('Kreator')
    expect(value.usage?.window).toBe('30d')
    expect(value.balance_rp).toBeNull()
  })

  it('quota 401 -> invalid API key error retryable:false', async () => {
    mockBearerFetch({ quotaStatus: 401 })
    const tool = await loadTool('kn-bad')
    const value = (await tool.execute({}, execCtx())) as { error: string; retryable: boolean }
    expect(value.retryable).toBe(false)
    expect(value.error).toMatch(/invalid API key \(401\)/)
  })

  it('quota 403 -> shared key error retryable:false', async () => {
    mockBearerFetch({ quotaStatus: 403 })
    const tool = await loadTool('kn-shared')
    const value = (await tool.execute({}, execCtx())) as { error: string; retryable: boolean }
    expect(value.retryable).toBe(false)
    expect(value.error).toMatch(/shared key not allowed/)
  })
})
