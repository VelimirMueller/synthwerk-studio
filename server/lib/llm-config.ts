// llm settings of the BFF. They come from the Nuxt runtime config (NUXT_LLM_URL).

export interface LlmConfig {
  /** Base URL of synthwerk-llm, without a trailing slash. Server side only. */
  baseUrl: string
}

export interface RawLlmConfig {
  llm?: { url?: unknown }
}

export class LlmConfigError extends Error {}

/**
 * Reads and checks the llm settings. Throws LlmConfigError and names the variable.
 * Only the /api/ai-settings routes need them.
 */
export function readLlmConfig(raw: RawLlmConfig): LlmConfig {
  const value = typeof raw.llm?.url === 'string' ? raw.llm.url.trim() : ''
  if (value === '') throw new LlmConfigError('llm is not configured: set NUXT_LLM_URL')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new LlmConfigError('NUXT_LLM_URL must be an absolute http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LlmConfigError('NUXT_LLM_URL must be an absolute http(s) URL')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new LlmConfigError('NUXT_LLM_URL must have no user info, query or fragment')
  }
  return { baseUrl: url.toString().replace(/\/+$/, '') }
}
