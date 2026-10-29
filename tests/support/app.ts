// Test harness: the BFF routes on an h3 app (same wiring as server/api/auth and
// server/middleware/csrf.ts), a memory store, and a browser that keeps cookies.
import { createApp, createRouter, eventHandler, toWebHandler } from 'h3'
import { AuthService } from '../../server/lib/auth'
import { type AuthConfig, readAuthConfig } from '../../server/lib/config'
import { OidcClient } from '../../server/lib/oidc'
import type { KeyValueStore } from '../../server/lib/session'
import { CLIENT_ID, CLIENT_SECRET, type MockProvider, REDIRECT_URI } from './provider'

export const ORIGIN = 'http://localhost:3000'

export class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, unknown>()
  async getItem(key: string) {
    return this.data.get(key) ?? null
  }
  async setItem(key: string, value: unknown) {
    // Like a real store: a copy, not the same object.
    this.data.set(key, structuredClone(value))
  }
  async removeItem(key: string) {
    this.data.delete(key)
  }
}

export interface Harness {
  service: AuthService
  store: MemoryStore
  config: AuthConfig
  logs: string[]
  clock: { now: number }
  handle: (request: Request) => Promise<Response>
}

export function buildApp(provider: MockProvider, overrides: Record<string, unknown> = {}): Harness {
  const config = readAuthConfig({
    oidc: {
      issuer: provider.issuer,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      projectId: 'project-1',
      redirectUri: REDIRECT_URI,
      postLogoutRedirectUri: `${ORIGIN}/`,
      ...overrides
    },
    session: { maxAgeSeconds: 3600 }
  })
  const store = new MemoryStore()
  const logs: string[] = []
  const clock = { now: Date.now() }
  const now = () => clock.now
  const service = new AuthService({
    config,
    store,
    oidc: new OidcClient(config, now),
    now,
    log: (level, message) => logs.push(`${level}: ${message}`)
  })
  const app = createApp()
  app.use(
    eventHandler((event) => {
      if (event.path.startsWith('/api/')) service.assertSameOrigin(event)
    })
  )
  const router = createRouter()
    .get(
      '/api/auth/login',
      eventHandler((e) => service.login(e))
    )
    .get(
      '/api/auth/callback',
      eventHandler((e) => service.callback(e))
    )
    .get(
      '/api/auth/session',
      eventHandler((e) => service.session(e))
    )
    .post(
      '/api/auth/logout',
      eventHandler((e) => service.logout(e))
    )
  app.use(router)
  const web = toWebHandler(app)
  return { service, store, config, logs, clock, handle: (request) => web(request) }
}

/** Keeps cookies like a browser on the studio origin (all cookies are path=/). */
export class Browser {
  readonly cookies = new Map<string, string>()
  /** Every Set-Cookie header the browser saw. */
  readonly setCookies: string[] = []

  constructor(private readonly harness: Harness) {}

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
    if (cookie) headers.set('cookie', cookie)
    const res = await this.harness.handle(
      new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: 'manual' })
    )
    for (const line of res.headers.getSetCookie()) {
      this.setCookies.push(line)
      const [pair] = line.split(';')
      const [name, ...rest] = (pair ?? '').split('=')
      const value = rest.join('=')
      if (!name) continue
      if (value === '' || /max-age=0/i.test(line)) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    return res
  }
}

/** Runs login, the provider sign-in and the callback. Returns every step's response and the code. */
export async function signIn(browser: Browser, provider: MockProvider, returnTo = '/me') {
  const login = await browser.fetch(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`)
  const authorize = login.headers.get('location') ?? ''
  const { code, state } = provider.issueCode(authorize)
  const callback = await browser.fetch(`/api/auth/callback?code=${code}&state=${state}`)
  return { login, authorize, callback, code, state }
}
