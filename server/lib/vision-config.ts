// Vision settings of the BFF. They come from the Nuxt runtime config (NUXT_VISION_*).

export interface VisionConfig {
  /** Base URL of synthwerk-vision, without a trailing slash. Server side only. */
  baseUrl: string
  /** Service token for the vision admin routes. Server side only; never logged. */
  adminToken: string
}

export interface RawVisionConfig {
  vision?: { url?: unknown; adminToken?: unknown }
}

export class VisionConfigError extends Error {}

/**
 * Reads and checks the vision settings. Throws VisionConfigError and names the variable, never
 * the token. Sign-in does not need these settings: only the /api/labels routes stop without them.
 */
export function readVisionConfig(raw: RawVisionConfig): VisionConfig {
  const value = typeof raw.vision?.url === 'string' ? raw.vision.url.trim() : ''
  if (value === '') {
    throw new VisionConfigError('vision is not configured: set NUXT_VISION_URL')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new VisionConfigError('NUXT_VISION_URL must be an absolute http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new VisionConfigError('NUXT_VISION_URL must be an absolute http(s) URL')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new VisionConfigError('NUXT_VISION_URL must have no user info, query or fragment')
  }
  const adminToken = typeof raw.vision?.adminToken === 'string' ? raw.vision.adminToken.trim() : ''
  if (adminToken === '') {
    throw new VisionConfigError('vision is not configured: set NUXT_VISION_ADMIN_TOKEN')
  }
  return { baseUrl: url.toString().replace(/\/+$/, ''), adminToken }
}
