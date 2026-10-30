// The mail providers (synthwerk#105): settings, the Resend HTTP call and plain SMTP against a
// small fake server (what Mailpit does).
import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addressOf,
  buildMessage,
  createMailer,
  MailConfigError,
  MailError,
  RESEND_URL,
  ResendMailer,
  readMailConfig,
  SmtpMailer
} from '../../server/lib/mail'

const KEY = 're_test_secret_key_value'
const FROM = 'Synthwerk <noreply@mail.synthwerk.example>'

describe('readMailConfig', () => {
  it('no provider: null', () => {
    expect(readMailConfig({})).toBeNull()
    expect(readMailConfig({ mail: { provider: ' ' } })).toBeNull()
  })

  it('smtp: host and port, no login', () => {
    expect(
      readMailConfig({ mail: { provider: 'smtp', from: FROM, smtpUrl: 'smtp://mailpit:1025' } })
    ).toEqual({ provider: 'smtp', from: FROM, host: 'mailpit', port: 1025 })
    expect(
      readMailConfig({ mail: { provider: 'smtp', from: 'a@b.c', smtpUrl: 'smtp://mailpit' } })
    ).toMatchObject({ port: 25 })
    for (const smtpUrl of ['', 'http://mailpit:1025', 'smtp://u:p@mailpit:1025']) {
      expect(() => readMailConfig({ mail: { provider: 'smtp', from: FROM, smtpUrl } })).toThrow(
        MailConfigError
      )
    }
  })

  it('resend: key from env wins; else from the file; messages never hold the key', () => {
    expect(readMailConfig({ mail: { provider: 'resend', from: FROM, resendApiKey: KEY } })).toEqual(
      { provider: 'resend', from: FROM, apiKey: KEY }
    )
    const fromFile = readMailConfig(
      { mail: { provider: 'resend', from: FROM, resendApiKeyFile: '/run/secrets/resend' } },
      () => `${KEY}\n`
    )
    expect(fromFile).toMatchObject({ apiKey: KEY })
    const missing = () =>
      readMailConfig(
        { mail: { provider: 'resend', from: FROM, resendApiKeyFile: '/nope' } },
        () => {
          throw Object.assign(new Error(`ENOENT ${KEY}`), { code: 'ENOENT' })
        }
      )
    expect(missing).toThrow('cannot read NUXT_MAIL_RESEND_API_KEY_FILE (ENOENT)')
    expect(() => readMailConfig({ mail: { provider: 'resend', from: FROM } })).toThrow(
      /needs NUXT_MAIL_RESEND_API_KEY/
    )
  })

  it('refuses a bad sender or provider', () => {
    expect(() => readMailConfig({ mail: { provider: 'resend', from: 'nobody' } })).toThrow(
      /NUXT_MAIL_FROM/
    )
    expect(() =>
      readMailConfig({
        mail: { provider: 'resend', from: 'a@b.c\r\nBcc: x@y.z', resendApiKey: KEY }
      })
    ).toThrow(/NUXT_MAIL_FROM/)
    expect(() => readMailConfig({ mail: { provider: 'ses', from: FROM } })).toThrow(
      'NUXT_MAIL_PROVIDER must be smtp or resend'
    )
  })

  it('createMailer picks the provider', () => {
    expect(createMailer({ provider: 'smtp', from: FROM, host: 'h', port: 1 }).provider).toBe('smtp')
    expect(createMailer({ provider: 'resend', from: FROM, apiKey: KEY }).provider).toBe('resend')
  })
})

describe('addressOf', () => {
  it('reads the bare address', () => {
    expect(addressOf(FROM)).toBe('noreply@mail.synthwerk.example')
    expect(addressOf('a@b.c')).toBe('a@b.c')
    expect(addressOf('A <a b@c>')).toBeNull()
    expect(addressOf('a@b.c\n')).toBeNull()
  })
})

