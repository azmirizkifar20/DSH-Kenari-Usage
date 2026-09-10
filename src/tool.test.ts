import { afterEach, describe, expect, it, vi } from 'vitest'
import type { kenariUsageTool as KenariUsageTool } from './kenari-usage.js'

type Tool = typeof KenariUsageTool
type ExecCtx = Parameters<Tool['execute']>[1]

const SAMPLE = {
  window_week: { resets_in_secs: 322311, used_frac: 0.842881845 },
  window_month: { resets_in_secs: 2309511, used_frac: 0.21072046125 },
}

function execCtx(): ExecCtx {
  return { signal: new AbortController().signal } as ExecCtx
}

async function loadTool(): Promise<Tool> {
  const mod = await import('./kenari-usage.js')
  return mod.kenariUsageTool as Tool
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

  it(
    'fetch timeout -> error retryable:true',
    async () => {
      // Impl uses a real 8s setTimeout per attempt (2 attempts); fake timers keep this fast.
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
