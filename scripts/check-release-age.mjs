// Security rule: only use dependency versions that were published at least 72 hours ago.
//   node scripts/check-release-age.mjs            checks package-lock.json and server/package-lock.json against the npm registry
//   node scripts/check-release-age.mjs --hours 96 a stricter limit
// Exits 1 and lists every package (direct or indirect) that is too new, with the newest older version to use instead.
// Needs network access to the registry. `.npmrc` (min-release-age=3) makes `npm install` follow the same rule; this check
// covers what the lockfiles already pin, which npm does not re-check.
import { readFileSync } from 'node:fs'

const hoursArg = process.argv.indexOf('--hours')
export const MIN_HOURS = hoursArg > 0 ? Number(process.argv[hoursArg + 1]) : 72
const LOCKS = ['package-lock.json', 'server/package-lock.json']

/** Package name from a lockfile key ("node_modules/a/node_modules/@s/b" → "@s/b"). */
export const nameOf = key => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)

/** Every registry package in a lockfile (links, workspaces and the root are not published versions). */
export function lockedPackages(lock) {
  return Object.entries(lock.packages ?? {}).filter(([key, p]) => key && !p.link && p.version && /^https?:\/\//.test(p.resolved ?? ''))
    .map(([key, p]) => ({ name: p.name ?? nameOf(key), version: p.version, dev: !!p.dev }))
}

/** Age in hours of a published version, or undefined when the registry has no time for it. */
export const ageHours = (time, version, now = Date.now()) => (time?.[version] ? (now - Date.parse(time[version])) / 3_600_000 : undefined)

/** The newest stable version that is old enough (and not older than `current`'s major, so a fix never jumps a major version). */
export function olderChoice(time, current, minHours, now = Date.now()) {
  const major = v => Number(v.split('.')[0])
  const parts = v => v.split(/[.-]/).map(x => Number(x) || 0)
  const newer = (a, b) => { const x = parts(a), y = parts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0 }
  return Object.keys(time ?? {})
    .filter(v => /^\d+\.\d+\.\d+$/.test(v) && major(v) === major(current) && newer(v, current) < 0 && (now - Date.parse(time[v])) / 3_600_000 >= minHours)
    .sort(newer).at(-1)
}

async function history(name, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, { headers: { accept: 'application/json' } })
    if (res.ok) return (await res.json()).time
    if (res.status === 404) return undefined
    await new Promise(r => setTimeout(r, 400 * (i + 1)))
  }
  throw new Error(`registry answered badly for ${name}`)
}

async function main() {
  const wanted = new Map()                                           // "name@version" → { name, version, where: Set }
  for (const file of LOCKS) {
    for (const p of lockedPackages(JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')))) {
      const k = `${p.name}@${p.version}`
      wanted.set(k, { ...p, where: new Set([...(wanted.get(k)?.where ?? []), file.startsWith('server') ? 'server' : 'web']) })
    }
  }
  const queue = [...wanted.values()], tooNew = [], unknown = []
  const times = new Map()
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      if (!times.has(p.name)) times.set(p.name, history(p.name))
      const time = await times.get(p.name)
      const age = ageHours(time, p.version)
      if (age === undefined) unknown.push(p)
      else if (age < MIN_HOURS) tooNew.push({ ...p, age, use: olderChoice(time, p.version, MIN_HOURS) })
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))

  console.log(`${wanted.size} locked versions checked against the ${MIN_HOURS}-hour rule`)
  for (const p of unknown) console.log(`  ? ${p.name}@${p.version} (${[...p.where]}): the registry has no publish time for it`)
  for (const p of tooNew.sort((a, b) => a.name.localeCompare(b.name)))
    console.log(`  ✖ ${p.name}@${p.version} (${[...p.where]}${p.dev ? ', dev' : ''}) is ${p.age.toFixed(1)} h old; newest old enough: ${p.use ?? 'none in this major'}`)
  if (tooNew.length || unknown.length) process.exit(1)
  console.log('All versions are old enough.')
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e.message); process.exit(2) })
