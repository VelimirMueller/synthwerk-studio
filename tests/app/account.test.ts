import { describe, expect, it } from 'vitest'
import { deleteAccountErrorText, deleteAccountView } from '../../app/utils/account'

const now = Date.parse('2026-10-30T10:00:00Z')
const valid = { purpose: 'delete_account', until: '2026-10-30T10:04:00Z' }
const old = { purpose: 'delete_account', until: '2026-10-30T09:59:00Z' }

describe('delete account view', () => {
  it('deleteAccountView - back from the step-up, step-up valid - confirm step', () => {
    expect(deleteAccountView('confirm', valid, now)).toEqual({ step: 'confirm', notice: '' })
  })

  it('deleteAccountView - ?delete=confirm typed by hand, no step-up - start with a notice', () => {
    expect(deleteAccountView('confirm', undefined, now).step).toBe('start')
    expect(deleteAccountView('confirm', old, now).notice).toMatch(/older than 5 minutes/)
  })

  it('deleteAccountView - step-up for another purpose - start', () => {
    expect(deleteAccountView('confirm', { ...valid, purpose: 'other' }, now).step).toBe('start')
  })

  it('deleteAccountView - ?delete=retry - start with the retry notice', () => {
    expect(deleteAccountView('retry', valid, now)).toEqual({
      step: 'start',
      notice: 'The new sign-in did not confirm that it was you. Try again.'
    })
  })

  it('deleteAccountView - no query - start, no notice', () => {
    expect(deleteAccountView(undefined, valid, now)).toEqual({ step: 'start', notice: '' })
  })
})

describe('delete account errors', () => {
  it('deleteAccountErrorText - known codes - their text', () => {
    const err = (code: string) => ({ data: { data: { code } } })
    expect(deleteAccountErrorText(err('last_owner'))).toMatch(/only owner/)
    expect(deleteAccountErrorText(err('step_up_required'))).toMatch(/Start again/)
    expect(deleteAccountErrorText(err('recent_mfa_required'))).toMatch(/second factor/)
  })

  it('deleteAccountErrorText - unknown code, prototype key or no body - generic text', () => {
    for (const e of [{ data: { data: { code: 'constructor' } } }, { data: {} }, null, 'x']) {
      expect(deleteAccountErrorText(e)).toBe('The account was not deleted. Try again later.')
    }
  })
})
