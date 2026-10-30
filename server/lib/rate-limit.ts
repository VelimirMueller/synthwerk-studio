// A fixed-window counter in memory (synthwerk#105). One studio process: the limits hold per
// process. The map has a hard size. An entry whose window is still open is never dropped: a flood
// of new keys must not reset the count of a real client. When the map is full of open windows,
// a new key is refused (fail closed) until windows end.
import { isIPv4, isIPv6 } from 'node:net'

export interface Limit {
  /** Hits allowed per window. */
  max: number
  windowMs: number
}

export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly maxKeys = 50_000,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Counts one hit for `key`. False when the key is over its limit in this window, or when the
   * key is new and the map is full of open windows.
   */
  hit(key: string, limit: Limit): boolean {
    const now = this.now()
    const entry = this.hits.get(key)
    if (entry && entry.resetAt > now) {
      entry.count++
      return entry.count <= limit.max
    }
    if (entry) this.hits.delete(key)
    if (this.hits.size >= this.maxKeys) {
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k)
      if (this.hits.size >= this.maxKeys) return false
    }
    this.hits.set(key, { count: 1, resetAt: now + limit.windowMs })
    return true
  }

  get size(): number {
    return this.hits.size
  }
}

/**
 * The rate limit key of a client address. IPv4 as it is. IPv6 by its /64 network: one host
 * usually gets a whole /64, so single addresses would let it reset its own limit. An IPv4-mapped
 * IPv6 address counts as the IPv4 address. Anything else: one shared key.
 */
export function clientKey(ip: string): string {
  const raw =
    ip
      .trim()
      .replace(/^\[|\]$/g, '')
      .split('%')[0] ?? ''
  if (isIPv4(raw)) return raw
  if (!isIPv6(raw)) return 'unknown'
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw)
  if (mapped?.[1] && isIPv4(mapped[1])) return mapped[1]
  const [head = '', tail = ''] = raw.toLowerCase().split('::')
  const left = head ? head.split(':') : []
  const right = raw.includes('::') ? (tail ? tail.split(':') : []) : []
  const groups = raw.includes('::')
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left
  return `${groups
    .slice(0, 4)
    .map((g) => Number.parseInt(g || '0', 16).toString(16))
    .join(':')}::/64`
}
