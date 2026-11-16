import { describe, expect, it } from 'vitest'
import { guardPath, skipsCsrfGuard } from '../../server/lib/csrf-guard'

describe('guardPath', () => {
  it('drops the query and collapses leading slashes', () => {
    expect(guardPath('/api/site/leads?x=1')).toBe('/api/site/leads')
    expect(guardPath('//api/site/leads')).toBe('/api/site/leads')
    expect(guardPath('///api/apps')).toBe('/api/apps')
    expect(guardPath('')).toBe('/')
  })
})

describe('skipsCsrfGuard', () => {
  it('lets safe methods through on any path', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(skipsCsrfGuard(method, '/api/apps')).toBe(true)
    }
  })

  it('lets POST through only on the two lead routes', () => {
    expect(skipsCsrfGuard('POST', '/api/site/leads')).toBe(true)
    expect(skipsCsrfGuard('POST', '/api/site/leads/confirm?t=1')).toBe(true)
    expect(skipsCsrfGuard('POST', '/api/site/demo/chat')).toBe(false)
    expect(skipsCsrfGuard('PUT', '/api/site/leads')).toBe(false)
  })

  it('checks unsafe requests on every path, also with a leading "//"', () => {
    expect(skipsCsrfGuard('POST', '//api/apps')).toBe(false)
    expect(skipsCsrfGuard('DELETE', '//api/me')).toBe(false)
    expect(skipsCsrfGuard('POST', '/not-api/anything')).toBe(false)
  })
})
