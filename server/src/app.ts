import Fastify from 'fastify'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
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

  // Route schemas (zod) drive validation and the OpenAPI document
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  await app.register(swagger, {
    openapi: {
      info: { title: 'Strand API', version: '1.0.0', description: 'Work management: projects, issues, sprints, releases, automation.' },
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'Entra ID JWT' },
          devSecret: { type: 'apiKey', in: 'header', name: 'x-dev-secret', description: 'Dev login only (AUTH_DEV); pair with x-dev-user' },
          devUser: { type: 'apiKey', in: 'header', name: 'x-dev-user', description: 'Dev login only: your email' },
        },
      },
      security: [{ bearer: [] }, { devSecret: [], devUser: [] }],
    },
    transform: jsonSchemaTransform,
  })
  // Docs are opt-in so a production deploy does not publish its API surface by default
  if (process.env.DOCS_ENABLED === '1' || ['development', 'test'].includes(process.env.NODE_ENV ?? ''))
    await app.register(swaggerUi, { routePrefix: '/docs', uiConfig: { persistAuthorization: true } })

  app.setErrorHandler((err: any, _req, reply) => {
    if (err.validation) return reply.code(400).send({
      error: 'Invalid input', issues: err.validation.map((v: any) => ({ path: v.instancePath, message: v.message })),
    })
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
