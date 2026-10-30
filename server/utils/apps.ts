// The identity app routes for the BFF (synthwerk#38). NUXT_IDENTITY_URL is the identity base
// URL as the studio server reaches it (inside the stack, not the public edge).
import type { H3Event } from 'h3'
import { createError } from 'h3'
import { AppsApi, type appRoutes, runAppRoute } from '../lib/apps'

let api: AppsApi | undefined

function useAppsApi(): AppsApi {
  if (!api) {
    const url = String(useRuntimeConfig().identity?.url ?? '').trim()
    if (!url) {
      console.error('[apps] NUXT_IDENTITY_URL is not set')
      throw createError({
        statusCode: 503,
        statusMessage: 'Service Unavailable',
        data: { code: 'not_configured' }
      })
    }
    api = new AppsApi(url)
  }
  return api
}

/** Runs one app route (server/lib/apps.ts appRoutes) as the signed-in member. */
export function appRoute<K extends keyof typeof appRoutes>(event: H3Event, name: K) {
  return runAppRoute(event, { auth: useAuth(), api: useAppsApi() }, name)
}
