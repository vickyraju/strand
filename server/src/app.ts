import Fastify, { type FastifyPluginAsync } from 'fastify'
import cors from '@fastify/cors'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { authenticate } from './auth.ts'
import { noteLimited, policyFor, rateLimiter, tooMany, type RateSettings } from './rateLimit.ts'
import { getSetting } from './settings.ts'
import { pool } from './db.ts'
import { startListener, stopListener } from './events.ts'
import { startJobWorker } from './jobs.ts'
import { errorSchema, toErrorBody } from './errors.ts'
import { CREATED, RESPONSES } from './responses.ts'
import projects from './routes/projects.ts'
import members from './routes/members.ts'
import issues from './routes/issues.ts'
import misc from './routes/misc.ts'
import files from './routes/files.ts'
import imports from './routes/import.ts'
import auditLog from './routes/auditLog.ts'
import admin from './routes/admin.ts'
import scim from './routes/scim.ts'
import development from './routes/development.ts'
import tokens from './routes/tokens.ts'
import testing from './routes/testing.ts'
import raven from './routes/raven.ts'
import groupsRoutes from './routes/groups.ts'
import { githubWebhook } from './routes/github.ts'

export async function build() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', bodyLimit: 20 * 1024 * 1024 })

  // Browsers may call the API only from listed origins (comma-separated CORS_ORIGINS). Unset = no cross-origin access.
  const origins = (process.env.CORS_ORIGINS ?? '').split(',').map(o => o.trim().replace(/\/$/, '')).filter(Boolean)
  await app.register(cors, {
    origin: origins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    // every custom header the web app sends must be listed, or the browser blocks the request (x-workflow-override: moving work off a deleted status)
    allowedHeaders: ['content-type', 'authorization', 'if-match', 'x-workflow-override', 'x-dev-user', 'x-dev-secret'],
    exposedHeaders: ['content-disposition', 'retry-after'],   // the export's file name; when to retry after 429
    maxAge: 600,
  })

  // Attach each route's response schema as it registers. Must come before the swagger plugin so the document sees them.
  app.addHook('onRoute', route => {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    const path = route.url.replace(/^\/api(\/v1)?(?=\/)/, '')
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
  await app.register(githubWebhook, { prefix: '/integrations/github/webhook' })   // GitHub signs each call; no user login

  const resources: FastifyPluginAsync = async api => {
    api.addHook('preHandler', authenticate)
    // Rate limiting (System settings): requests made with access tokens, per person, after sign-in so the count belongs to someone
    const limiter = rateLimiter()
    api.addHook('onClose', async () => limiter.stop())
    api.addHook('preHandler', async (req, reply) => {
      if (req.me.via !== 'pat') return
      const p = policyFor(await getSetting(req.me.workspaceId, 'rateLimiting') as RateSettings, req.me.id)
      if (!p) return
      const v = limiter.take(req.me.id, p)
      reply.headers(v.headers)
      if (!v.allowed) { await noteLimited(req.me.workspaceId, req.me.id); throw tooMany(p) }
    })
    const routes: FastifyPluginAsync = async v1 => {
      await v1.register(projects)
      await v1.register(members)
      await v1.register(issues)
      await v1.register(misc)
      await v1.register(files)
      await v1.register(development)
      await v1.register(tokens)
      await v1.register(imports)
      await v1.register(auditLog)
      await v1.register(admin)
      await v1.register(testing)
      await v1.register(groupsRoutes)
    }
    await api.register(routes, { prefix: '/api/v1' })
    // ponytail: the unversioned /api is kept as a hidden alias so clients built before /api/v1 keep working;
    // remove it once the web app calls /api/v1 everywhere (see API_PREFIX in src/api/client.ts).
    await api.register(routes, { prefix: '/api' })   // hidden from the docs in the swagger transform below
    // Xray's addresses for importing CI results: same sign-in and rate limits as the API
    await api.register(raven, { prefix: '/rest/raven/1.0' })
  }
  await app.register(resources)

  await startListener()
  const stopJobs = startJobWorker(app.log)
  app.addHook('onClose', async () => stopJobs())
  app.addHook('onClose', async () => { await stopListener(); await pool.end() })
  return app
}
