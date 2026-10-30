// NatsBus against a real NATS server (synthwerk#106). Opt-in: set BUILDER_TEST_NATS_URL (no
// credentials in it) and BUILDER_TEST_NATS_USER / _PASSWORD of a user with only the studio rights
// of synthwerk-infra compose/nats/nats.conf. The stream EVT_STUDIO must exist (synthwerk-infra
// bus-init creates it). The infra stack test covers the same path in CI.
import { connect } from 'nats'
import { describe, expect, it } from 'vitest'
import { INBOX_PREFIX, NatsBus } from '../../server/lib/builder-nats'
import { STREAM_NAME } from '../../server/lib/builder-relay'
import { uuidv7 } from '../../server/lib/uuidv7'

const url = process.env.BUILDER_TEST_NATS_URL ?? ''
const config = {
  natsUrl: url,
  user: process.env.BUILDER_TEST_NATS_USER,
  password: process.env.BUILDER_TEST_NATS_PASSWORD,
  platformEnv: 'local'
}

const studioConnection = (inboxPrefix?: string) =>
  connect({ servers: url, user: config.user, pass: config.password, inboxPrefix })

describe.runIf(url !== '')('NatsBus (real NATS)', () => {
  it('same msg id - JetStream drops the copy', async () => {
    const bus = await NatsBus.open(config)
    try {
      const id = uuidv7()
      expect(await bus.publish('evt.studio.page.created.v1', '{"id":"x"}', id)).toEqual({
        duplicate: false
      })
      expect(await bus.publish('evt.studio.page.created.v1', '{"id":"x"}', id)).toEqual({
        duplicate: true
      })
    } finally {
      await bus.close()
    }
  })

  it('a subject outside evt.studio - refused for the studio user', async () => {
    const bus = await NatsBus.open(config)
    try {
      await expect(bus.publish('evt.identity.org.created.v1', '{}', uuidv7())).rejects.toThrow()
    } finally {
      await bus.close()
    }
  })

  it('stream update - refused for the studio user', async () => {
    const nc = await studioConnection(INBOX_PREFIX)
    try {
      const jsm = await nc.jetstreamManager({ checkAPI: false, timeout: 2_000 })
      await expect(
        jsm.streams.update(STREAM_NAME, { max_age: 3_600_000_000_000 })
      ).rejects.toThrow()
    } finally {
      await nc.close()
    }
  })

  it('subscribe to the shared _INBOX.> - refused for the studio user', async () => {
    const nc = await studioConnection()
    try {
      const sub = nc.subscribe('_INBOX.>')
      const next = (async () => {
        for await (const _ of sub) return 'message'
        return 'closed'
      })()
      await expect(next).rejects.toThrow(/permissions violation/i)
    } finally {
      await nc.close().catch(() => {})
    }
  })
})
