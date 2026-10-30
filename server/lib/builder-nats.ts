// The NATS JetStream side of the builder relay (synthwerk#106), with the official `nats` client.
// The studio NATS user has least privilege: it publishes to evt.studio.> and reads the publish acks
// on its own inbox prefix. It cannot create or change EVT_STUDIO: synthwerk-infra creates the
// stream (bus-init). While the stream is missing, a publish fails and the relay tries again.
// No message here holds the URL, the user or the password.
import { connect, headers, type JetStreamClient, type NatsConnection } from 'nats'
import type { RelayConfig } from './builder-config'
import { CONTENT_TYPE, type RelayBus } from './builder-relay'

/** Reply subjects of studio. nats.conf lets the studio user subscribe to this prefix only. */
export const INBOX_PREFIX = '_INBOX_studio'

const PUBLISH_TIMEOUT_MS = 5_000

export class NatsBus implements RelayBus {
  private constructor(
    private readonly nc: NatsConnection,
    private readonly js: JetStreamClient
  ) {}

  /** Connects (reconnects forever after the first connect). Makes no JetStream API call. */
  static async open(config: RelayConfig): Promise<NatsBus> {
    const nc = await connect({
      servers: config.natsUrl,
      user: config.user,
      pass: config.password,
      name: 'synthwerk-studio',
      inboxPrefix: INBOX_PREFIX,
      maxReconnectAttempts: -1
    })
    return new NatsBus(nc, nc.jetstream())
  }

  async publish(subject: string, payload: string, msgId: string) {
    const h = headers()
    h.set('Content-Type', CONTENT_TYPE)
    const ack = await this.js.publish(subject, new TextEncoder().encode(payload), {
      msgID: msgId,
      headers: h,
      timeout: PUBLISH_TIMEOUT_MS
    })
    return { duplicate: ack.duplicate }
  }

  close(): Promise<void> {
    return this.nc.drain()
  }
}
