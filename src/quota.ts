/**
 * Pure quota + per-model usage parsers/formatters for the kn- Bearer API.
 * No I/O, no clock, no random, no locale picker.
 */

export interface QuotaWindow {
  used_rp: number;
  remaining_rp: number;
  resets_at: string;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ParsedQuota {
  plan: string | null;
  coupon: JsonValue;
  week: QuotaWindow | null;
  month: QuotaWindow | null;
}

export interface ModelUsage {
  model: string;
  requests: number;
  input_tok: number;
  output_tok: number;
}

export interface ParsedModelUsage {
  models: ModelUsage[];
  total_requests: number;
  total_tokens: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseRpNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`parseQuota: ${label} must be a finite number, got ${String(value)}`);
  }
  if (value < 0) {
    throw new RangeError(`parseQuota: ${label} must be >= 0, got ${value}`);
  }
  return Math.floor(value);
}

function parseQuotaWindow(value: unknown, label: 'week' | 'month'): QuotaWindow {
  if (!isRecord(value)) {
    throw new TypeError(`parseQuota: missing or invalid ${label} window`);
  }
  const used_rp = parseRpNumber(value['used_rp'], `${label}.used_rp`);
  const remaining_rp = parseRpNumber(value['remaining_rp'], `${label}.remaining_rp`);
  const resets_at = value['resets_at'];
  if (typeof resets_at !== 'string' || resets_at === '') {
    throw new TypeError(
      `parseQuota: ${label}.resets_at must be a non-empty string, got ${String(resets_at)}`,
    );
  }
  if (Number.isNaN(Date.parse(resets_at))) {
    throw new TypeError(`parseQuota: ${label}.resets_at is not a valid date, got ${resets_at}`);
  }
  return { used_rp, remaining_rp, resets_at };
}

function optQuotaWindow(value: unknown, label: 'week' | 'month'): QuotaWindow | null {
  if (value === undefined || value === null) return null;
  return parseQuotaWindow(value, label);
}

/**
 * Parse `GET /v1/account/quota` JSON.
 * Live shape: `{coupon, plan:{name, windows:{week, month}}}`.
 * Also tolerates `{plan:"Name", windows:{...}}` and flat `{week, month}`.
 * Missing week/month windows yield null.
 */
export function parseQuota(json: unknown): ParsedQuota {
  if (!isRecord(json)) {
    throw new TypeError('parseQuota: expected a JSON object');
  }
  const coupon: JsonValue = ('coupon' in json ? json['coupon'] : null) as JsonValue;

  let plan: string | null = null;
  let windowsSource: Record<string, unknown> | undefined;
  const planRaw = json['plan'];
  if (typeof planRaw === 'string') {
    plan = planRaw;
  } else if (isRecord(planRaw)) {
    const nameRaw = planRaw['name'];
    if (typeof nameRaw === 'string' && nameRaw !== '') {
      plan = nameRaw;
    }
    const windowsRaw = planRaw['windows'];
    if (isRecord(windowsRaw)) {
      windowsSource = windowsRaw;
    }
  }
  if (windowsSource === undefined) {
    const topWindows = json['windows'];
    if (isRecord(topWindows)) {
      windowsSource = topWindows;
    } else {
      windowsSource = json;
    }
  }

  return {
    plan,
    coupon: coupon ?? null,
    week: optQuotaWindow(windowsSource['week'], 'week'),
    month: optQuotaWindow(windowsSource['month'], 'month'),
  };
}

function parseIntLoose(value: string, label: string): number {
  const digits = value.replace(/[^0-9]/g, '');
  if (digits === '') {
    throw new TypeError(`parseUsageMarkdown: ${label} has no digits in ${JSON.stringify(value)}`);
  }
  return Number.parseInt(digits, 10);
}

/**
 * Parse the `kenari_usage` MCP markdown table into per-model rows.
 * Expected columns: `| model | request | input tok | output tok | biaya |`.
 * Header, separator (`---`), and `Total:` lines are skipped.
 * Models are sorted by (input+output) tokens desc.
 */
export function parseUsageMarkdown(text: string): ParsedModelUsage {
  if (typeof text !== 'string') {
    throw new TypeError(`parseUsageMarkdown: expected string, got ${String(text)}`);
  }
  const models: ModelUsage[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 5) continue;
    const [model, requestsRaw, inputRaw, outputRaw] = cells as [string, string, string, string, string];
    if (/^:?-{3,}:?$/.test(model) || /^model$/i.test(model)) continue;
    if (/^:?-{3,}:?$/.test(requestsRaw)) continue;
    if (model === '' || /^total$/i.test(model)) continue;
    const requests = parseIntLoose(requestsRaw, 'requests');
    const input_tok = parseIntLoose(inputRaw, 'input_tok');
    const output_tok = parseIntLoose(outputRaw, 'output_tok');
    models.push({ model, requests, input_tok, output_tok });
  }
  models.sort((a, b) => b.input_tok + b.output_tok - (a.input_tok + a.output_tok));
  let total_requests = 0;
  let total_tokens = 0;
  for (const m of models) {
    total_requests += m.requests;
    total_tokens += m.input_tok + m.output_tok;
  }
  return { models, total_requests, total_tokens };
}

/** Format an Rp amount as a plain integer with no separators: `Rp 143239`. */
export function formatRp(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new TypeError(`formatRp: expected finite number, got ${String(n)}`);
  }
  return `Rp ${Math.trunc(n)}`;
}

function trimOneDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(1);
}

/**
 * Compact Indonesian number: >=1e9 `"<x>M"`, >=1e6 `"<x>jt"`,
 * >=1e3 `"<x>rb"`, else plain. One decimal, trailing `.0` trimmed.
 */
export function formatCompactId(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new TypeError(`formatCompactId: expected finite number, got ${String(n)}`);
  }
  if (n >= 1e9) return `${trimOneDecimal(n / 1e9)}M`;
  if (n >= 1e6) return `${trimOneDecimal(n / 1e6)}jt`;
  if (n >= 1e3) return `${trimOneDecimal(n / 1e3)}rb`;
  return String(Math.trunc(n));
}

const MONTH_ABBR = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** Format an ISO timestamp as `"13 Sep 20:30"` in UTC. */
export function formatResetShort(iso: string): string {
  if (typeof iso !== 'string') {
    throw new TypeError(`formatResetShort: expected string, got ${String(iso)}`);
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new TypeError(`formatResetShort: invalid date ${JSON.stringify(iso)}`);
  }
  const day = d.getUTCDate();
  const mon = MONTH_ABBR[d.getUTCMonth()] ?? '???';
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day} ${mon} ${hh}:${mm}`;
}

/** Fraction of quota used: used/(used+remaining), 0 when the total is 0. */
export function usedFracWindow(w: { used_rp: number; remaining_rp: number }): number {
  const total = w.used_rp + w.remaining_rp;
  if (!Number.isFinite(total) || total <= 0) return 0;
  return w.used_rp / total;
}
