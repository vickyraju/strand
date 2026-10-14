// Checks a deployed API: node scripts/smoke.ts <base-url>
// Dev login needs SMOKE_EMAIL and SMOKE_SECRET (the Render DEV_AUTH_SECRET); read-only apart from the first
// sign-in, which creates your user (and the workspace, if you are the first user) like any login.
const base = (process.argv[2] ?? process.env.STRAND_API_URL)?.replace(/\/$/, '')
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
const dev = { 'x-dev-user': process.env.SMOKE_EMAIL ?? '', 'x-dev-secret': process.env.SMOKE_SECRET ?? process.env.DEV_AUTH_SECRET ?? '' }

await check('health', async () => JSON.stringify(await (await get('/health')).json()))
await check('docs spec', async () => `${Object.keys((await (await get('/docs/json')).json() as any).paths).length} paths`)
await check('no credentials is rejected', async () => {
  const r = await fetch(base + '/api/me')
  if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`)
  return '401'
})
await check('wrong secret is rejected', async () => {
  const r = await fetch(base + '/api/me', { headers: { 'x-dev-user': 'nobody@example.com', 'x-dev-secret': 'wrong' } })
  if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`)
  return '401'
})
if (dev['x-dev-user'] && dev['x-dev-secret']) {
  await check('login + database', async () => { const me = await (await get('/api/me', dev)).json() as any; return `${me.email} (${me.role})` })
  await check('projects query', async () => `${(await (await get('/api/projects', dev)).json() as any[]).length} projects`)
} else console.log('skip  login checks (set SMOKE_EMAIL and SMOKE_SECRET)')

process.exit(failed ? 1 : 0)
