import { describe, expect, it } from 'vitest'
import {
  analyticsScript,
  CONSENT_COOKIE,
  CONSENT_MAX_AGE_SECONDS,
  consentCookie,
  parseConsent,
  readCookie,
  serializeConsent
} from '../../app/utils/consent'

describe('consent cookie', () => {
  it('round-trips both choices', () => {
    for (const analytics of [true, false]) {
      expect(parseConsent(serializeConsent({ analytics }))).toEqual({ analytics })
    }
  })

  it.each([
    null,
    undefined,
    '',
    'yes',
    'v0.analytics-yes',
    'v1.analytics-maybe',
    'v1.analytics-yes;x'
  ])('treats %s as no choice: the banner shows and nothing loads', (value) => {
    expect(parseConsent(value)).toBeNull()
  })

  it('reads one cookie from document.cookie', () => {
    const jar = `a=1; ${CONSENT_COOKIE}=v1.analytics-yes; b=x=y`
    expect(readCookie(jar, CONSENT_COOKIE)).toBe('v1.analytics-yes')
    expect(readCookie(jar, 'b')).toBe('x=y')
    expect(readCookie('', CONSENT_COOKIE)).toBeNull()
    expect(readCookie(`x${CONSENT_COOKIE}=v1.analytics-yes`, CONSENT_COOKIE)).toBeNull()
  })

  it('writes a first-party cookie for the whole site, Secure only on https', () => {
    expect(consentCookie({ analytics: false }, true)).toBe(
      `sw_consent=v1.analytics-no; Max-Age=${CONSENT_MAX_AGE_SECONDS}; Path=/; SameSite=Lax; Secure`
    )
    expect(consentCookie({ analytics: true }, false)).not.toContain('Secure')
    expect(consentCookie({ analytics: true }, false)).not.toMatch(/domain=/i)
  })
})

describe('analyticsScript', () => {
  const config = { scriptUrl: 'https://stats.example.org/script.js', websiteId: 'abc-123' }

  it('loads nothing without an analytics consent', () => {
    expect(analyticsScript(null, config)).toBeNull()
    expect(analyticsScript({ analytics: false }, config)).toBeNull()
  })

  it('loads the configured script after the opt-in', () => {
    expect(analyticsScript({ analytics: true }, config)).toEqual({
      src: 'https://stats.example.org/script.js',
      websiteId: 'abc-123'
    })
    expect(analyticsScript({ analytics: true }, { ...config, scriptUrl: '/umami.js' })).toEqual({
      src: '/umami.js',
      websiteId: 'abc-123'
    })
  })

  it.each([
    { scriptUrl: '', websiteId: 'abc' },
    { scriptUrl: 'https://stats.example.org/s.js', websiteId: '' },
    { scriptUrl: 'https://stats.example.org/s.js', websiteId: 'a"b' },
    { scriptUrl: 'http://stats.example.org/s.js', websiteId: 'abc' },
    { scriptUrl: '//stats.example.org/s.js', websiteId: 'abc' },
    { scriptUrl: 'javascript:alert(1)', websiteId: 'abc' },
    { scriptUrl: 'https://user:pw@stats.example.org/s.js', websiteId: 'abc' },
    { scriptUrl: 'not a url', websiteId: 'abc' },
    { scriptUrl: 42, websiteId: 'abc' }
  ])('loads nothing for a missing or unsafe config: %o', (bad) => {
    expect(analyticsScript({ analytics: true }, bad)).toBeNull()
  })
})
