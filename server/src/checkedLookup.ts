import { lookup, type LookupAddress } from 'node:dns'

/** A `lookup` for http(s).request that checks every address a name resolves to, so the connection goes only where the
 *  check passed (a name can't point somewhere else between the check and the call). `refuse` returns why an address
 *  isn't allowed, or null. Answers in the shape Node asked for: one address, or all of them (`autoSelectFamily`). */
export const checkedLookup = (refuse: (address: string, name: string) => string | null) =>
  (name: string, opts: any, cb: (...a: any[]) => void) => lookup(name, { ...opts, all: true }, (err, addrs: LookupAddress[]) => {
    if (err) return cb(err)
    if (!addrs.length) return cb(new Error(`${name} has no address`))
    for (const a of addrs) { const why = refuse(a.address, name); if (why) return cb(new Error(why)) }
    return opts?.all ? cb(null, addrs) : cb(null, addrs[0]!.address, addrs[0]!.family)
  })
