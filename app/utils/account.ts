// Delete account (synthwerk#41): page logic without Vue, so tests can run it.

/** The step-up sign-in. It comes back to /me?delete=confirm (or ?delete=retry). */
export const deleteAccountReauthUrl = '/api/auth/reauth?purpose=delete_account'

/** The word the user types to confirm. */
export const DELETE_CONFIRM_WORD = 'DELETE'

const messages: Record<string, string> = {
  step_up_required: 'The new sign-in is too old or was used. Start again.',
  recent_mfa_required: 'Identity did not accept the sign-in. Sign in again with a second factor.',
  last_owner:
    'You are the only owner of an org with other members. Make another member owner first.',
  forbidden: 'Platform accounts cannot be deleted here.',
  unauthenticated: 'Your session ended. Sign in again.',
  csrf_failed: 'The request was refused. Reload the page and try again.',
  identity_not_configured:
    'The studio cannot reach identity. Ask the operator to set NUXT_IDENTITY_URL.'
}

/** Page text for a failed delete ($fetch error). Own keys only. */
export function deleteAccountErrorText(err: unknown): string {
  const code = (err as { data?: { data?: { code?: unknown } } } | null)?.data?.data?.code
  return typeof code === 'string' && Object.hasOwn(messages, code)
    ? String(messages[code])
    : 'The account was not deleted. Try again later.'
}

/** The step-up for delete_account is still valid at `now` (ms). */
export function deleteStepUpValid(
  stepUp: { purpose: string; until: string } | undefined,
  now: number
): boolean {
  return stepUp?.purpose === 'delete_account' && Date.parse(stepUp.until) > now
}

export interface DeleteAccountView {
  /** start: explain and sign in again. confirm: type the word and delete. */
  step: 'start' | 'confirm'
  notice: string
}

/**
 * Which delete step the page shows: `confirm` only after the step-up sign-in came back
 * (?delete=confirm) and the session still has a valid step-up for delete_account.
 */
export function deleteAccountView(
  query: unknown,
  stepUp: { purpose: string; until: string } | undefined,
  now: number
): DeleteAccountView {
  const valid = deleteStepUpValid(stepUp, now)
  if (query === 'confirm' && valid) return { step: 'confirm', notice: '' }
  if (query === 'retry')
    return { step: 'start', notice: 'The new sign-in did not confirm that it was you. Try again.' }
  if (query === 'confirm')
    return { step: 'start', notice: 'The new sign-in is no longer valid. Start again.' }
  return { step: 'start', notice: '' }
}
