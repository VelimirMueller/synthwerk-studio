// Studio app. The server routes in server/api/auth are the BFF: they run the OIDC code flow
// with Zitadel and keep every token on the server (synthwerk#95, docs/features/sign-in.md).
export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  devtools: { enabled: false },
  css: ['~/assets/app.css'],
  app: {
    head: {
      htmlAttrs: { lang: 'en', 'data-theme': 'default', 'data-mode': 'dark' },
      title: 'Synthwerk Studio'
    }
  },
  // Every value can be set at run time with NUXT_<PATH> (for example NUXT_OIDC_CLIENT_SECRET).
  // Secrets come only from the environment, never from this file.
  runtimeConfig: {
    oidc: {
      issuer: '',
      clientId: '',
      clientSecret: '',
      projectId: '',
      redirectUri: 'http://localhost:3000/api/auth/callback',
      postLogoutRedirectUri: 'http://localhost:3000/',
      requireMfa: false
    },
    session: {
      maxAgeSeconds: 28800,
      // Key material for the sealed login cookie. Env only: NUXT_SESSION_SECRET.
      secret: ''
    },
    // Pulse inside the network, for example http://pulse:8080 (NUXT_PULSE_BASE_URL).
    // The browser never calls it: server/api/health is the BFF (synthwerk#40).
    pulse: {
      baseUrl: ''
    },
    // Identity base URL as the studio server reaches it: NUXT_IDENTITY_URL. Apps (synthwerk#38),
    // users and audit (/api/org, synthwerk#37). Server side only.
    identity: { url: '' },
    public: {
      // The embed snippet (synthwerk#38): NUXT_PUBLIC_WIDGET_SCRIPT_URL, NUXT_PUBLIC_WIDGET_API_URL.
      widget: { scriptUrl: '', apiUrl: '' }
    }
  },
  nitro: {
    // Server-side session store. memory = one process only (local dev).
    storage: {
      auth: { driver: 'memory' }
    }
  },
  routeRules: {
    '/**': {
      headers: {
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY'
      }
    },
    '/api/auth/**': { headers: { 'cache-control': 'no-store' } },
    '/api/health/**': { headers: { 'cache-control': 'no-store' } },
    '/api/apps/**': { headers: { 'cache-control': 'no-store' } },
    '/api/org/**': { headers: { 'cache-control': 'no-store' } }
  },
  typescript: { strict: true }
})
