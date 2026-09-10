import { describe, expect, it } from 'vitest'
import {
  formatCountdown,
  formatPercent,
  formatUsage,
  parseSubscription,
  secsToParts,
} from './format.js'

describe('formatPercent', () => {
  it('formats fractions as one-decimal percent', () => {
    expect(formatPercent(0.842881845)).toBe('84.3%')
    expect(formatPercent(0.21072046125)).toBe('21.1%')
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(1)).toBe('100%')
  })

  it('clamps display to [0, 1]', () => {
    expect(formatPercent(1.2)).toBe('100%')
    expect(formatPercent(-0.5)).toBe('0%')
  })

  it('rejects non-finite input', () => {
    expect(() => formatPercent(Number.NaN)).toThrow(TypeError)
    expect(() => formatPercent(Number.POSITIVE_INFINITY)).toThrow(TypeError)
    expect(() => formatPercent('0.5' as unknown as number)).toThrow(TypeError)
  })
})

describe('secsToParts', () => {
  it('splits whole seconds into d/h/m/s', () => {
    expect(secsToParts(322311)).toEqual({ days: 3, hours: 17, minutes: 31, seconds: 51 })
    expect(secsToParts(0)).toEqual({ days: 0, hours: 0, minutes: 0, seconds: 0 })
    expect(secsToParts(90)).toEqual({ days: 0, hours: 0, minutes: 1, seconds: 30 })
  })

  it('floors fractional seconds', () => {
    expect(secsToParts(61.9)).toEqual({ days: 0, hours: 0, minutes: 1, seconds: 1 })
  })

  it('rejects invalid input', () => {
    expect(() => secsToParts(-1)).toThrow(RangeError)
    expect(() => secsToParts(Number.NaN)).toThrow(TypeError)
    expect(() => secsToParts('60' as unknown as number)).toThrow(TypeError)
  })
})

describe('formatCountdown', () => {
  it('renders 0 as resets now', () => {
    expect(formatCountdown(0)).toBe('resets now')
  })

  it('renders positive seconds as a non-empty countdown', () => {
    const out = formatCountdown(322311)
    expect(typeof out).toBe('string')
    expect(out.length).toBeGreaterThan(0)
    expect(out).not.toBe('resets now')
  })

  it('rejects invalid input', () => {
    expect(() => formatCountdown(-5)).toThrow(RangeError)
    expect(() => formatCountdown(Number.NaN)).toThrow(TypeError)
  })
})

describe('parseSubscription + formatUsage edges', () => {
  const sample = {
    window_week: { resets_in_secs: 322311, used_frac: 0.842881845 },
    window_month: { resets_in_secs: 2309511, used_frac: 0.21072046125 },
  }

  it('parses the sample fixture and formats 84.3% / 21.1%', () => {
    const parsed = parseSubscription(sample)
    expect(parsed).toEqual({
      week: { used_frac: 0.842881845, resets_in_secs: 322311 },
      month: { used_frac: 0.21072046125, resets_in_secs: 2309511 },
    })
    const formatted = formatUsage(parsed)
    expect(formatted.card.week.percent).toBe('84.3%')
    expect(formatted.card.month.percent).toBe('21.1%')
    expect(formatted.text).toContain('84.3%')
    expect(formatted.text).toContain('21.1%')
  })

  it('flags over-quota (used_frac 1.2) with clamped display', () => {
    const parsed = parseSubscription({
      window_week: { resets_in_secs: 100, used_frac: 1.2 },
      window_month: { resets_in_secs: 100, used_frac: 0.5 },
    })
    const formatted = formatUsage(parsed)
    expect(formatted.card.week.overQuota).toBe(true)
    expect(formatted.card.week.displayFrac).toBe(1)
    expect(formatted.card.week.percent).toBe('100%')
    expect(formatted.meta.overQuota).toBe(true)
  })

  it('flags resets-in-0 as resets now', () => {
    const parsed = parseSubscription({
      window_week: { resets_in_secs: 0, used_frac: 0.1 },
      window_month: { resets_in_secs: 0, used_frac: 0.2 },
    })
    const formatted = formatUsage(parsed)
    expect(formatted.meta.resetsNow).toEqual({ week: true, month: true })
    expect(formatted.text).toContain('resets now')
  })

  it('rejects string used_frac', () => {
    expect(() =>
      parseSubscription({
        window_week: { resets_in_secs: 10, used_frac: '0.5' },
        window_month: { resets_in_secs: 10, used_frac: 0.5 },
      }),
    ).toThrow(TypeError)
  })

  it('rejects a missing window', () => {
    expect(() => parseSubscription({ window_week: { resets_in_secs: 10, used_frac: 0.5 } })).toThrow(
      TypeError,
    )
  })
})
