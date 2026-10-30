// Public: no session. Only the live version of a page of the site org (synthwerk#109).
export default defineEventHandler((event) => useSiteApi().live(event))
