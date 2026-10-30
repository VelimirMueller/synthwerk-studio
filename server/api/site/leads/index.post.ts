// Public: the lead form (synthwerk#105). Origin check, rate limit, honeypot: server/lib/lead-api.ts.
export default defineEventHandler((event) => useLeadApi().submit(event))
