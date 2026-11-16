import { describe, expect, it } from 'vitest'
import { clientKey, RateLimiter } from '../../server/lib/rate-limit'

describe('RateLimiter', () => {
  it('allows max hits per window per key, then resets', () => {
    let now = 0
    const r = new RateLimiter(100, () => now)
    const limit = { max: 2, windowMs: 1000 }
    expect([r.hit('a', limit), r.hit('a', limit), r.hit('a', limit)]).toEqual([true, true, false])
    expect(r.hit('b', limit)).toBe(true)
    now = 1000
    expect(r.hit('a', limit)).toBe(true)
  })

  it('a flood of new keys never resets an open window: new keys are refused instead', () => {
    let now = 0
    const r = new RateLimiter(3, () => now)
    const limit = { max: 1, windowMs: 10_000 }
    expect(r.hit('victim', limit)).toBe(true)
    expect(r.hit('victim', limit)).toBe(false)
    expect(r.hit('x1', limit)).toBe(true)
    expect(r.hit('x2', limit)).toBe(true)
    // Full of open windows: a new key fails closed, the victim stays limited.
    expect(r.hit('x3', limit)).toBe(false)
    expect(r.size).toBe(3)
    expect(r.hit('victim', limit)).toBe(false)
    // Windows end: expired keys go first, then a new key fits again.
    now = 10_000
    expect(r.hit('x4', limit)).toBe(true)
    expect(r.size).toBe(1)
  })

  it('a sweep keeps the open windows', () => {
    let now = 0
    const r = new RateLimiter(2, () => now)
    r.hit('short', { max: 1, windowMs: 10 })
    r.hit('long', { max: 1, windowMs: 10_000 })
    now = 20
    expect(r.hit('new', { max: 1, windowMs: 10 })).toBe(true)
    expect(r.hit('long', { max: 1, windowMs: 10_000 })).toBe(false)
  })
})

describe('clientKey', () => {
  it.each([
    ['203.0.113.9', '203.0.113.9'],
    ['::ffff:203.0.113.9', '203.0.113.9'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::9', '2001:db8:1:2::/64'],
    ['[2001:DB8:1:2:ffff::1]', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['', 'unknown'],
    ['not an ip', 'unknown']
  ])('%s -> %s', (ip, key) => {
    expect(clientKey(ip)).toBe(key)
  })

  it('two hosts of one /64 share a key; another /64 does not', () => {
    expect(clientKey('2001:db8:1:2::a')).toBe(clientKey('2001:db8:1:2:dead:beef::1'))
    expect(clientKey('2001:db8:1:3::a')).not.toBe(clientKey('2001:db8:1:2::a'))
  })
})
