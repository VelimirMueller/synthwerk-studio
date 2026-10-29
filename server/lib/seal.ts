// Sealed cookie values: AES-256-GCM (encrypted and authenticated) with a key derived from the
// session secret by HKDF-SHA256. The login transaction travels in such a cookie, so /login
// writes nothing to the server store.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

const IV_BYTES = 12
const TAG_BYTES = 16

/** Derives a 256-bit key for one purpose. Different purposes give unrelated keys. */
export function deriveKey(secret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'synthwerk-studio', purpose, 32))
}

/** Seals a JSON value. `aad` binds the value to its use (for example the cookie name). */
export function seal(key: Buffer, value: unknown, aad: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad))
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url')
}

/** Opens a sealed value. Returns null for a tampered, truncated or foreign value. */
export function unseal(key: Buffer, sealed: string, aad: string): unknown {
  try {
    const raw = Buffer.from(sealed, 'base64url')
    if (raw.length < IV_BYTES + TAG_BYTES + 1) return null
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES))
    decipher.setAAD(Buffer.from(aad))
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES))
    const plain = Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)),
      decipher.final()
    ])
    return JSON.parse(plain.toString('utf8'))
  } catch {
    return null
  }
}
