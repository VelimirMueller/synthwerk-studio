// Studio app. The server routes in server/api/auth are the BFF: they run the OIDC code flow
// with Zitadel and keep every token on the server (synthwerk#95, docs/features/sign-in.md).
// Public HTML: one minute fresh, five minutes stale while a CDN asks again.
const SITE_HTML_CACHE = 'public, max-age=60, stale-while-revalidate=300'

export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  devtools: { enabled: false },
  css: ['~/assets/app.css', '~/assets/site.css'],
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
    // llm base URL as the studio server reaches it: NUXT_LLM_URL. AI settings (synthwerk#39).
    // Server side only.
    llm: { url: '' },
    // Vision as the studio server reaches it (NUXT_VISION_URL) and the service token of its
    // admin routes (NUXT_VISION_ADMIN_TOKEN, env only). Label admin, synthwerk#44. Server side only.
    vision: { url: '', adminToken: '' },
    // The page builder database (synthwerk#46): NUXT_BUILDER_DATABASE_URL, a postgres:// URL owned
    // by the studio server. Env only (it holds the password). Server side only.
    // The relay of its events to EVT_STUDIO (synthwerk#106): NUXT_BUILDER_NATS_URL (empty = relay
    // off), NUXT_BUILDER_NATS_USER, NUXT_BUILDER_NATS_PASSWORD (env only),
    // NUXT_BUILDER_PLATFORM_ENV (local, dev, stg, prd or ci: the event source).
    builder: {
      databaseUrl: '',
      natsUrl: '',
      natsUser: '',
      natsPassword: '',
      platformEnv: 'local'
    },
    // The public site (synthwerk#109, #45): NUXT_SITE_ORG_ID, the org whose live builder pages
    // /api/site serves. A config value, never a request value. Server side only.
    // The lead form (synthwerk#105): NUXT_SITE_ORIGIN, the public origin (the form must come from
    // it, the confirm link points to it). NUXT_SITE_TRUST_FORWARDED_FOR=true behind the edge
    // proxy: the rate limit takes the client address from X-Forwarded-For.
    site: { orgId: '', origin: '', trustForwardedFor: false },
    // Outgoing mail (synthwerk#105, #73): NUXT_MAIL_PROVIDER smtp (Mailpit, NUXT_MAIL_SMTP_URL
    // smtp://mailpit:1025) or resend (NUXT_MAIL_RESEND_API_KEY, or the key in the file
    // NUXT_MAIL_RESEND_API_KEY_FILE). NUXT_MAIL_FROM is the sender. Key: env or file only.
    mail: { provider: '', from: '', smtpUrl: '', resendApiKey: '', resendApiKeyFile: '' },
    public: {
      // NUXT_PUBLIC_SITE_ENV (dev, stg, prd): every value but prd shows the test system banner.
      // Umami loads only after an opt-in: NUXT_PUBLIC_SITE_ANALYTICS_SCRIPT_URL (https or a path
      // on the own origin) and NUXT_PUBLIC_SITE_ANALYTICS_WEBSITE_ID. Empty: no analytics.
      site: { env: '', analytics: { scriptUrl: '', websiteId: '' } },
      // The embed snippet (synthwerk#38): NUXT_PUBLIC_WIDGET_SCRIPT_URL,
      // NUXT_PUBLIC_WIDGET_SCRIPT_INTEGRITY (SRI of that version, widgets#32), NUXT_PUBLIC_WIDGET_API_URL.
      widget: { scriptUrl: '', scriptIntegrity: '', apiUrl: '' }
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
    '/api/org/**': { headers: { 'cache-control': 'no-store' } },
    '/api/ai-settings/**': { headers: { 'cache-control': 'no-store' } },
    '/api/labels/**': { headers: { 'cache-control': 'no-store' } },
    '/api/builder/**': { headers: { 'cache-control': 'no-store' } },
    '/api/me': { headers: { 'cache-control': 'no-store' } },
    '/api/site/leads/**': { headers: { 'cache-control': 'no-store' } },
    '/api/site/leads': { headers: { 'cache-control': 'no-store' } },
    // The public site: same HTML for every visitor (the consent banner is client side), so a CDN
    // may keep it for a short time. A new locale in shared/sections.ts LOCALES needs its two rules here. /api/site sets its own headers and an ETag (server/lib/site-api.ts).
    '/de': { headers: { 'cache-control': SITE_HTML_CACHE } },
    '/de/**': { headers: { 'cache-control': SITE_HTML_CACHE } },
    '/en': { headers: { 'cache-control': SITE_HTML_CACHE } },
    '/en/**': { headers: { 'cache-control': SITE_HTML_CACHE } }
  },
  typescript: { strict: true }
})
