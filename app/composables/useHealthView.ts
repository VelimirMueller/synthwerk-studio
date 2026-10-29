// Data of the health view (synthwerk#40). Everything comes from the BFF routes in
// server/api/health; the browser never calls pulse. Shapes: synthwerk-pulse
// docs/features/live-status.md and docs/features/health-metrics.md.
import type { AuthSession } from './useAuthSession'

export type TargetStatus = 'unknown' | 'ok' | 'degraded' | 'down'

export interface HealthTarget {
  target: string
  status: TargetStatus
  since: string
  checked_at: string | null
  latency_ms: number
  checks: { name: string; status: TargetStatus }[]
}

export interface StatusChange {
  target: string
  from: TargetStatus
  status: TargetStatus
  since: string
  checks: HealthTarget['checks']
}

export interface AiNumbers {
  tokens_per_minute: number
  answers: number
  failed: number
  latency_p95_ms: number | null
}

export interface PlatformMetrics {
  generated_at: string
  window_seconds: number
  services:
    | {
        service: string
        requests_per_second: number
        error_ratio: number
        p95_ms: number | null
      }[]
    | null
  host: {
    cpu_ratio: number | null
    memory_used_bytes: number
    memory_total_bytes: number
    disk_used_bytes: number
    disk_total_bytes: number
  } | null
  database: { connections: number; max_connections: number } | null
  bus: {
    pending_messages: number
    streams: { stream: string; messages: number; pending: number }[]
  } | null
  ai: AiNumbers | null
}

export interface OrgMetrics {
  generated_at: string
  window_seconds: number
  org_id: string
  ai: AiNumbers | null
}

export type MetricsAnswer =
  | { scope: 'platform'; metrics: PlatformMetrics }
  | { scope: 'org'; metrics: OrgMetrics }

/** Same rule as server/lib/health.ts healthScope: show the link, the BFF decides. */
export function canViewHealth(session: AuthSession | null | undefined): boolean {
  if (!session) return false
  return session.roles.some(
    (r) =>
      (r.role === 'operator' && r.orgIds.length > 0) ||
      ((r.role === 'owner' || r.role === 'admin') && r.orgIds.includes(session.org.id))
  )
}

/** Applies one status event to the list. An unknown target is added at the end. */
export function applyChange(targets: HealthTarget[], change: StatusChange): HealthTarget[] {
  const next = targets.map((t) =>
    t.target === change.target
      ? { ...t, status: change.status, since: change.since, checks: change.checks }
      : t
  )
  if (!next.some((t) => t.target === change.target)) {
    next.push({
      target: change.target,
      status: change.status,
      since: change.since,
      checked_at: null,
      latency_ms: 0,
      checks: change.checks
    })
  }
  return next
}

/** Reads JSON without throwing: a bad frame is ignored. */
export function parseFrame<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T
  } catch {
    return null
  }
}

// Decimal (SI) units: 1 KB = 1000 B.
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000
    unit++
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${BYTE_UNITS[unit]}`
}

export const formatPercent = (ratio: number | null | undefined): string =>
  ratio === null || ratio === undefined ? '-' : `${(ratio * 100).toFixed(ratio < 0.1 ? 1 : 0)} %`

export const formatMs = (ms: number | null | undefined): string =>
  ms === null || ms === undefined
    ? '-'
    : ms >= 1000
      ? `${(ms / 1000).toFixed(2)} s`
      : `${Math.round(ms)} ms`

export const formatNumber = (n: number | null | undefined, digits = 0): string =>
  n === null || n === undefined
    ? '-'
    : n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 })
