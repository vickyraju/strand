// Checks a deployed API: node scripts/smoke.ts <base-url>
// Set SMOKE_TOKEN (an Entra access token for the API) to also check sign-in and the database through it.
// Read-only apart from the first sign-in, which creates the caller's user like any login.
const base = (process.argv[2] ?? process.env.API_URL)?.replace(/\/$/, '')
if (!base) { console.error('usage: node scripts/smoke.ts <base-url>'); process.exit(2) }

let failed = 0
const check = async (name: string, fn: () => Promise<string>) => {
  try { console.log(`ok    ${name}: ${await fn()}`) } catch (e: any) { failed++; console.log(`FAIL  ${name}: ${e.message}`) }
}
const get = async (path: string, headers: Record<string, string> = {}) => {
  const r = await fetch(base + path, { headers })
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`)
  return r
}
const auth = process.env.SMOKE_TOKEN ? { authorization: `Bearer ${process.env.SMOKE_TOKEN}` } : null

await check('health', async () => JSON.stringify(await (await get('/health')).json()))
await check('ready (database reachable)', async () => JSON.stringify(await (await get('/ready')).json()))
await check('no credentials is rejected', async () => {
  const r = await fetch(base + '/api/v1/me')
  if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`)
  return '401'
})
await check('a made-up token is rejected', async () => {
  const r = await fetch(base + '/api/v1/me', { headers: { authorization: 'Bearer not-a-token' } })
  if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`)
  return '401'
})
if (auth) {
  await check('sign-in + database', async () => { const me = await (await get('/api/v1/me', auth)).json() as any; return `${me.email} (${me.role})` })
  await check('projects query', async () => `${(await (await get('/api/v1/projects', auth)).json() as any[]).length} projects`)
} else console.log('skip  sign-in checks (set SMOKE_TOKEN)')

process.exit(failed ? 1 : 0)
