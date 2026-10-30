import { describe, expect, it } from 'vitest'
import { builderErrorText, builderEventText, cloneContent } from '../../app/utils/builder'

describe('builderErrorText', () => {
  it('names the field of a bad content', () => {
    expect(builderErrorText({ status: 400, code: 'invalid_content' }, 'sections[1].title')).toBe(
      'The page is not valid at sections[1].title. Check that field.'
    )
    expect(builderErrorText({ status: 400, code: 'invalid_content' })).toBe(
      'The page is not valid. Check the sections.'
    )
  })

  it.each([
    'forbidden',
    'invalid_request',
    'slug_taken',
    'page_limit_reached',
    'draft_conflict',
    'no_changes',
    'already_live',
    'page_not_found',
    'version_not_found',
    'payload_too_large',
    'builder_not_configured',
    'builder_unavailable',
    'upstream_unavailable',
    'identity_not_configured',
    'csrf_failed',
    'unauthenticated'
  ])('has a text for %s', (code) => {
    expect(builderErrorText({ status: 400, code })).not.toBe('Something went wrong. Try again.')
  })

  it('falls back on the status', () => {
    expect(builderErrorText({ status: 403, code: '' })).toContain('owners and admins')
    expect(builderErrorText({ status: 503, code: '' })).toContain('builder database')
    expect(builderErrorText({ status: 0, code: '' })).toBe('Something went wrong. Try again.')
  })
})

describe('builderEventText', () => {
  it('reads the builder event types', () => {
    expect(builderEventText('dev.synthwerk.studio.page.created.v1', {})).toBe('Created the page')
    expect(builderEventText('dev.synthwerk.studio.page.published.v1', { version: 3 })).toBe(
      'Published v3'
    )
    expect(builderEventText('dev.synthwerk.studio.page.rolled_back.v1', { version: 1 })).toBe(
      'Rolled back to v1'
    )
    expect(builderEventText('dev.synthwerk.studio.page.published.v1', {})).toBe('Published')
    expect(builderEventText('x.y', {})).toBe('x.y')
  })
})

it('cloneContent gives an independent copy', () => {
  const a = { title: 't', sections: [{ id: 'a' }] }
  const b = cloneContent(a)
  ;(b.sections[0] as { id: string }).id = 'b'
  b.sections.push({ id: 'c' })
  expect(a).toEqual({ title: 't', sections: [{ id: 'a' }] })
})
