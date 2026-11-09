// Passwords of internal directory users (spec 0714): salted scrypt hashes, never the password itself.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const N = 2 ** 15, R = 8, P = 1, LEN = 32
const derive = (password: string, salt: Buffer, n = N, r = R, p = P) => new Promise<Buffer>((ok, fail) =>
  scrypt(password, salt, LEN, { N: n, r, p, maxmem: 256 * n * r }, (e, key) => (e ? fail(e) : ok(key))))

/** `scrypt$N$r$p$salt$hash`: the parameters travel with the hash, so they can be raised later. */
export async function hashPassword(password: string) {
  const salt = randomBytes(16)
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${(await derive(password, salt)).toString('base64')}`
}

export async function verifyPassword(password: string, stored: string) {
  const [kind, n, r, p, salt, hash] = stored.split('$')
  if (kind !== 'scrypt' || !salt || !hash) return false
  const want = Buffer.from(hash, 'base64')
  const got = await derive(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p))
  return got.length === want.length && timingSafeEqual(got, want)
}

/** Spends the same time as a real check when there is no one to check against (no hint that a username exists). */
const DUMMY = hashPassword(randomBytes(16).toString('hex'))
export const wasteCheck = async (password: string) => { await verifyPassword(password, await DUMMY) }
