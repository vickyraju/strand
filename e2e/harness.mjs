// End-to-end harness: the real web app and API in a real browser, on a throwaway database.
//   E2E_DATABASE_URL=postgres://…/scratch npm run e2e       (skipped when it is not set: the database is wiped)
// Sign-in needs no Microsoft account: a local server publishes a signing key, the API is pointed at it (ENTRA_AUTHORITY),
// and each person's browser starts with a token signed by that key, exactly as Entra would issue it.
// The browser is the installed Google Chrome (CHROME_PATH to use another Chromium); nothing is downloaded.
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto'
import { createRequire } from 'node:module'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = new URL('..', import.meta.url).pathname
export const dbUrl = process.env.E2E_DATABASE_URL
/** The server's mail folder (spec 0607): journeys drop message files here */
export const mailDir = mkdtempSync(`${tmpdir()}/strand-e2e-mail-`)
export const skip = !dbUrl && 'E2E_DATABASE_URL not set (it is wiped, so it must be a scratch database)'
const TENANT = '11111111-1111-4111-8111-111111111111', CLIENT = '22222222-2222-4222-8222-222222222222'
/** recovery_admin's password (spec 0711 recovery mode is on for every run). */
export const RECOVERY_PASSWORD = 'e2e-recovery-password-0711'

const children = []
let jwksServer, authority, apiUrl, webUrl, browser
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'e2e', alg: 'RS256', use: 'sig' }

const freePort = () => new Promise(res => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const until = async (what, check, ms = 60_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await check().catch(() => false)) return; await new Promise(r => setTimeout(r, 250)) }
  throw new Error(`Timed out waiting for ${what}`)
}

/** People in the tests: email → display name. The first one to sign in owns the workspace. */
export const PEOPLE = {
  'owner@e2e.test': 'Olive Owner', 'maya@e2e.test': 'Maya Member', 'vic@e2e.test': 'Vic Viewer', 'sam@e2e.test': 'Sam Someone',
}
const uuidOf = s => { const h = createHash('sha1').update(s).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}` }
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')

/** An access token for `email`, signed like Entra would sign it. */
export function tokenFor(email, roles = []) {
  const now = Math.floor(Date.now() / 1000)
  const head = b64({ alg: 'RS256', kid: 'e2e', typ: 'JWT' })
  const body = b64({ oid: uuidOf(email), preferred_username: email, name: PEOPLE[email] ?? email, roles, iss: `${authority}/${TENANT}/v2.0`, aud: CLIENT, tid: TENANT, iat: now, nbf: now, exp: now + 3600 })
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`
}

