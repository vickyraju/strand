import pg from 'pg'
import type { FastifyReply } from 'fastify'
import type { Db } from './db.ts'

// Realtime over Postgres LISTEN/NOTIFY → SSE.
// LISTEN needs a session that stays open, so it connects to DATABASE_DIRECT_URL: the Aurora writer's own endpoint, not RDS Proxy.
// ponytail: one LISTEN connection per API pod. Move to Redis pub/sub if fan-out or payload size outgrows NOTIFY.
const subs = new Map<string, Set<FastifyReply>>()   // projectId → open streams
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
    const { projectId } = JSON.parse(m.payload ?? '{}')
    for (const r of subs.get(projectId) ?? []) r.raw.write(`data: ${m.payload}\n\n`)
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
  for (const set of subs.values()) for (const r of set) r.raw.end()   // open streams would otherwise hold shutdown until the pod is killed
  await c?.end().catch(() => {})
}

export function publish(d: Db, projectId: string, event: Record<string, unknown>) {
  return d.query('select pg_notify($1, $2)', ['strand', JSON.stringify({ projectId, ...event })])
}

export function subscribe(projectId: string, reply: FastifyReply) {
  // reply.hijack() skips Fastify's own header handling, so carry over what plugins already set (the CORS headers)
  const inherited = Object.fromEntries(Object.entries(reply.getHeaders()).filter(([k]) => /^access-control-|^vary$/i.test(k)))
  reply.raw.writeHead(200, { ...inherited, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  reply.raw.write(': connected\n\n')
  const set = subs.get(projectId) ?? subs.set(projectId, new Set()).get(projectId)!
  set.add(reply)
  const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25000)
  reply.raw.on('close', () => { clearInterval(ping); set.delete(reply); if (!set.size) subs.delete(projectId) })
}
