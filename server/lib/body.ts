// Reads the JSON body of a BFF write route with a hard size cap. Every route that reads a body
// uses it (apps, AI settings, members, labels, builder).
// - A Content-Length over the cap: 413 before one byte is read.
// - No Content-Length (chunked): the body is read as a stream and the read stops with 413 as
//   soon as the cap is passed. The rest is never buffered.
// - Bad JSON: 400 invalid_request. An empty body gives undefined.
import { createError, getHeader, type H3Event, readRawBody, setResponseHeader } from 'h3'

/** The cap of the small admin forms. The builder passes a larger one for a full page. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024

const tooLarge = (event: H3Event) => {
  // The rest of the body stays unread: the connection must not be reused.
  setResponseHeader(event, 'connection', 'close')
  return createError({
    statusCode: 413,
    statusMessage: 'Content Too Large',
    message: 'Content Too Large',
    data: { code: 'payload_too_large' }
  })
}

const invalid = () =>
  createError({
    statusCode: 400,
    statusMessage: 'Bad Request',
    message: 'Bad Request',
    data: { code: 'invalid_request' }
  })

/** Reads a web stream until its end or until `max` bytes are passed. */
async function readWebStream(
  event: H3Event,
  stream: ReadableStream<Uint8Array>,
  max: number
): Promise<Uint8Array[]> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return chunks
      size += value.byteLength
      if (size > max) {
        await reader.cancel().catch(() => {})
        throw tooLarge(event)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
}

/** Reads a Node request until its end or until `max` bytes are passed; then it stops reading. */
function readNodeStream(event: H3Event, max: number): Promise<Uint8Array[]> {
  const req = event.node.req
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let size = 0
    const done = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
    }
    const onData = (chunk: Uint8Array) => {
      size += chunk.byteLength
      if (size > max) {
        done()
        // No more reads: TCP back pressure holds the sender, the memory stays at `max`.
        req.pause()
        reject(tooLarge(event))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      done()
      resolve(chunks)
    }
    const onError = () => {
      done()
      reject(invalid())
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

async function readCapped(event: H3Event, max: number): Promise<Uint8Array[]> {
  const web = event.web?.request?.body
  if (web) return readWebStream(event, web, max)
  const req = event.node.req as unknown as Record<string | symbol, unknown>
  if (typeof req.on !== 'function' || '__unenv__' in req || 'rawBody' in req || 'body' in req) {
    // The body is in memory already (a test or prerender request): only the size check is left.
    const raw = await readRawBody(event, false)
    if (raw && raw.byteLength > max) throw tooLarge(event)
    return raw ? [raw] : []
  }
  return readNodeStream(event, max)
}

/** The parsed JSON body, or undefined for an empty body. See the file comment for the errors. */
export async function readJsonBody(
  event: H3Event,
  max: number = DEFAULT_MAX_BODY_BYTES
): Promise<unknown> {
  const length = Number(getHeader(event, 'content-length') ?? '')
  if (Number.isFinite(length) && length > max) throw tooLarge(event)
  const chunks = await readCapped(event, max)
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw invalid()
  }
}
