// UUIDv7 (RFC 9562): 48-bit Unix milliseconds, version 7, 74 random bits. The CloudEvents id of a
// Synthwerk event must be a lowercase UUIDv7 (synthwerk-contracts events/envelope.schema.json).
import { randomBytes } from 'node:crypto'

export const UUIDV7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** A new lowercase UUIDv7 for the time `ms` (default: now). */
export function uuidv7(ms: number = Date.now()): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > 0xffff_ffff_ffff)
    throw new RangeError('uuidv7: bad time')
  const b = randomBytes(16)
  b.writeUIntBE(ms, 0, 6)
  b[6] = ((b[6] as number) & 0x0f) | 0x70
  b[8] = ((b[8] as number) & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
