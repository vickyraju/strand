import Fastify, { type FastifyPluginAsync } from 'fastify'
import cors from '@fastify/cors'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { authenticate } from './auth.ts'
import { pool } from './db.ts'
import { startListener, stopListener } from './events.ts'
import { errorSchema, toErrorBody } from './errors.ts'
import { RESPONSES } from './responses.ts'
import projects from './routes/projects.ts'
import issues from './routes/issues.ts'
import misc from './routes/misc.ts'
import files from './routes/files.ts'
import imports from './routes/import.ts'
import scim from './routes/scim.ts'

export async function build() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', bodyLimit: 20 * 1024 * 1024 })

  // Browsers may call the API only from listed origins (comma-separated CORS_ORIGINS). Unset = no cross-origin access.
  const origins = (process.env.CORS_ORIGINS ?? '').split(',').map(o => o.trim().replace(/\/$/, '')).filter(Boolean)
  await app.register(cors, {
    origin: origins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'authorization', 'if-match', 'x-dev-user', 'x-dev-secret'],
    maxAge: 600,
  })

  // Attach each route's response schema as it registers. Must come before the swagger plugin so the document sees them.
  app.addHook('onRoute', route => {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    const path = route.url.replace(/^\/api(\/v1)?(?=\/)/, '')
    for (const m of methods) {
      const response = RESPONSES[`${m} ${path}`]
      if (!response) continue
      route.schema = { ...(route.schema ?? {}), response: { 200: response, ...((route.schema as any)?.response ?? {}) } } as typeof route.schema
    }
  })

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
          scimToken: { type: 'http', scheme: 'bearer', description: 'Shared SCIM_TOKEN (Entra provisioning only)' },
          devUser: { type: 'apiKey', in: 'header', name: 'x-dev-user', description: 'Dev login only: your email' },
        },
      },
      security: [{ bearer: [] }, { devSecret: [], devUser: [] }],
    },
    transform: ({ schema, url, ...rest }: any) => {
      const out: any = jsonSchemaTransform({ schema, url, ...rest })
      if (typeof url === 'string' && /^\/api\/(?!v1\/)/.test(url)) return { ...out, schema: { ...out.schema, hide: true } }   // legacy alias
      const isApi = typeof url === 'string' && url.startsWith('/api/v1')
      if (!isApi || !out.schema) return out
      // every /api/v1 operation can answer 401 (and 400 when it has input); say so, with the shared error shape
      const err = (description: string) => ({ description, ...errorSchema })
      const response = { ...(out.schema.response ?? {}) }
      response[401] ??= err('Missing or invalid credentials')
      if (schema?.body || schema?.querystring || schema?.params) response[400] ??= err('Invalid input; `errors` maps each bad field to a message')
      return { ...out, schema: { ...out.schema, response } }
    },
  })
  // Docs are opt-in so a production deploy does not publish its API surface by default
  if (process.env.DOCS_ENABLED === '1' || ['development', 'test'].includes(process.env.NODE_ENV ?? ''))
    await app.register(swaggerUi, { routePrefix: '/docs', uiConfig: { persistAuthorization: true } })

  app.setErrorHandler((err: any, _req, reply) => {
    const { status, body } = toErrorBody(err)
    if (status >= 500) app.log.error(err)
    return reply.code(status).send(body)
  })
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Route not found', code: 'not_found' }))

  app.get('/health', async () => ({ ok: true }))
  await app.register(scim, { prefix: '/scim/v2' })          // own bearer-token auth

  const resources: FastifyPluginAsync = async api => {
    api.addHook('preHandler', authenticate)
    await api.register(projects)
    await api.register(issues)
    await api.register(misc)
    await api.register(files)
    await api.register(imports)
  }
  await app.register(resources, { prefix: '/api/v1' })
  // ponytail: the unversioned /api is kept as a hidden alias so clients built before /api/v1 keep working;
  // remove it once the web app calls /api/v1 everywhere (see API_PREFIX in src/api/client.ts).
  await app.register(resources, { prefix: '/api' })   // hidden from the docs in the swagger transform below

  await startListener()
  app.addHook('onClose', async () => { await stopListener(); await pool.end() })
  return app
}
