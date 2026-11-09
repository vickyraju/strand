// A small LDAP client for user directories (spec 0712): connect, bind, and a paged search. Certificates are verified
// (a company CA is trusted through NODE_EXTRA_CA_CERTS). Tests and the browser journeys swap in a fake directory.
import { readFileSync } from 'node:fs'
import { Client } from 'ldapts'

/** One entry: its DN and attributes (binary ones, such as objectGUID, as Buffers). */
export interface Entry { dn: string; [attribute: string]: string | string[] | Buffer | Buffer[] }
export interface LdapServer { host: string; port: number; security: 'none' | 'ldaps' | 'starttls'; connectTimeoutMs: number; timeoutMs: number }
export interface Ldap {
  /** Throws when the directory refuses. Never call it with an empty password: that is an anonymous bind, which succeeds. */
  bind(dn: string, password: string): Promise<void>
  /** Everything under `base` (subtree) that matches, a page at a time. */
  search(base: string, filter: string, attributes: string[], pageSize: number): AsyncIterable<Entry[]>
  close(): Promise<void>
}
export type Connect = (s: LdapServer) => Promise<Ldap>

/** An attribute's values as text, its name matched ignoring case (binary values, such as objectGUID, as hex). */
export function attr(e: Entry, name: string): string[] {
  const k = Object.keys(e).find(k => k.toLowerCase() === name.toLowerCase())
  const v = k ? e[k] : undefined
  return v === undefined ? [] : (Array.isArray(v) ? v : [v]).map(x => (Buffer.isBuffer(x) ? x.toString('hex') : String(x)))
}

const realConnect: Connect = async s => {
  const tls = { minVersion: 'TLSv1.2' as const, servername: s.host }
  const client = new Client({ url: `${s.security === 'ldaps' ? 'ldaps' : 'ldap'}://${s.host}:${s.port}`, timeout: s.timeoutMs, connectTimeout: s.connectTimeoutMs, tlsOptions: tls })
  if (s.security === 'starttls') await client.startTLS(tls)
  return {
    bind: (dn, password) => client.bind(dn, password),
    async *search(base, filter, attributes, pageSize) {
      for await (const page of client.searchPaginated(base, { scope: 'sub', filter, attributes, explicitBufferAttributes: ['objectGUID'], paged: { pageSize } }))
        yield page.searchEntries as Entry[]
    },
    close: () => client.unbind().catch(() => {}),
  }
}

let current: Connect = realConnect
export const connect: Connect = async s => {
  // the browser journeys' API runs with STRAND_LDAP_FAKE=<a JSON file of a fake directory> (NODE_ENV=test only)
  if (current === realConnect && process.env.STRAND_LDAP_FAKE && process.env.NODE_ENV === 'test')
    current = (await import('./fakeLdap.ts')).fakeConnect(JSON.parse(readFileSync(process.env.STRAND_LDAP_FAKE, 'utf8')))
  return current(s)
}

/** Tests only: talk to a fake directory instead. */
export function useLdap(c: Connect) {
  if (process.env.NODE_ENV !== 'test') throw new Error('A fake directory is for tests only')
  current = c
}
