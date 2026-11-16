// Pure helpers and shapes of the health view alerts and AI cost (synthwerk#57). Shapes:
// pulse GET /v1/alerts and the ai_cost field of GET /v1/metrics (synthwerk-pulse docs/features).

/** One day of AI cost (UTC). `cost` is in the currency of the answer. */
export interface AiCostDay {
  date: string
  cost: number
  answers: number
  input_tokens: number
  output_tokens: number
  /** Answers whose provider and model have no price. They add 0 to `cost`. */
  unpriced_answers: number
}

/** AI cost of the last 7 UTC days, oldest first (synthwerk#57). */
export interface AiCost {
  currency: string
  days: AiCostDay[]
}

export type AlertRule = 'target_down' | 'service_errors' | 'ai_failed'
export type AlertSeverity = 'critical' | 'warning'

/** One active alert of pulse (synthwerk#57). Trace fields are null for non-operators. */
export interface Alert {
  id: string
  rule: AlertRule | string
  severity: AlertSeverity | string
  subject: string
  summary: string
  value: number | null
  threshold: number | null
  since: string
  trace_id: string | null
  trace_url: string | null
}

export interface AlertsAnswer {
  generated_at: string
  alerts: Alert[]
}

/**
 * The trace link of an alert, or null. Only absolute http and https URLs pass: a
 * `javascript:` or `data:` URL from a broken pulse config never becomes a link.
 */
export function safeTraceUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

/** Critical alerts first, then the oldest first. Does not change the input. */
export function sortAlerts(alerts: Alert[]): Alert[] {
  const rank = (a: Alert) => (a.severity === 'critical' ? 0 : 1)
  return [...alerts].sort((a, b) => rank(a) - rank(b) || a.since.localeCompare(b.since))
}

/** "3 min ago" style age of an ISO time, from now (ms). A future time gives "just now", a bad one "-". */
export function formatSince(iso: string, now: number): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '-'
  const s = Math.floor((now - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86_400)} d ago`
}

/** Money with the currency code, for example "USD 0.42". Small amounts keep 4 digits. */
export function formatCost(cost: number | null | undefined, currency: string): string {
  if (cost === null || cost === undefined || !Number.isFinite(cost)) return '-'
  const digits = cost > 0 && cost < 0.01 ? 4 : 2
  return `${currency} ${cost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits })}`
}

/** Sum of the cost and the unpriced answers over the days. */
export function costTotal(cost: AiCost): { cost: number; answers: number; unpriced: number } {
  return cost.days.reduce(
    (t, d) => ({
      cost: t.cost + d.cost,
      answers: t.answers + d.answers,
      unpriced: t.unpriced + d.unpriced_answers
    }),
    { cost: 0, answers: 0, unpriced: 0 }
  )
}
