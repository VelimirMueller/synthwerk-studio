// A fake synthwerk-vision for the label-set admin routes, as a fetch stub. It records every call
// and answers like the contract (synthwerk#44): service bearer token, FastAPI `detail` errors.

export const VISION_URL = 'http://vision.test'
export const ADMIN_TOKEN = 'vision-admin-token-0123456789'

export interface VisionCall {
  method: string
  path: string
  authorization: string
  contentType: string
  body: unknown
}

export interface VisionAnswer {
  status: number
  body?: unknown
  /** Raw text instead of JSON. */
  text?: string
}

export const LABEL = {
  id: 'runtime:red-barn',
  name: 'red barn',
  topic: 'building',
  prompt: 'a photo of a red barn',
  path: ['place', 'building', 'red barn']
}

export const LABEL_SET = {
  org_id: 'org-demo',
  custom: true,
  labels: [LABEL],
  topics: [
    { id: 'place', parent: null, depth: 0 },
    { id: 'building', parent: 'place', depth: 1 }
  ],
  total_labels: 1001
}

/** A FastAPI error body. The detail must never reach the browser. */
export const detail = (status: number): VisionAnswer => ({
  status,
  body: { detail: 'secret vision detail' }
})

export class FakeVision {
  readonly calls: VisionCall[] = []
  /** Answers by `METHOD path`. They win over the defaults. */
  readonly answers = new Map<string, VisionAnswer>()
  /** Throws like a network failure when set. */
  down = false

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const path = decodeURIComponent(url.pathname)
    const headers = new Headers(init.headers)
    const method = init.method ?? 'GET'
    this.calls.push({
      method,
      path,
      authorization: headers.get('authorization') ?? '',
      contentType: headers.get('content-type') ?? '',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    })
    if (this.down) throw new TypeError('fetch failed')
    const answer = this.answer(method, path, headers.get('authorization') ?? '')
    if (answer.text !== undefined) {
      return new Response(answer.text, {
        status: answer.status,
        headers: { 'content-type': 'text/plain' }
      })
    }
    if (answer.status === 204) return new Response(null, { status: 204 })
    return new Response(JSON.stringify(answer.body ?? null), {
      status: answer.status,
      headers: { 'content-type': 'application/json' }
    })
  }

  private answer(method: string, path: string, authorization: string): VisionAnswer {
    if (authorization !== `Bearer ${ADMIN_TOKEN}`) return detail(401)
    const fixed = this.answers.get(`${method} ${path}`)
    if (fixed) return fixed
    const match = path.match(/^\/v1\/orgs\/([^/]+)\/labels(?:\/([^/]+))?$/)
    if (!match) return detail(404)
    const [, , labelId] = match
    if (method === 'GET' && !labelId) return { status: 200, body: { ...LABEL_SET, extra: 'drop' } }
    if (method === 'POST' && !labelId) return { status: 201, body: { ...LABEL, extra: 'drop' } }
    if (method === 'DELETE' && labelId === LABEL.id) return { status: 204 }
    return detail(404)
  }
}

/** One fetch for both fakes: the host picks the service. */
export function routeFetch(
  services: Record<string, (input: string | URL | Request, init?: RequestInit) => Promise<Response>>
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const target = services[url.origin]
    if (!target) throw new TypeError(`no fake for ${url.origin}`)
    return target(input, init)
  }) as typeof fetch
}
