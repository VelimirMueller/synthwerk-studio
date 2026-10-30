// Outgoing mail of the studio server (synthwerk#105, docs/features/leads.md). Two providers
// behind one interface:
// - `smtp`: plain SMTP without TLS or login, for Mailpit in the local stack and in CI.
// - `resend`: the Resend HTTP API (synthwerk#73). The API key comes from the environment or a
//   file and is never logged.
// Every mail is plain text: no HTML, so no tracking pixel and no rewritten links. Resend keeps
// metadata in the US: a mail holds only what the reader needs (no name, no page content).
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Socket } from 'node:net'

export interface Mail {
  to: string
  subject: string
  text: string
  /** Same key, same mail: a retry does not send twice (Resend Idempotency-Key). */
  idempotencyKey?: string
}

export interface Mailer {
  readonly provider: 'smtp' | 'resend'
  send(mail: Mail): Promise<void>
}

/** A send failed. The message names the cause class, never an address or the key. */
export class MailError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MailError'
  }
}

export class MailConfigError extends Error {}

export interface RawMailConfig {
  mail?: {
    provider?: unknown
    from?: unknown
    smtpUrl?: unknown
    resendApiKey?: unknown
    resendApiKeyFile?: unknown
  }
}

export type MailConfig =
  | { provider: 'smtp'; from: string; host: string; port: number }
  | { provider: 'resend'; from: string; apiKey: string }

// biome-ignore lint/suspicious/noControlCharactersInRegex: header values must not break lines
const CONTROL = /[\u0000-\u001f\u007f]/
const ADDRESS = /^[^\s@<>]+@[^\s@<>]+$/

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

/** The bare address of `Name <addr>` or `addr`, or null. */
export function addressOf(from: string): string | null {
  if (CONTROL.test(from)) return null
  const angle = /^[^<>]*<([^<>]+)>$/.exec(from)
  const addr = angle ? (angle[1] ?? '') : from
  return ADDRESS.test(addr) ? addr : null
}

/**
 * Reads the mail settings. No provider: null (the lead form answers 503). The messages name
 * the variables, never a value.
 */
export function readMailConfig(
  raw: RawMailConfig,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8')
): MailConfig | null {
  const provider = text(raw.mail?.provider)
  if (provider === '') return null
  const from = text(raw.mail?.from)
  if (!addressOf(from)) {
    throw new MailConfigError('NUXT_MAIL_FROM must be "Name <address>" or an address')
  }
  if (provider === 'smtp') {
    let url: URL
    try {
      url = new URL(text(raw.mail?.smtpUrl))
    } catch {
      throw new MailConfigError('NUXT_MAIL_SMTP_URL must be smtp://host:port')
    }
    if (url.protocol !== 'smtp:' || url.hostname === '' || url.username || url.password) {
      throw new MailConfigError('NUXT_MAIL_SMTP_URL must be smtp://host:port (no login)')
    }
    return { provider, from, host: url.hostname, port: Number(url.port || '25') }
  }
  if (provider === 'resend') {
    let apiKey = text(raw.mail?.resendApiKey)
    const file = text(raw.mail?.resendApiKeyFile)
    if (apiKey === '' && file !== '') {
      try {
        apiKey = readFile(file).trim()
      } catch (err) {
        const code = (err as { code?: unknown }).code
        throw new MailConfigError(
          `cannot read NUXT_MAIL_RESEND_API_KEY_FILE (${typeof code === 'string' ? code : 'error'})`
        )
      }
    }
    if (apiKey === '' || CONTROL.test(apiKey)) {
      throw new MailConfigError(
        'mail provider resend needs NUXT_MAIL_RESEND_API_KEY or NUXT_MAIL_RESEND_API_KEY_FILE'
      )
    }
    return { provider, from, apiKey }
  }
  throw new MailConfigError('NUXT_MAIL_PROVIDER must be smtp or resend')
}

export function createMailer(config: MailConfig, fetchImpl?: typeof fetch): Mailer {
  return config.provider === 'smtp'
    ? new SmtpMailer(config.host, config.port, config.from)
    : new ResendMailer(config.apiKey, config.from, fetchImpl)
}

function checkMail(mail: Mail) {
  if (!addressOf(mail.to) || mail.to.includes('<')) throw new MailError('bad recipient')
  if (CONTROL.test(mail.subject)) throw new MailError('bad subject')
}

export const RESEND_URL = 'https://api.resend.com/emails'
const TIMEOUT_MS = 10_000

