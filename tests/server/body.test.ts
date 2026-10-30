// The capped JSON body reader of every BFF write route (server/lib/body.ts): on the web path
// (toWebHandler, as the other route tests) and on the Node path (a real HTTP server, as Nitro).
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, eventHandler, toNodeListener, toWebHandler } from 'h3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_MAX_BODY_BYTES, readJsonBody } from '../../server/lib/body'

const MAX = 1024
const CHUNK = 256

/** Status codes of the errors the app answered with. */
const errors: number[] = []

function app() {
  const a = createApp({ onError: (err) => void errors.push(err.statusCode) })
  a.use(eventHandler(async (event) => ({ body: (await readJsonBody(event, MAX)) ?? null })))
  return a
}

const web = toWebHandler(app())

/** A chunked body (no Content-Length) of `total` bytes. `pulled` counts what the reader took. */
function chunked(total: number) {
  const state = { pulled: 0 }
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= total) return controller.close()
      state.pulled += CHUNK
      controller.enqueue(new Uint8Array(CHUNK).fill(0x20))
    }
  })
  return { state, stream }
}

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  web(
    new Request('http://studio.test/', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', ...headers },
      duplex: 'half'
    } as RequestInit)
  )

const code = async (res: Response) =>
  ((await res.json()) as { data?: { code?: string } }).data?.code

describe('readJsonBody - web stream', () => {
  it('a normal body passes', async () => {
    const res = await post(JSON.stringify({ a: 1 }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ body: { a: 1 } })
  })

  it('an empty body gives undefined; bad JSON gives 400 invalid_request', async () => {
    expect(await (await post(null)).json()).toEqual({ body: null })
    const res = await post('{bad')
    expect(res.status).toBe(400)
    expect(await code(res)).toBe('invalid_request')
  })

  it('a chunked body over the cap - 413, the read stops near the cap', async () => {
    const { state, stream } = chunked(10 * 1024 * 1024)
    const res = await post(stream)
    expect(res.status).toBe(413)
    expect(await code(res)).toBe('payload_too_large')
    expect(res.headers.get('connection')).toBe('close')
    expect(state.pulled).toBeLessThanOrEqual(MAX + 4 * CHUNK)
  })

  it('a chunked body under the cap passes', async () => {
    const { stream } = chunked(MAX - CHUNK)
    const res = await post(stream)
    // White space only: an empty body.
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ body: null })
  })

  it('a Content-Length over the cap - 413 before a byte is read', async () => {
    const { state, stream } = chunked(10 * MAX)
    const res = await post(stream, { 'content-length': String(10 * MAX) })
    expect(res.status).toBe(413)
    expect(state.pulled).toBeLessThanOrEqual(CHUNK)
  })

  it('the default cap is 64 KiB', () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(65536)
  })
})

describe('readJsonBody - Node request (as Nitro)', () => {
  let server: Server
  let port = 0

  beforeAll(async () => {
    server = createServer(toNodeListener(app()))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  /** Sends a chunked body of `total` bytes. Stops writing when the answer comes. */
  function send(total: number, first?: string) {
    return new Promise<{ status: number; body: string; written: number }>((resolve) => {
      let written = 0
      let answered = false
      const req = httpRequest(
        {
          port,
          host: '127.0.0.1',
          method: 'POST',
          path: '/',
          headers: { 'content-type': 'application/json' }
        },
        (res) => {
          answered = true
          req.removeAllListeners('error')
          req.on('error', () => {})
          let body = ''
          res.on('data', (c) => {
            body += c
          })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body, written }))
        }
      )
      // The server answers 413 and closes the connection, so the client can see a write error
      // (EPIPE, reset) before it parses the answer. Status 0 = closed without a parsed answer.
      req.on('error', () => {
        answered = true
        resolve({ status: 0, body: '', written })
      })
      if (first !== undefined) {
        req.end(first)
        written = first.length
        return
      }
      const block = Buffer.alloc(64 * 1024, 0x20)
      const pump = () => {
        while (!answered && written < total) {
          written += block.length
          if (!req.write(block)) return void req.once('drain', pump)
        }
        if (!answered) req.end()
      }
      pump()
    })
  }

  it('a normal body passes', async () => {
    const res = await send(0, JSON.stringify({ ok: true }))
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ body: { ok: true } })
  })

  it('a chunked body of 256 MiB - 413, the server stops reading long before the end', async () => {
    errors.length = 0
    const res = await send(256 * 1024 * 1024)
    expect(errors).toEqual([413])
    if (res.status !== 0) {
      expect(res.status).toBe(413)
      expect(JSON.parse(res.body).data.code).toBe('payload_too_large')
    }
    expect(res.written).toBeLessThan(64 * 1024 * 1024)
  })
})
