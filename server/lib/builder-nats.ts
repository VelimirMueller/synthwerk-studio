// The NATS JetStream side of the builder relay (synthwerk#106), with the official `nats` client.
// Studio owns the stream EVT_STUDIO: it creates it, or updates it to this config, at start.
// No message here holds the URL, the user or the password.
import {
  connect,
  headers,
  type JetStreamClient,
  type NatsConnection,
  nanos,
  RetentionPolicy,
  StorageType
} from 'nats'
import type { RelayConfig } from './builder-config'
import { CONTENT_TYPE, type RelayBus, STREAM_NAME, STREAM_SUBJECTS } from './builder-relay'

/** Stream config of EVT_STUDIO: same limits as EVT_IDENTITY (30 days, 2 min duplicate window). */
export const STREAM_CONFIG = {
  description: 'Facts of synthwerk-studio (CloudEvents, ids only, no page content).',
  subjects: STREAM_SUBJECTS,
  retention: RetentionPolicy.Limits,
  storage: StorageType.File,
  max_age: nanos(30 * 24 * 60 * 60 * 1000),
  duplicate_window: nanos(2 * 60 * 1000)
}

const PUBLISH_TIMEOUT_MS = 5_000

export class NatsBus implements RelayBus {
  private constructor(
    private readonly nc: NatsConnection,
    private readonly js: JetStreamClient
  ) {}

  /** Connects (reconnects forever after the first connect) and makes sure EVT_STUDIO exists. */
  static async open(config: RelayConfig): Promise<NatsBus> {
    const nc = await connect({
      servers: config.natsUrl,
      user: config.user,
      pass: config.password,
      name: 'synthwerk-studio',
      maxReconnectAttempts: -1
    })
    try {
      // checkAPI false: the studio NATS user may only reach the EVT_STUDIO APIs.
      const jsm = await nc.jetstreamManager({ checkAPI: false })
      try {
        await jsm.streams.info(STREAM_NAME)
        await jsm.streams.update(STREAM_NAME, STREAM_CONFIG)
      } catch (err) {
        if (!isStreamNotFound(err)) throw err
        await jsm.streams.add({ name: STREAM_NAME, ...STREAM_CONFIG })
      }
      return new NatsBus(nc, nc.jetstream())
    } catch (err) {
      await nc.close().catch(() => {})
      throw err
    }
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

export function isStreamNotFound(err: unknown): boolean {
  const api = (err as { api_error?: { err_code?: unknown } } | null)?.api_error
  return api?.err_code === 10059 || (err instanceof Error && /stream not found/i.test(err.message))
}