/** The Resend HTTP API. Text only: Resend adds no open pixel and rewrites no link in a text mail. */
export class ResendMailer implements Mailer {
  readonly provider = 'resend'
  private readonly fetch: typeof fetch

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    fetchImpl?: typeof fetch
  ) {
    this.fetch = fetchImpl ?? globalThis.fetch
  }

  async send(mail: Mail): Promise<void> {
    checkMail(mail)
    let res: Response
    try {
      res = await this.fetch(RESEND_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          ...(mail.idempotencyKey ? { 'idempotency-key': mail.idempotencyKey } : {})
        },
        body: JSON.stringify({
          from: this.from,
          to: [mail.to],
          subject: mail.subject,
          text: mail.text
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch (err) {
      throw new MailError(`resend not reachable (${err instanceof Error ? err.name : 'error'})`)
    }
    void res.body?.cancel().catch(() => {})
    if (!res.ok) throw new MailError(`resend refused the mail (status ${res.status})`)
  }
}

/** RFC 2047 encoded word for a header with non-ASCII text. */
function encodeHeader(value: string): string {
  // Printable ASCII stays as it is.
  return /^[ -~]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

/** The message: headers and a base64 body (no dot-stuffing and no long lines to care about). */
export function buildMessage(from: string, mail: Mail, now: Date, id: string): string {
  const body =
    Buffer.from(mail.text.replace(/\r?\n/g, '\r\n'), 'utf8')
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') ?? ''
  const domain = (addressOf(from) ?? 'localhost').split('@')[1]
  return [
    `From: ${from}`,
    `To: ${mail.to}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${id}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
    ''
  ].join('\r\n')
}

/**
 * Plain SMTP for Mailpit: EHLO, MAIL FROM, RCPT TO, DATA, QUIT. No TLS and no login, so it is
 * for a mail catcher inside the stack only.
 */
export class SmtpMailer implements Mailer {
  readonly provider = 'smtp'

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly from: string
  ) {}

  async send(mail: Mail): Promise<void> {
    checkMail(mail)
    const sender = addressOf(this.from) ?? ''
    const message = buildMessage(this.from, mail, new Date(), randomUUID())
    const socket = new Socket()
    socket.setTimeout(TIMEOUT_MS)
    const replies = replyReader(socket)
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject)
        socket.connect(this.port, this.host, () => {
          socket.off('error', reject)
          resolve()
        })
      })
      await expectReply(replies, 220)
      await command(socket, replies, 'EHLO synthwerk-studio', 250)
      await command(socket, replies, `MAIL FROM:<${sender}>`, 250)
      await command(socket, replies, `RCPT TO:<${mail.to}>`, 250)
      await command(socket, replies, 'DATA', 354)
      await command(socket, replies, `${message}\r\n.`, 250)
      socket.write('QUIT\r\n')
    } catch (err) {
      if (err instanceof MailError) throw err
      throw new MailError(`smtp failed (${(err as { code?: string }).code ?? 'error'})`)
    } finally {
      socket.end()
      socket.destroy()
    }
  }
}

type Replies = () => Promise<{ code: number }>

/** Reads one SMTP reply at a time (the last line of a multi-line reply has a space). */
function replyReader(socket: Socket): Replies {
  let buffer = ''
  const done: { code: number }[] = []
  const waiting: { resolve: (r: { code: number }) => void; reject: (e: Error) => void }[] = []
  let failed: Error | null = null
  const fail = (err: Error) => {
    failed = err
    for (const w of waiting.splice(0)) w.reject(err)
  }
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const end = buffer.indexOf('\r\n')
      if (end < 0) break
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)) }
        const w = waiting.shift()
        if (w) w.resolve(reply)
        else done.push(reply)
      }
    }
  })
  socket.on('timeout', () => fail(new MailError('smtp timeout')))
  socket.on('error', (err) =>
    fail(new MailError(`smtp failed (${(err as { code?: string }).code ?? 'error'})`))
  )
  socket.on('close', () => fail(new MailError('smtp closed the connection')))
  return () => {
    const ready = done.shift()
    if (ready) return Promise.resolve(ready)
    if (failed) return Promise.reject(failed)
    return new Promise((resolve, reject) => waiting.push({ resolve, reject }))
  }
}

async function expectReply(replies: Replies, code: number) {
  const reply = await replies()
  if (reply.code !== code) throw new MailError(`smtp refused (${reply.code})`)
}

async function command(socket: Socket, replies: Replies, line: string, code: number) {
  socket.write(`${line}\r\n`)
  await expectReply(replies, code)
}
