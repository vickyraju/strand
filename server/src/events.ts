import pg from 'pg'
import type { FastifyReply } from 'fastify'
import type { Db } from './db.ts'

// Realtime over Postgres LISTEN/NOTIFY → SSE. Works on Supabase and Aurora alike;
// ponytail: one LISTEN connection per API pod. Move to Redis pub/sub if fan-out or payload size outgrows NOTIFY.
const subs = new Map<string, Set<FastifyReply>>()   // projectId → open streams
let started = false
let listener: pg.Client | null = null

export async function startListener() {
  if (started || !process.env.DATABASE_URL) return
  started = true
  const c = listener = new pg.Client({ connectionString: process.env.DATABASE_URL })
  c.on('error', () => { started = false; if (listener) setTimeout(startListener, 2000).unref() })
  c.on('notification', m => {
    const { projectId } = JSON.parse(m.payload ?? '{}')
    for (const r of subs.get(projectId) ?? []) r.raw.write(`data: ${m.payload}\n\n`)
  })
  await c.connect()
  await c.query('listen strand')
}

export async function stopListener() {
  const c = listener
  listener = null; started = false
  await c?.end().catch(() => {})
}

export function publish(d: Db, projectId: string, event: Record<string, unknown>) {
  return d.query('select pg_notify($1, $2)', ['strand', JSON.stringify({ projectId, ...event })])
}

export function subscribe(projectId: string, reply: FastifyReply) {
  reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  reply.raw.write(': connected\n\n')
  const set = subs.get(projectId) ?? subs.set(projectId, new Set()).get(projectId)!
  set.add(reply)
  const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25000)
  reply.raw.on('close', () => { clearInterval(ping); set.delete(reply); if (!set.size) subs.delete(projectId) })
}
