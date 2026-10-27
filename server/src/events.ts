import pg from 'pg'
import type { FastifyReply } from 'fastify'
import type { Db } from './db.ts'

// Realtime over Postgres LISTEN/NOTIFY → SSE.
// LISTEN needs a session that stays open, so it connects to DATABASE_DIRECT_URL: the Aurora writer's own endpoint, not RDS Proxy.
// ponytail: one LISTEN connection per API pod. Move to Redis pub/sub if fan-out or payload size outgrows NOTIFY.
interface Sub { reply: FastifyReply; userId: string }
const subs = new Map<string, Set<Sub>>()   // projectId → open streams

/** A stream lives this long, then the client reconnects and is authenticated and authorized again
 *  (an expired or revoked token cannot keep a stream open). */
export const STREAM_MAX_MS = 10 * 60_000
let listener: pg.Client | null = null
let stopping = false

export function startListener() { stopping = false; return connect() }

async function connect() {
  const url = process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL
  if (!url || listener || stopping) return
  const c = listener = new pg.Client({ connectionString: url })
  const retry = () => { if (listener === c) listener = null; if (!stopping) setTimeout(() => void connect(), 2000).unref() }
  c.on('error', retry)
  c.on('notification', m => {
    const ev = JSON.parse(m.payload ?? '{}')
    if (ev.type === 'access.revoked') return revoke(ev.projectId, ev.userId)
    for (const s of subs.get(ev.projectId) ?? []) s.reply.raw.write(`data: ${m.payload}\n\n`)
  })
  try {
    await c.connect()
    await c.query('listen strand')
  } catch { c.end().catch(() => {}); retry() }   // the API keeps serving; live updates resume when the database is back
}

export async function stopListener() {
  stopping = true
  const c = listener
  listener = null
  for (const set of subs.values()) for (const s of set) s.reply.raw.end()   // open streams would otherwise hold shutdown until the pod is killed
  await c?.end().catch(() => {})
}

export function publish(d: Db, projectId: string, event: Record<string, unknown>) {
  return d.query('select pg_notify($1, $2)', ['strand', JSON.stringify({ projectId, ...event })])
}

/** Close the streams someone lost access to: one person in one project, everyone in a project, or one person everywhere. */
function revoke(projectId?: string, userId?: string) {
  for (const [pid, set] of subs) {
    if (projectId && pid !== projectId) continue
    for (const s of set) if (!userId || s.userId === userId) s.reply.raw.end()
  }
}

export function subscribe(projectId: string, reply: FastifyReply, userId: string) {
  // reply.hijack() skips Fastify's own header handling, so carry over what plugins already set (the CORS headers)
  const inherited = Object.fromEntries(Object.entries(reply.getHeaders()).filter(([k]) => /^access-control-|^vary$/i.test(k)))
  reply.raw.writeHead(200, { ...inherited, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  reply.raw.write(': connected\n\n')
  const set = subs.get(projectId) ?? subs.set(projectId, new Set()).get(projectId)!
  const sub = { reply, userId }
  set.add(sub)
  const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25000)
  const expire = setTimeout(() => reply.raw.end(), STREAM_MAX_MS)
  reply.raw.on('close', () => { clearInterval(ping); clearTimeout(expire); set.delete(sub); if (!set.size) subs.delete(projectId) })
}
