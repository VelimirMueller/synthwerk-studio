// One LeadApi per server process (synthwerk#105). It shares the builder pool. Missing
// NUXT_SITE_ORIGIN, NUXT_MAIL_PROVIDER or the database stop only the lead routes (503). The log
// lines name the variables, never a value.
import { LeadApi } from '../lib/lead-api'
import { createMailer, MailConfigError, type Mailer, readMailConfig } from '../lib/mail'
import { RateLimiter } from '../lib/rate-limit'
import { readSiteConfig, SiteConfigError } from '../lib/site-config'

let api: LeadApi | undefined

export function useLeadApi(): LeadApi {
  if (!api) {
    const log = (level: 'warn' | 'error', message: string) => console[level](`[leads] ${message}`)
    const config = useRuntimeConfig()
    let site: ReturnType<typeof readSiteConfig> | SiteConfigError
    try {
      site = readSiteConfig(config)
      if (site.origin === null) log('warn', 'lead form is off: set NUXT_SITE_ORIGIN')
    } catch (err) {
      if (!(err instanceof SiteConfigError)) throw err
      log('warn', err.message)
      site = err
    }
    let mailer: Mailer | null = null
    try {
      const mail = readMailConfig(config)
      if (mail) mailer = createMailer(mail)
      else log('warn', 'lead form is off: set NUXT_MAIL_PROVIDER (smtp or resend)')
    } catch (err) {
      if (!(err instanceof MailConfigError)) throw err
      log('warn', err.message)
    }
    api = new LeadApi({ site, store: useBuilderStore(), mailer, limiter: new RateLimiter(), log })
  }
  return api
}
