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
      maxAgeSeconds: 28800
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
    '/api/auth/**': { headers: { 'cache-control': 'no-store' } }
  },
  typescript: { strict: true }
})
