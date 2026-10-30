// Public: confirms a lead with the token from the mail link (synthwerk#105).
export default defineEventHandler((event) => useLeadApi().confirm(event))
