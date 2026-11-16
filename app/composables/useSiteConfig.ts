// The public site settings per environment: test system banner and analytics (synthwerk#45).
// A prerendered page (the legal pages) holds the runtime config of the build in its HTML, not
// the config of the running server. After such a first page the client asks /api/site/config
// once. Until that answer, the build values show and no analytics script loads.
import { type PublicSiteConfig, publicSiteConfig } from '#shared/site'

export function useSiteConfig() {
  const nuxtApp = useNuxtApp()
  // Set only when the first page of this visit came prerendered. Navigations keep the value.
  const stale = Boolean(nuxtApp.payload.prerenderedAt)
  const built = publicSiteConfig(useRuntimeConfig().public.site)
  const live = useState<PublicSiteConfig | null>('site-config', () => null)

  const config = computed(() => live.value ?? built)
  /** The values are those of the running server. */
  const ready = computed(() => !stale || live.value !== null)

  /** Asks the server once after a prerendered first page. Call it in onMounted. */
  async function load() {
    if (!import.meta.client || !stale || live.value) return
    try {
      live.value = publicSiteConfig(await $fetch('/api/site/config'))
    } catch {
      // Keep the build values. Analytics stays off: `ready` stays false.
    }
  }

  return { config, ready, load }
}
