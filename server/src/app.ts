import Fastify from 'fastify'
import { ZodError } from 'zod'
import { authenticate, HttpError } from './auth.ts'
import { pool } from './db.ts'
import { startListener, stopListener } from './events.ts'
import projects from './routes/projects.ts'
import issues from './routes/issues.ts'
import misc from './routes/misc.ts'
import files from './routes/files.ts'
import imports from './routes/import.ts'
import scim from './routes/scim.ts'

export async function build() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', bodyLimit: 20 * 1024 * 1024 })

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'Invalid input', issues: err.issues })
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message })
    if (err.code === '23505') return reply.code(409).send({ error: 'Already exists' })
    if (err.code === '23503') return reply.code(409).send({ error: 'Still referenced by other records' })
    if (err.code === '23514' || err.code === '22P02') return reply.code(400).send({ error: 'Invalid value' })
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message })
    app.log.error(err)
    return reply.code(500).send({ error: 'Internal error' })
  })

  app.get('/health', async () => ({ ok: true }))
  await app.register(scim, { prefix: '/scim/v2' })          // own bearer-token auth

  await app.register(async api => {
    api.addHook('preHandler', authenticate)
    await api.register(projects)
    await api.register(issues)
    await api.register(misc)
    await api.register(files)
    await api.register(imports)
  }, { prefix: '/api' })

  await startListener()
  app.addHook('onClose', async () => { await stopListener(); await pool.end() })
  return app
}
