// Delete the own account (synthwerk#41): DELETE /api/me after the step-up sign-in.

export function useAccount() {
  const { session } = useAuthSession()
  return {
    deleteAccount: () =>
      $fetch<{ status: 'accepted'; deletedOrgIds: string[] }>('/api/me', {
        method: 'DELETE',
        headers: { 'x-csrf-token': session.value?.csrfToken ?? '' }
      })
  }
}
