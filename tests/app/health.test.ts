// Helpers of the health view (synthwerk#57): trace links, alert order, age and cost.
import { describe, expect, it } from 'vitest'
import {
  type Alert,
  costTotal,
  formatCost,
  formatSince,
  safeTraceUrl,
  sortAlerts
} from '../../app/utils/health'

const alert = (id: string, severity: string, since: string): Alert => ({
  id,
  rule: 'service_errors',
  severity,
  subject: id,
  summary: id,
  value: null,
  threshold: null,
  since,
  trace_id: null,
  trace_url: null
})

describe('safeTraceUrl', () => {
  it('safeTraceUrl - http and https - the URL', () => {
    expect(safeTraceUrl('http://localhost:3000/explore?x=1')).toBe(
      'http://localhost:3000/explore?x=1'
    )
    expect(safeTraceUrl('https://grafana.example/t/abc')).toBe('https://grafana.example/t/abc')
  })

  it('safeTraceUrl - javascript, data, relative, empty - null', () => {
    expect(safeTraceUrl('javascript:alert(1)')).toBeNull()
    expect(safeTraceUrl('data:text/html,hi')).toBeNull()
    expect(safeTraceUrl('/explore')).toBeNull()
    expect(safeTraceUrl('')).toBeNull()
    expect(safeTraceUrl(null)).toBeNull()
  })
})

describe('sortAlerts', () => {
  it('sortAlerts - mixed - critical first, then the oldest first, input unchanged', () => {
    const input = [
      alert('b', 'warning', '2026-11-16T10:00:00Z'),
      alert('c', 'critical', '2026-11-16T10:05:00Z'),
      alert('a', 'warning', '2026-11-16T09:00:00Z')
    ]
    expect(sortAlerts(input).map((a) => a.id)).toEqual(['c', 'a', 'b'])
    expect(input[0]?.id).toBe('b')
  })
})

describe('formatSince', () => {
  const now = Date.UTC(2026, 10, 16, 12, 0, 0)
  it('formatSince - ages - just now, minutes, hours, days', () => {
    expect(formatSince('2026-11-16T11:59:30Z', now)).toBe('just now')
    expect(formatSince('2026-11-16T11:55:00Z', now)).toBe('5 min ago')
    expect(formatSince('2026-11-16T09:00:00Z', now)).toBe('3 h ago')
    expect(formatSince('2026-11-14T12:00:00Z', now)).toBe('2 d ago')
    expect(formatSince('2026-11-16T13:00:00Z', now)).toBe('just now')
    expect(formatSince('not a time', now)).toBe('-')
  })
})

describe('cost', () => {
  it('formatCost - amounts - currency code, small amounts keep 4 digits', () => {
    expect(formatCost(0, 'USD')).toBe('USD 0.00')
    expect(formatCost(0.4215, 'USD')).toBe('USD 0.42')
    expect(formatCost(0.0042, 'EUR')).toBe('EUR 0.0042')
    expect(formatCost(1234.5, 'USD')).toBe('USD 1,234.50')
    expect(formatCost(null, 'USD')).toBe('-')
  })

  it('costTotal - days - sums cost, answers and unpriced answers', () => {
    const day = (date: string, cost: number, answers: number, unpriced: number) => ({
      date,
      cost,
      answers,
      input_tokens: 0,
      output_tokens: 0,
      unpriced_answers: unpriced
    })
    expect(
      costTotal({
        currency: 'USD',
        days: [day('2026-11-15', 0.5, 10, 1), day('2026-11-16', 0.25, 4, 2)]
      })
    ).toEqual({ cost: 0.75, answers: 14, unpriced: 3 })
  })
})
