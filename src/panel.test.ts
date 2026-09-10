import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKenariPanel } from './panel.js'
import type { ParsedUsage } from './format.js'

const SAMPLE: ParsedUsage = {
  week: { used_frac: 0.842881845, resets_in_secs: 322311 },
  month: { used_frac: 0.21072046125, resets_in_secs: 2309511 },
}

type Listener = () => void

class FakeElement {
  tagName: string
  attrs: Record<string, string> = {}
  children: FakeElement[] = []
  textContent = ''
  style: Record<string, string> = {}
  disabled = false
  removed = false
  listeners: Record<string, Listener[]> = {}
  ownerDocument: FakeDocument

  constructor(tag: string, owner: FakeDocument) {
    this.tagName = tag
    this.ownerDocument = owner
  }

  setAttribute(k: string, v: string): void {
    this.attrs[k] = v
  }

  appendChild(child: FakeElement): void {
    this.children.push(child)
  }

  addEventListener(type: string, fn: Listener): void {
    this.listeners[type] ??= []
    this.listeners[type].push(fn)
  }

  click(): void {
    for (const fn of this.listeners['click'] ?? []) fn()
  }

  remove(): void {
    this.removed = true
  }
}

class FakeDocument {
  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this)
  }
}

function byTestId(root: FakeElement, id: string): FakeElement {
  const stack = [...root.children]
  while (stack.length > 0) {
    const el = stack.pop() as FakeElement
    if (el.attrs['data-testid'] === id) return el
    stack.push(...el.children)
  }
  throw new Error(`missing [data-testid="${id}"]`)
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('createKenariPanel (mocked DOM)', () => {
  it('renders 84.3%/21.1% via shared formatUsage; disabled during fetch', async () => {
    const doc = new FakeDocument()
    const root = new FakeElement('div', doc)
    let calls = 0
    const handle = createKenariPanel(
      root as unknown as HTMLElement,
      async () => {
        calls += 1
        return SAMPLE
      },
    )
    try {
      const refreshBtn = byTestId(root, 'kenari-refresh')
      expect(refreshBtn.disabled).toBe(true)
      await flush()
      expect(calls).toBe(1)
      expect(refreshBtn.disabled).toBe(false)
      expect(byTestId(root, 'kenari-week').textContent).toContain('84.3%')
      expect(byTestId(root, 'kenari-month').textContent).toContain('21.1%')
      expect(byTestId(root, 'kenari-error').style['display']).toBe('none')
    } finally {
      handle.destroy()
    }
  })

  it('debounces rapid refreshes (1000ms) and aborts the prior request', async () => {
    vi.useFakeTimers()
    let t = 1_000_000
    const doc = new FakeDocument()
    const root = new FakeElement('div', doc)
    const signals: AbortSignal[] = []
    const resolvers: Array<(v: ParsedUsage) => void> = []
    const handle = createKenariPanel(
      root as unknown as HTMLElement,
      (signal) => {
        signals.push(signal)
        return new Promise<ParsedUsage>((resolve) => {
          resolvers.push(resolve)
        })
      },
      { now: () => t },
    )
    try {
      expect(signals.length).toBe(1)
      handle.refresh()
      handle.refresh()
      expect(signals.length).toBe(1)
      t += 1000
      handle.refresh(true)
      expect(signals.length).toBe(2)
      expect(signals[0]?.aborted).toBe(true)
      resolvers[1]?.(SAMPLE)
      await flush()
      expect(byTestId(root, 'kenari-week').textContent).toContain('84.3%')
      // Late settlement of the aborted request must not clobber the panel.
      resolvers[0]?.({
        week: { used_frac: 0.5, resets_in_secs: 10 },
        month: { used_frac: 0.5, resets_in_secs: 10 },
      })
      await flush()
      expect(byTestId(root, 'kenari-week').textContent).toContain('84.3%')
    } finally {
      handle.destroy()
    }
  })

  it('offline/401 failure -> error card + dimmed last data + Retry', async () => {
    const doc = new FakeDocument()
    const root = new FakeElement('div', doc)
    let t = 3_000_000
    let attempt = 0
    const handle = createKenariPanel(
      root as unknown as HTMLElement,
      async () => {
        attempt += 1
        if (attempt === 1) return SAMPLE
        throw new Error('Kenari session expired (401) — re-login in browser, then retry.')
      },
      { now: () => t },
    )
    try {
      await flush()
      expect(byTestId(root, 'kenari-week').textContent).toContain('84.3%')
      t += 1000
      byTestId(root, 'kenari-refresh').click()
      await flush()
      const error = byTestId(root, 'kenari-error')
      expect(error.style['display']).toBe('')
      expect(byTestId(root, 'kenari-error-text').textContent).toMatch(/401/)
      expect(byTestId(root, 'kenari-week').style['opacity']).toBe('0.5')
      expect(byTestId(root, 'kenari-month').style['opacity']).toBe('0.5')
      expect(attempt).toBe(2)
    } finally {
      handle.destroy()
    }
  })

  it('display tick decrements countdown locally without refetch', async () => {
    vi.useFakeTimers()
    let t = 2_000_000
    const doc = new FakeDocument()
    const root = new FakeElement('div', doc)
    let calls = 0
    const short: ParsedUsage = {
      week: { used_frac: 0.842881845, resets_in_secs: 90 },
      month: { used_frac: 0.21072046125, resets_in_secs: 90 },
    }
    const handle = createKenariPanel(
      root as unknown as HTMLElement,
      async () => {
        calls += 1
        return short
      },
      { now: () => t },
    )
    try {
      await flush()
      const before = byTestId(root, 'kenari-week').textContent
      expect(before).toContain('84.3%')
      t += 61_000
      await vi.advanceTimersByTimeAsync(61_000)
      const after = byTestId(root, 'kenari-week').textContent
      expect(after).toContain('84.3%')
      expect(after).not.toBe(before)
      expect(calls).toBe(1)
    } finally {
      handle.destroy()
    }
  })
})
