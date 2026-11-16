// Client helpers of the live demo and the public numbers (synthwerk#47).
import { describe, expect, it } from 'vitest'
import {
  DEMO_TEXTS,
  deltaText,
  demoErrorCode,
  demoErrorText,
  formatScore,
  formatStats,
  parseSse
} from '../../app/utils/site-demo'

describe('parseSse', () => {
  it('parseSse - full and partial frames - frames and the rest', () => {
    const { frames, rest } = parseSse(
      ': ping\n\nid: m:1\nevent: delta\ndata: {"text":"Hal"}\n\nid: m:2\r\nevent: delta\r\ndata: {"text":"lo"}\r\n\r\nevent: done\ndata: {"mess'
    )
    expect(frames).toEqual([
      { event: 'delta', data: '{"text":"Hal"}' },
      { event: 'delta', data: '{"text":"lo"}' }
    ])
    expect(rest).toBe('event: done\ndata: {"mess')
    expect(frames.map(deltaText).join('')).toBe('Hallo')
  })

  it('deltaText - other events and bad JSON - empty', () => {
    expect(deltaText({ event: 'done', data: '{"text":"x"}' })).toBe('')
    expect(deltaText({ event: 'delta', data: 'nope' })).toBe('')
    expect(deltaText({ event: 'delta', data: '{"text":1}' })).toBe('')
  })
})

describe('demo errors', () => {
  it('every server code has a text in both languages', () => {
    const codes = [
      'sign_in_required',
      'invalid_request',
      'demo_rate_limited',
      'demo_busy',
      'demo_quota_exhausted',
      'demo_not_member',
      'demo_not_configured',
      'demo_unavailable',
      'payload_too_large',
      'unsupported_media_type'
    ]
    for (const locale of ['de', 'en'] as const) {
      for (const code of codes) expect(DEMO_TEXTS[locale].errors[code], code).toBeTruthy()
    }
    expect(Object.keys(DEMO_TEXTS.de.errors).sort()).toEqual(
      Object.keys(DEMO_TEXTS.en.errors).sort()
    )
  })

  it('demoErrorText - unknown code - general text', () => {
    expect(demoErrorText('en', 'nope')).toBe(DEMO_TEXTS.en.fallbackError)
    expect(demoErrorText('de', undefined)).toBe(DEMO_TEXTS.de.fallbackError)
    expect(demoErrorText('en', 'demo_busy')).toBe(DEMO_TEXTS.en.errors.demo_busy)
  })

  it('demoErrorCode - h3 error body - the code', () => {
    expect(demoErrorCode({ statusCode: 429, data: { code: 'demo_busy' } })).toBe('demo_busy')
    expect(demoErrorCode(null)).toBeNull()
    expect(demoErrorCode({ data: {} })).toBeNull()
  })
})

describe('formatStats', () => {
  it('formatStats - values - percent, ms and count per locale', () => {
    const stats = { uptime_ratio: 0.9993, p95_ms: 412.5, answered_chats: 12345 }
    expect(formatStats('en', stats)).toEqual({ uptime: '99.93%', p95: '413 ms', chats: '12,345' })
    const de = formatStats('de', stats)
    expect(de.uptime).toMatch(/^99,93\s?%$/)
    expect(de.chats).toBe('12.345')
  })

  it('formatStats - null or missing - "-"', () => {
    expect(formatStats('en', null)).toEqual({ uptime: '-', p95: '-', chats: '-' })
    expect(formatStats('de', { uptime_ratio: null, p95_ms: null, answered_chats: null })).toEqual({
      uptime: '-',
      p95: '-',
      chats: '-'
    })
  })

  it('formatScore - whole percent', () => {
    expect(formatScore('en', 0.81)).toBe('81%')
  })

  it('stats labels match the site spec', () => {
    expect(DEMO_TEXTS.en.stats).toMatchObject({
      uptime: 'Uptime 30 days',
      p95: 'p95',
      chats: 'Answered chats 30 days'
    })
    expect(DEMO_TEXTS.en.title).toBe('Try the live demo')
  })
})