/** Call the API as `email`: as(email)('POST', '/projects', {…}) → { status, body }. */
export const as = email => async (method, path, body) => {
  const res = await fetch(`${apiUrl}/api/v1${path}`, {
    method, headers: { authorization: `Bearer ${tokenFor(email)}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) }
}

/** A GitHub webhook delivery, signed with the secret the API was started with (spec 0707). */
const GITHUB_SECRET = 'e2e-github-secret-0707'
let deliveries = 0
export const github = async (event, payload) => {
  const raw = JSON.stringify(payload)
  const res = await fetch(`${apiUrl}/integrations/github/webhook`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-github-event': event,
    'x-github-delivery': `e2e-${++deliveries}`, 'x-hub-signature-256': 'sha256=' + createHmac('sha256', GITHUB_SECRET).update(raw).digest('hex') } })
  return { status: res.status, body: await res.json().catch(() => null) }
}

/** POST a raw body to any address of the API (Xray's /rest/raven/1.0/… for CI results), with a bearer token. */
export const postRaw = async (path, body, contentType, token) => {
  const res = await fetch(`${apiUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': contentType }, body })
  return { status: res.status, body: await res.json().catch(() => null) }
}

export async function start() {
  if (skip) return
  // a clean database with every migration
  const pg = createRequire(new URL('../server/package.json', import.meta.url))('pg')
  const c = new pg.Client({ connectionString: dbUrl }); await c.connect()
  try { await c.query('drop schema public cascade; create schema public') } finally { await c.end() }   // an open connection would keep the run from ending
  execFileSync('node', ['scripts/migrate.ts'], { cwd: `${root}server`, env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'ignore' })

  // Entra's discovery document and its keys (the API's Authentication methods check both before Entra is turned on)
  jwksServer = createServer((q, r) => {
    r.setHeader('content-type', 'application/json')
    r.end(JSON.stringify(q.url.endsWith('/.well-known/openid-configuration') ? { issuer: `${authority}/${TENANT}/v2.0`, jwks_uri: `${authority}/keys` } : { keys: [jwk] }))
  })
  await new Promise(r => jwksServer.listen(0, '127.0.0.1', r))
  authority = `http://127.0.0.1:${jwksServer.address().port}`
  const [apiPort, webPort] = [await freePort(), await freePort()]
  apiUrl = `http://127.0.0.1:${apiPort}`; webUrl = `http://localhost:${webPort}`

  const run = (args, cwd, env) => {
    const p = spawn('node', args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''; p.stderr.on('data', d => { err = (err + d).slice(-4000) })
    p.on('exit', code => { if (code && !p.stopping) console.error(`${args.join(' ')} exited ${code}\n${err}`) })
    children.push(p)
  }
  run(['src/index.ts'], `${root}server`, {
    DATABASE_URL: dbUrl, PORT: String(apiPort), NODE_ENV: 'test', ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_WEB_CLIENT_ID: CLIENT, ENTRA_AUTHORITY: authority,
    STRAND_RECOVERY_PASSWORD: RECOVERY_PASSWORD, STRAND_SECRET_KEY: 'e2e-secret-key-for-stored-passwords-0712',
    STRAND_LDAP_FAKE: `${root}e2e/fake-directory.json`,   // a company directory in memory (spec 0712)
    STRAND_WEBHOOK_HTTP_HOSTS: '127.0.0.1', STRAND_WEBHOOK_PRIVATE_HOSTS: '127.0.0.1',   // the journeys' webhook receiver (spec 0705)
    GITHUB_WEBHOOK_SECRET: GITHUB_SECRET,   // the journeys' GitHub deliveries (spec 0707)
    EMAIL_TRANSPORT: 'log', STRAND_MAIL_DIR: mailDir,   // emails go to the server's log; journeys read the jobs that sent them
    CORS_ORIGINS: webUrl, JOBS_POLL_MS: '500', DUE_SCAN_INTERVAL_MS: '0', FILE_SWEEP_MS: '0', S3_BUCKET: '',
  })
  run(['node_modules/vite/bin/vite.js', '--port', String(webPort), '--strictPort', '--host', 'localhost'], root, {
    VITE_API_URL: apiUrl, VITE_API_PREFIX: '/api/v1',
  })
  await until('the API', async () => (await fetch(`${apiUrl}/ready`)).ok)
  await until('the web app', async () => (await fetch(webUrl)).ok)
  browser = process.env.CHROME_PATH
    ? await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
    : await chromium.launch({ channel: 'chrome', headless: true })
  // everyone signs in once, owner first (the first person on an empty system owns the workspace)
  for (const email of Object.keys(PEOPLE)) await as(email)('GET', '/me')
}

export async function stop() {
  await browser?.close().catch(() => {})
  for (const p of children) { p.stopping = true; p.kill('SIGTERM') }
  jwksServer?.close()
}

/** A browser tab signed in as `email`, showing the app. Collects page errors in `page.problems`. */
export async function signIn(email, roles = []) {
  const page = await signedOut('/', [tokenFor(email, roles)])
  await page.waitForSelector('nav')
  return page
}

/** A browser tab at `path` that nobody has signed in to (or, given a token, that starts with it, as signIn does). */
export async function signedOut(path, [token] = []) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true })
  if (token) await ctx.addInitScript(([t]) => {
    sessionStorage.setItem('jira-build:session', JSON.stringify({ access: t, expiresAt: Date.now() + 3_600_000 }))
  }, [token])
  const page = await ctx.newPage()
  page.problems = []
  page.on('pageerror', e => page.problems.push(e.message))
  page.on('console', m => { if (m.type() === 'error' && !/status of 40[1349]/.test(m.text())) page.problems.push(m.text().slice(0, 200)) })
  await page.goto(webUrl + path)
  return page
}

export const url = path => `${webUrl}${path}`
