export default defineEventHandler(async (event) => {
  const app = await appRoute(event, 'create')
  setResponseStatus(event, 201)
  return app
})
