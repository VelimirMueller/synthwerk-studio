// The llm AI settings routes for the BFF (synthwerk#39). NUXT_LLM_URL is the llm base URL as
// the studio server reaches it (inside the stack, not the public edge).
import type { H3Event } from 'h3'
import {
  type AiSettingsApi,
  aiSettingsApiFrom,
  type aiSettingsRoutes,
  runAiSettingsRoute
} from '../lib/ai-settings'

let api: AiSettingsApi | undefined

/** One llm client per server process. Unset NUXT_LLM_URL: 503 `not_configured`, read again next time. */
function useAiSettingsApi(): AiSettingsApi {
  api ??= aiSettingsApiFrom(useRuntimeConfig())
  return api
}

/** Runs one AI settings route (server/lib/ai-settings.ts aiSettingsRoutes) as the signed-in user. */
export function aiSettingsRoute(event: H3Event, name: keyof typeof aiSettingsRoutes) {
  return runAiSettingsRoute(event, { auth: useAuth(), api: useAiSettingsApi }, name)
}
