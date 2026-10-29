// Pages with `middleware: 'auth'` need a session. Without one, the BFF sign-in starts.
export default defineNuxtRouteMiddleware(async (to) => {
  const { load } = useAuthSession()
  if (!(await load())) return navigateTo(signInUrl(to.fullPath), { external: true })
})
