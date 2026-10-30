// NatsBus against a real NATS server (synthwerk#106). Opt-in: set BUILDER_TEST_NATS_URL (no
// credentials in it) and BUILDER_TEST_NATS_USER / _PASSWORD of a user with only the studio rights
// of synthwerk-infra compose/nats/nats.conf. The infra stack test covers the same path in CI.
import { describe, expect, it } from 'vitest'
import { NatsBus } from '../../server/lib/builder-nats'
import { uuidv7 } from '../../server/lib/uuidv7'

const url = process.env.BUILDER_TEST_NATS_URL ?? ''
const config = {
  natsUrl: url,
  user: process.env.BUILDER_TEST_NATS_USER,
  password: process.env.BUILDER_TEST_NATS_PASSWORD,
  platformEnv: 'local'
}

describe.runIf(url !== '')('NatsBus (real NATS)', () => {
  it('open twice - creates then updates EVT_STUDIO; same msg id - JetStream drops the copy', async () => {
    const first = await NatsBus.open(config)
    await first.close()
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
})