describe('ResendMailer', () => {
  it('posts a text-only mail with the key and the idempotency key', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response('{"id":"x"}', { status: 200 })
    }) as unknown as typeof fetch
    await new ResendMailer(KEY, FROM, fake).send({
      to: 'ada@example.com',
      subject: 'Hi',
      text: 'Body',
      idempotencyKey: 'lead-1'
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(RESEND_URL)
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${KEY}`)
    expect(headers['idempotency-key']).toBe('lead-1')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      from: FROM,
      to: ['ada@example.com'],
      subject: 'Hi',
      text: 'Body'
    })
  })

  it('a refusal or a network error is a MailError without the key or the address', async () => {
    const refuse = (async () => new Response('{}', { status: 422 })) as unknown as typeof fetch
    const err = await new ResendMailer(KEY, FROM, refuse)
      .send({ to: 'ada@example.com', subject: 's', text: 't' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MailError)
    expect((err as Error).message).toBe('resend refused the mail (status 422)')
    const down = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const err2 = await new ResendMailer(KEY, FROM, down)
      .send({ to: 'ada@example.com', subject: 's', text: 't' })
      .catch((e: unknown) => e)
    expect((err2 as Error).message).toBe('resend not reachable (TypeError)')
    for (const e of [err, err2]) {
      expect((e as Error).message).not.toContain(KEY)
      expect((e as Error).message).not.toContain('ada@')
    }
  })

  it('refuses a recipient or subject that would break a header', async () => {
    const never = (async () => {
      throw new Error('must not be called')
    }) as unknown as typeof fetch
    const m = new ResendMailer(KEY, FROM, never)
    await expect(m.send({ to: 'a@b.c\r\nBcc: x@y.z', subject: 's', text: 't' })).rejects.toThrow(
      'bad recipient'
    )
    await expect(m.send({ to: 'A <a@b.c>', subject: 's', text: 't' })).rejects.toThrow(
      'bad recipient'
    )
    await expect(m.send({ to: 'a@b.c', subject: 's\nX: y', text: 't' })).rejects.toThrow(
      'bad subject'
    )
  })
})

describe('buildMessage', () => {
  it('has the headers, an encoded subject and a base64 body', () => {
    const msg = buildMessage(
      FROM,
      { to: 'ada@example.com', subject: 'Bitte bestätigen', text: 'Zeile 1\n.\nZeile 3' },
      new Date('2026-10-30T10:00:00Z'),
      'id-1'
    )
    expect(msg).toContain(`From: ${FROM}\r\n`)
    expect(msg).toContain('To: ada@example.com\r\n')
    expect(msg).toContain(
      `Subject: =?UTF-8?B?${Buffer.from('Bitte bestätigen').toString('base64')}?=`
    )
    expect(msg).toContain('Message-ID: <id-1@mail.synthwerk.example>')
    const body = msg.split('\r\n\r\n')[1] ?? ''
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe(
      'Zeile 1\r\n.\r\nZeile 3'
    )
    expect(
      buildMessage(FROM, { to: 'a@b.c', subject: 'Plain', text: '' }, new Date(), 'x')
    ).toContain('Subject: Plain\r\n')
  })
})

describe('SmtpMailer', () => {
  let server: Server | undefined
  afterEach(() => server?.close())

  /** A fake SMTP server. `refuse` answers 550 to RCPT TO. */
  function smtp(refuse = false): Promise<{ port: number; got: string[] }> {
    const got: string[] = []
    server = createServer((socket) => {
      let data = false
      let buffer = ''
      socket.on('error', () => {})
      socket.write('220 fake ESMTP\r\n')
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        for (;;) {
          if (data) {
            const end = buffer.indexOf('\r\n.\r\n')
            if (end < 0) return
            got.push(`DATA ${buffer.slice(0, end)}`)
            buffer = buffer.slice(end + 5)
            data = false
            socket.write('250 queued\r\n')
            continue
          }
          const end = buffer.indexOf('\r\n')
          if (end < 0) return
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          got.push(line)
          if (line.startsWith('EHLO')) socket.write('250-fake\r\n250 SIZE 1000\r\n')
          else if (line.startsWith('RCPT') && refuse) socket.write('550 no\r\n')
          else if (line === 'DATA') {
            data = true
            socket.write('354 go\r\n')
          } else if (line === 'QUIT') socket.end('221 bye\r\n')
          else socket.write('250 ok\r\n')
        }
      })
    })
    return new Promise((resolve) =>
      server?.listen(0, '127.0.0.1', () => {
        const addr = server?.address()
        resolve({ port: typeof addr === 'object' && addr ? addr.port : 0, got })
      })
    )
  }

  it('sends one mail with EHLO, MAIL FROM, RCPT TO and DATA', async () => {
    const { port, got } = await smtp()
    await new SmtpMailer('127.0.0.1', port, FROM).send({
      to: 'ada@example.com',
      subject: 'Hi',
      text: 'Body'
    })
    expect(got.slice(0, 4)).toEqual([
      'EHLO synthwerk-studio',
      'MAIL FROM:<noreply@mail.synthwerk.example>',
      'RCPT TO:<ada@example.com>',
      'DATA'
    ])
    expect(got[4]).toContain('Subject: Hi')
  })

  it('a refusal or no server is a MailError', async () => {
    const { port } = await smtp(true)
    await expect(
      new SmtpMailer('127.0.0.1', port, FROM).send({ to: 'a@b.c', subject: 's', text: 't' })
    ).rejects.toThrow('smtp refused (550)')
    server?.close()
    await expect(
      new SmtpMailer('127.0.0.1', port, FROM).send({ to: 'a@b.c', subject: 's', text: 't' })
    ).rejects.toThrow(/^smtp failed \(ECONNREFUSED\)$/)
  })
})

describe('SmtpMailer settings', () => {
  it('refuses a sender without an address', () => {
    expect(() => new SmtpMailer('h', 25, 'nobody')).toThrow(MailConfigError)
  })
})
