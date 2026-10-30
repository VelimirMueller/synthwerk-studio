// The AI settings of the signed-in user's org, through the BFF (/api/ai-settings, synthwerk#39).
// The BFF holds the token; a save sends the CSRF token of the session.

export interface AiSettingsBounds {
  models: string[]
  maxInputChars: number
  /** 0 = the plan has no limit. */
  userTokensPerDay: number
  systemPromptMaxChars: number
  temperatureMax: number
}

export interface AiSettings {
  model: string
  allowedModels: string[]
  systemPrompt: string
  maxInputChars: number
  /** 0 = the plan limit only. */
  userTokensPerDay: number
  /** null = the model default. */
  temperature: number | null
  version: number
  updatedAt: string | null
  bounds: AiSettingsBounds
}

export type AiSettingsUpdate = Omit<AiSettings, 'updatedAt' | 'bounds'>

/** Status, code and detail of a failed call. `status` 0 = no answer. */
export interface AiSettingsError {
  status: number
  code: string
  detail: string
}

export function aiSettingsError(err: unknown): AiSettingsError {
  const e = err as {
    statusCode?: unknown
    data?: { data?: { code?: unknown; detail?: unknown } }
  } | null
  const data = e?.data?.data
  return {
    status: typeof e?.statusCode === 'number' ? e.statusCode : 0,
    code: typeof data?.code === 'string' ? data.code : '',
    detail: typeof data?.detail === 'string' ? data.detail : ''
  }
}

const messages: Record<string, string> = {
  invalid_request: 'A value is not valid.',
  unauthenticated: 'Your session ended. Sign in again.',
  csrf_failed: 'The request was refused. Reload the page and try again.',
  version_conflict: 'The settings changed. Reload them.',
  settings_unavailable: 'The AI service cannot check your role now. Try again later.',
  not_configured: 'The studio cannot reach the AI service. Ask the operator to set NUXT_LLM_URL.'
}

/** Page text for a failed call: the known code, plus the detail of llm. Plain text. */
export function aiSettingsErrorText(e: AiSettingsError): string {
  const text = Object.hasOwn(messages, e.code)
    ? (messages[e.code] ?? '')
    : 'The AI service is not available. Try again.'
  return e.detail ? `${text} ${e.detail}` : text
}

export function useAiSettings() {
  const { session } = useAuthSession()
  return {
    save: (s: AiSettingsUpdate) =>
      $fetch<AiSettings>('/api/ai-settings', {
        method: 'PUT',
        headers: { 'x-csrf-token': session.value?.csrfToken ?? '' },
        body: s
      })
  }
}
