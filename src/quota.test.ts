import { describe, expect, it } from 'vitest'
import {
  formatCompactId,
  formatResetShort,
  formatRp,
  parseBalance,
  parseQuota,
  parseUsageMarkdown,
  usedFracWindow,
} from './quota.js'

const LIVE_QUOTA = {
  coupon: null,
  plan: {
    name: 'Kreator',
    windows: {
      month: {
        remaining_rp: 463139,
        resets_at: '2026-10-07T02:37:44Z',
        used_rp: 136861,
      },
      week: {
        remaining_rp: 13139,
        resets_at: '2026-09-14T02:37:44Z',
        used_rp: 136861,
      },
    },
  },
}

const MARKDOWN = [
  '| model | request | input tok | output tok | biaya |',
  '|---|---|---|---|---|',
  '| glm-5-3-flash | 3,527 | 292,944,237 | 2,139,620 | Rp 143239 |',
  '| small-model | 100 | 1,000 | 2,000 | Rp 10 |',
  '',
  'Total: 3627 request, Rp 143249 (30 hari).',
].join('\n')

describe('parseQuota', () => {
  it('parses the live quota shape (week+month, plan name, coupon null)', () => {
    expect(parseQuota(LIVE_QUOTA)).toEqual({
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
    })
  })

  it('returns null windows when absent from quota', () => {
    expect(parseQuota({ coupon: null, plan: { name: 'Kreator', windows: {} } })).toEqual({
      plan: 'Kreator',
      coupon: null,
      week: null,
      month: null,
    })
  })

  it('rejects non-object input', () => {
    expect(() => parseQuota(null)).toThrow(TypeError)
    expect(() => parseQuota('x')).toThrow(TypeError)
  })
})

describe('parseUsageMarkdown', () => {
  it('parses table rows, skips header/separator/Total, sorts by tokens desc', () => {
    const parsed = parseUsageMarkdown(MARKDOWN)
    expect(parsed.models).toHaveLength(2)
    expect(parsed.models[0]?.model).toBe('glm-5-3-flash')
    expect(parsed.models[0]).toEqual({
      model: 'glm-5-3-flash',
      requests: 3527,
      input_tok: 292944237,
      output_tok: 2139620,
    })
    expect(parsed.total_requests).toBe(3627)
    expect(parsed.total_tokens).toBe(292944237 + 2139620 + 1000 + 2000)
  })

  it('returns empty totals for text without rows', () => {
    expect(parseUsageMarkdown('Total: 0 request, Rp 0 (30 hari).')).toEqual({
      models: [],
      total_requests: 0,
      total_tokens: 0,
    })
  })
})

describe('parseBalance', () => {
  it('parses the live kenari_balance shape', () => {
    expect(parseBalance('Saldo: Rp 97')).toBe(97)
  })

  it('tolerates separators, decimals, and JSON envelopes', () => {
    expect(parseBalance('Saldo: Rp 1.234.567')).toBe(1234567)
    expect(parseBalance('{"balance_rp": 4600}')).toBe(4600)
    expect(parseBalance('{"saldo": "Rp 4600,50"}')).toBe(4600)
  })

  it('returns null for missing/garbage/non-string (never throws)', () => {
    expect(parseBalance('')).toBeNull()
    expect(parseBalance('no rupiah here')).toBeNull()
    expect(parseBalance('{"nope": true}')).toBeNull()
    expect(parseBalance(null)).toBeNull()
    expect(parseBalance(97)).toBeNull()
  })
})

describe('formatters', () => {
  it('formatRp renders plain integer with no separators', () => {
    expect(formatRp(143239)).toBe('Rp 143239')
    expect(formatRp(0)).toBe('Rp 0')
  })

  it('formatCompactId compacts id-style', () => {
    expect(formatCompactId(999)).toBe('999')
    expect(formatCompactId(14200)).toBe('14.2rb')
    expect(formatCompactId(41300)).toBe('41.3rb')
    expect(formatCompactId(732200000)).toBe('732.2jt')
    expect(formatCompactId(1840000000)).toBe('1.8M')
    expect(formatCompactId(2000000000)).toBe('2M')
  })

  it('formatResetShort renders UTC day + English month abbrev + HH:mm', () => {
    expect(formatResetShort('2026-09-13T20:30:00Z')).toBe('13 Sep 20:30')
    expect(formatResetShort('2026-09-14T02:37:44Z')).toBe('14 Sep 02:37')
  })

  it('usedFracWindow guards divide-by-zero', () => {
    expect(usedFracWindow({ used_rp: 136861, remaining_rp: 13139 })).toBeCloseTo(
      136861 / 150000,
      10,
    )
    expect(usedFracWindow({ used_rp: 0, remaining_rp: 0 })).toBe(0)
  })
})
