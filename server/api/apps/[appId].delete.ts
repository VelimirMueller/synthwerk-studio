export default defineEventHandler(async (event) => {
  await appRoute(event, 'remove')
  setResponseStatus(event, 204)
  return null
})
