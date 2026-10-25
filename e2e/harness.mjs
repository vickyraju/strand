// End-to-end harness: the real web app and API in a real browser, on a throwaway database.
//   E2E_DATABASE_URL=postgres://…/scratch npm run e2e       (skipped when it is not set: the database is wiped)
// People sign in with the dev login (AUTH_DEV): each browser starts with the login already in its session.
// The browser is the installed Google Chrome (CHROME_PATH to use another Chromium); nothing is downloaded.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { chromium } from 'playwright-core'

const root = new URL('..', import.meta.url).pathname
export const dbUrl = process.env.E2E_DATABASE_URL
export const skip = !dbUrl && 'E2E_DATABASE_URL not set (it is wiped, so it must be a scratch database)'
const SECRET = 'e2e-dev-secret'

const children = []
let apiUrl, webUrl, browser

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

/** Call the API as `email`: as(email)('POST', '/projects', {…}) → { status, body }. */
export const as = email => async (method, path, body) => {
  const res = await fetch(`${apiUrl}/api/v1${path}`, {
    method, headers: { 'x-dev-user': email, 'x-dev-secret': SECRET, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) }
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
  try {
  await c.query('drop schema public cascade; create schema public')
  const dir = new URL('../supabase/migrations/', import.meta.url)
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await c.query(readFileSync(new URL(f, dir), 'utf8'))

  const [apiPort, webPort] = [await freePort(), await freePort()]
  apiUrl = `http://127.0.0.1:${apiPort}`; webUrl = `http://localhost:${webPort}`
  const run = (args, cwd, env) => {
    const p = spawn('node', args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''; p.stderr.on('data', d => { err = (err + d).slice(-4000) })
    p.on('exit', code => { if (code && !p.stopping) console.error(`${args.join(' ')} exited ${code}\n${err}`) })
    children.push(p)
  }
  run(['src/index.ts'], `${root}server`, {
    DATABASE_URL: dbUrl, PORT: String(apiPort), NODE_ENV: 'test', AUTH_DEV: '1', DEV_AUTH_SECRET: SECRET, ENTRA_TENANT_ID: '', ENTRA_CLIENT_ID: '',
    CORS_ORIGINS: webUrl, JOBS_POLL_MS: '500', DUE_SCAN_INTERVAL_MS: '0', FILE_SWEEP_MS: '0', S3_BUCKET: '',
  })
  run(['node_modules/vite/bin/vite.js', '--port', String(webPort), '--strictPort', '--host', 'localhost'], root, {
    VITE_API_URL: apiUrl, VITE_API_PREFIX: '/api/v1',
  })
  await until('the API', async () => (await fetch(`${apiUrl}/health`)).ok)
  await until('the web app', async () => (await fetch(webUrl)).ok)
  browser = process.env.CHROME_PATH
    ? await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
    : await chromium.launch({ channel: 'chrome', headless: true })
  // everyone signs in once, owner first (the first person on an empty system owns the workspace); then their real names
  for (const email of Object.keys(PEOPLE)) await as(email)('GET', '/me')
  for (const [email, name] of Object.entries(PEOPLE))
    await c.query('update users set name = $2, initials = $3 where email = $1', [email, name, name.split(' ').map(w => w[0]).join('')])
  } finally { await c.end() }   // an open connection would keep the test run from ending after a failure
}

export async function stop() {
  await browser?.close().catch(() => {})
  for (const p of children) { p.stopping = true; p.kill('SIGTERM') }
}

/** A browser tab signed in as `email`, showing the app. Collects page errors in `page.problems`. */
export async function signIn(email, roles = []) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true })
  await ctx.addInitScript(([login]) => { sessionStorage.setItem('strand:dev-login', JSON.stringify(login)) }, [{ email, secret: SECRET }])
  const page = await ctx.newPage()
  page.problems = []
  page.on('pageerror', e => page.problems.push(e.message))
  page.on('console', m => { if (m.type() === 'error' && !/status of 40[34]/.test(m.text())) page.problems.push(m.text().slice(0, 200)) })
  await page.goto(webUrl)
  await page.waitForSelector('nav')
  return page
}

export const url = path => `${webUrl}${path}`
