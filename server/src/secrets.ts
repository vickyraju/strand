// Secrets kept in the database (a user directory's bind password, spec 0712 R3): AES-256-GCM with a key from
// SECRET_KEY, bound to their row (its id is the additional data), so a value copied into another row doesn't open.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { HttpError } from './auth.ts'

const VERSION = 1
const key = () => {
  const k = process.env.SECRET_KEY ?? ''
  return k.length >= 32 ? createHash('sha256').update(k).digest() : null
}
/** Whether the server can store secrets at all (SECRET_KEY is set). */
export const canKeepSecrets = () => !!key()

export function seal(plain: string, rowId: string): Buffer {
  const k = key()
  if (!k) throw new HttpError(400, 'Set SECRET_KEY (32 characters or more) on the server to store passwords', { password: 'The server can’t store passwords yet' })
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', k, iv).setAAD(Buffer.from(rowId))
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), body])
}

/** The secret, or an error when the key changed or the value belongs to another row. */
export function unseal(sealed: Buffer, rowId: string): string {
  const k = key()
  if (!k || sealed[0] !== VERSION) throw new Error('The stored password can’t be read: was SECRET_KEY changed?')
  const d = createDecipheriv('aes-256-gcm', k, sealed.subarray(1, 13), { authTagLength: 16 }).setAAD(Buffer.from(rowId))
  d.setAuthTag(sealed.subarray(13, 29))
  try { return Buffer.concat([d.update(sealed.subarray(29)), d.final()]).toString('utf8') }
  catch { throw new Error('The stored password can’t be read: was SECRET_KEY changed?') }
}
