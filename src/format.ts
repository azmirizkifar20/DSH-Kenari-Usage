/**
 * Pure format + strict parse for kenari-usage.
 * No I/O, no clock, no random, no locale picker.
 * Shared by tool + panel (single formatting path).
 */

export interface TimeParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export interface WindowUsage {
  used_frac: number;
  resets_in_secs: number;
}

export interface ParsedUsage {
  week: WindowUsage;
  month: WindowUsage;
}

export interface FormattedWindow {
  percent: string;
  countdown: string;
  displayFrac: number;
  overQuota: boolean;
  resetsNow: boolean;
  parts: TimeParts;
}

export interface FormattedUsage {
  text: string;
  card: {
    week: FormattedWindow;
    month: FormattedWindow;
  };
  meta: {
    overQuota: boolean;
    resetsNow: {
      week: boolean;
      month: boolean;
    };
  };
}

/** Split whole seconds into days/hours/minutes/seconds. Throws on invalid input. */
export function secsToParts(secs: number): TimeParts {
  if (typeof secs !== 'number' || !Number.isFinite(secs)) {
    throw new TypeError(`secsToParts: expected finite number, got ${String(secs)}`);
  }
  if (secs < 0) {
    throw new RangeError(`secsToParts: expected secs >= 0, got ${secs}`);
  }
  const total = Math.floor(secs);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return { days, hours, minutes, seconds };
}

const percentFmt = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 1,
});

/**
 * Format a fraction as percent. Input is a fraction (0.84 → "84.x%"),
 * NOT pre-multiplied. Display is clamped to [0, 1].
 */
export function formatPercent(frac: number): string {
  if (typeof frac !== 'number' || !Number.isFinite(frac)) {
    throw new TypeError(`formatPercent: expected finite number, got ${String(frac)}`);
  }
  const clamped = Math.min(1, Math.max(0, frac));
  return percentFmt.format(clamped);
}

/** Format seconds as a reset countdown. `0` → "resets now". */
export function formatCountdown(secs: number): string {
  if (typeof secs !== 'number' || !Number.isFinite(secs)) {
    throw new TypeError(`formatCountdown: expected finite number, got ${String(secs)}`);
  }
  if (secs < 0) {
    throw new RangeError(`formatCountdown: expected secs >= 0, got ${secs}`);
  }
  if (secs === 0) return 'resets now';
  const { days: d, hours: h, minutes: m } = secsToParts(secs);
  const durationFormat = (Intl as unknown as {
    DurationFormat?: new (locales?: string | string[], options?: { style?: string }) => {
      format: (duration: { days: number; hours: number; minutes: number }) => string;
    };
  }).DurationFormat;
  if (typeof durationFormat !== 'undefined') {
    try {
      return new durationFormat(undefined, { style: 'narrow' }).format({
        days: d,
        hours: h,
        minutes: m,
      });
    } catch {
      // fall through to manual fallback below
    }
  }
  return `${d}d ${h}h ${m}m`;
}

function parseWindow(value: unknown, label: 'window_week' | 'window_month'): WindowUsage {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`parseSubscription: missing or invalid ${label}`);
  }
  const record = value as Record<string, unknown>;
  const { used_frac, resets_in_secs } = record;
  if (typeof used_frac !== 'number' || !Number.isFinite(used_frac)) {
    throw new TypeError(
      `parseSubscription: ${label}.used_frac must be a finite number, got ${String(used_frac)}`,
    );
  }
  if (used_frac < 0) {
    throw new RangeError(`parseSubscription: ${label}.used_frac must be >= 0, got ${used_frac}`);
  }
  if (typeof resets_in_secs !== 'number' || !Number.isFinite(resets_in_secs)) {
    throw new TypeError(
      `parseSubscription: ${label}.resets_in_secs must be a finite number, got ${String(resets_in_secs)}`,
    );
  }
  if (resets_in_secs < 0) {
    throw new RangeError(
      `parseSubscription: ${label}.resets_in_secs must be >= 0, got ${resets_in_secs}`,
    );
  }
  return { used_frac, resets_in_secs: Math.floor(resets_in_secs) };
}

/**
 * Strictly parse `/subscription` JSON. Only `window_week`/`window_month`
 * x `{used_frac, resets_in_secs}` are read; extra fields are ignored.
 * Rejects NaN, strings, negatives, and missing windows.
 */
export function parseSubscription(json: unknown): ParsedUsage {
  if (typeof json !== 'object' || json === null) {
    throw new TypeError('parseSubscription: expected a JSON object');
  }
  const record = json as Record<string, unknown>;
  return {
    week: parseWindow(record['window_week'], 'window_week'),
    month: parseWindow(record['window_month'], 'window_month'),
  };
}

function formatWindow(usage: WindowUsage): FormattedWindow {
  const overQuota = usage.used_frac > 1;
  const resetsNow = usage.resets_in_secs === 0;
  const displayFrac = Math.min(1, Math.max(0, usage.used_frac));
  return {
    percent: formatPercent(displayFrac),
    countdown: formatCountdown(usage.resets_in_secs),
    displayFrac,
    overQuota,
    resetsNow,
    parts: secsToParts(usage.resets_in_secs),
  };
}

/** Single shared formatter for tool render/card + panel. Pure. */
export function formatUsage(parsed: ParsedUsage): FormattedUsage {
  const week = formatWindow(parsed.week);
  const month = formatWindow(parsed.month);
  const text =
    `Week: ${week.percent} — ${week.resetsNow ? 'resets now' : `resets in ${week.countdown}`}` +
    `; Month: ${month.percent} — ${month.resetsNow ? 'resets now' : `resets in ${month.countdown}`}`;
  return {
    text,
    card: { week, month },
    meta: {
      overQuota: week.overQuota || month.overQuota,
      resetsNow: { week: week.resetsNow, month: month.resetsNow },
    },
  };
}
