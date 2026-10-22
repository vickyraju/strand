import Fastify, { type FastifyPluginAsync } from 'fastify'
import cors from '@fastify/cors'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { authenticate } from './auth.ts'
import { pool } from './db.ts'
import { startListener, stopListener } from './events.ts'
import { errorSchema, toErrorBody } from './errors.ts'
import { CREATED, RESPONSES } from './responses.ts'
import projects from './routes/projects.ts'
import issues from './routes/issues.ts'
import misc from './routes/misc.ts'
import files from './routes/files.ts'
import imports from './routes/import.ts'
import scim from './routes/scim.ts'
import development from './routes/development.ts'
import tokens from './routes/tokens.ts'
import { githubWebhook } from './routes/github.ts'

export async function build() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', bodyLimit: 20 * 1024 * 1024, trustProxy: true })   // behind the ALB: real client IP in logs

  // Browsers may call the API only from listed origins (comma-separated CORS_ORIGINS). Unset = no cross-origin access,
  // which is what you want when CloudFront serves the web app and /api from one domain.
  const origins = (process.env.CORS_ORIGINS ?? '').split(',').map(o => o.trim().replace(/\/$/, '')).filter(Boolean)
  await app.register(cors, {
    origin: origins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    // every custom header the web app sends must be listed, or the browser blocks the request (x-workflow-override: moving work off a deleted status)
    allowedHeaders: ['content-type', 'authorization', 'if-match', 'x-workflow-override'],
    maxAge: 600,
  })

  // Attach each route's response schema as it registers. Must come before the swagger plugin so the document sees them.
  app.addHook('onRoute', route => {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    const path = route.url.replace(/^\/api\/v1(?=\/)/, '')
    for (const m of methods) {
      const response = RESPONSES[`${m} ${path}`]
      if (!response) continue
      const code = m === 'POST' && CREATED.has(`${m} ${path}`) ? 201 : 200
      route.schema = { ...(route.schema ?? {}), response: { [code]: response, ...((route.schema as any)?.response ?? {}) } } as typeof route.schema
      if (code === 201) {          // answer 201 Created; set before the handler runs, so the 201 schema is the one used to serialize
        const pre = route.preHandler ? (Array.isArray(route.preHandler) ? route.preHandler : [route.preHandler]) : []
        route.preHandler = [...pre, async (_req: any, reply: any) => { reply.code(201) }] as typeof route.preHandler
      }
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
          bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'Entra ID JWT or personal access token (jbp_…)', description: 'Scripts and integrations: a personal access token created under Settings > Personal access tokens. The web app uses the signed-in user\'s Entra ID access token.' },
          scimToken: { type: 'http', scheme: 'bearer', description: 'Shared SCIM_TOKEN (Entra provisioning only)' },
        },
      },
      security: [{ bearer: [] }],
    },
    transform: ({ schema, url, ...rest }: any) => {
      const out: any = jsonSchemaTransform({ schema, url, ...rest })
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
  if (process.env.DOCS_ENABLED === '1')
    await app.register(swaggerUi, { routePrefix: '/docs', uiConfig: { persistAuthorization: true } })

  app.setErrorHandler((err: any, _req, reply) => {
    const { status, body } = toErrorBody(err)
    if (status >= 500) app.log.error(err)
    return reply.code(status).send(body)
  })
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Route not found', code: 'not_found' }))

  app.addHook('onSend', async (_req, reply) => { reply.header('x-content-type-options', 'nosniff') })
  app.get('/health', async () => ({ ok: true }))                                    // liveness: the process is up
  app.get('/ready', async (_req, reply) => {                                         // readiness: the database answers
    try { await pool.query('select 1'); return { ok: true } } catch { return reply.code(503).send({ ok: false }) }
  })
  await app.register(scim, { prefix: '/scim/v2' })          // own bearer-token auth
  await app.register(githubWebhook, { prefix: '/integrations/github/webhook' })   // GitHub signs each call; no user login

  const resources: FastifyPluginAsync = async api => {
    api.addHook('preHandler', authenticate)
    await api.register(projects)
    await api.register(issues)
    await api.register(misc)
    await api.register(files)
    await api.register(development)
    await api.register(tokens)
    await api.register(imports)
  }
  await app.register(resources, { prefix: '/api/v1' })

  await startListener()
  app.addHook('onClose', async () => { await stopListener(); await pool.end() })
  return app
}
