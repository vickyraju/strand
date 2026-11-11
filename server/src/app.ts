import Fastify, { type FastifyPluginAsync, type FastifyReply, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { authenticate } from './auth.ts'
import { ANONYMOUS, fromWebApp, noteLimited, policyFor, rateLimiter, tooMany, type RateSettings } from './rateLimit.ts'
import { getSetting } from './settings.ts'
import { pool, db } from './db.ts'
import { startListener, stopListener } from './events.ts'
import { startJobWorker } from './jobs.ts'
import { schedulePurge } from './deletedItems.ts'
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
import workflowRoutes from './routes/workflows.ts'
import boardRoutes from './routes/boards.ts'
import listRoutes from './routes/lists.ts'
import authentication, { ownPassword, publicAuth } from './routes/authentication.ts'
import directories from './routes/directories.ts'
import lookAndFeel, { publicLook } from './routes/lookAndFeel.ts'
import projectExtras, { publicAvatars } from './routes/projectExtras.ts'
import webhookRoutes, { jiraRest as jiraWebhooks } from './routes/webhooks.ts'
import automationRoutes from './routes/automation.ts'
import moveRoutes from './routes/move.ts'
import customFieldRoutes from './routes/customFields.ts'
import fieldConfigRoutes from './routes/fieldConfigs.ts'
import screenRoutes from './routes/screens.ts'
import remoteLinkRoutes, { jiraRemoteLinks } from './routes/remoteLinks.ts'
import subscriptionRoutes, { startSubscriptions } from './routes/subscriptions.ts'
import notificationSchemeRoutes from './routes/notificationSchemes.ts'
import incomingMailRoutes from './routes/incomingMail.ts'
import { startMailHandlers } from './mail.ts'
import { startDirectories } from './directories.ts'
import { startAuth } from './authConfig.ts'
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
  // Rate limiting (System settings, spec 0706): every request but the web app's, per person; without a sign-in, as Anonymous
  const limiter = rateLimiter()
  app.addHook('onClose', async () => limiter.stop())
  const limit = async (ws: string, who: string, req: FastifyRequest, reply: FastifyReply) => {
    const p = policyFor(await getSetting(ws, 'rateLimiting') as RateSettings, who)
    if (!p) return
    const v = limiter.take(who, p)
    reply.headers(v.headers)
    if (!v.allowed) { await noteLimited(ws, who); throw tooMany(p) }
  }
  await app.register(async pub => {
    pub.addHook('preHandler', async (req, reply) => {
      if (fromWebApp(req.headers, origins)) return
      const [w] = await db.query<{ id: string }>('select id from workspaces order by created_at limit 1')
      if (w) await limit(w.id, ANONYMOUS, req, reply)
    })
    // signing in itself (spec 0711): the login page's configuration, the login form, signing out; no sign-in needed
    await pub.register(publicAuth, { prefix: '/api/v1' })
    await pub.register(publicAuth, { prefix: '/api' })   // the hidden alias, as for the rest of the API
    await pub.register(publicLook, { prefix: '/api/v1' })    // look and feel (spec 0702): the login page draws with it
    await pub.register(publicLook, { prefix: '/api' })
    await pub.register(publicAvatars, { prefix: '/api/v1' })  // project avatars (spec 0703): an <img> sends no sign-in
    await pub.register(publicAvatars, { prefix: '/api' })
  })
  await app.register(githubWebhook, { prefix: '/integrations/github/webhook' })   // GitHub signs each call; no user login

  const resources: FastifyPluginAsync = async api => {
    api.addHook('preHandler', authenticate)
    // after sign-in, so the count belongs to someone: access tokens always, other sign-ins unless from the web app (spec 0706)
    api.addHook('preHandler', async (req, reply) => {
      if (req.me.via !== 'pat' && fromWebApp(req.headers, origins)) return
      await limit(req.me.workspaceId, req.me.id, req, reply)
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
      await v1.register(workflowRoutes)
      await v1.register(boardRoutes)
      await v1.register(listRoutes)
      await v1.register(authentication)
      await v1.register(ownPassword)
      await v1.register(directories)
      await v1.register(lookAndFeel)
      await v1.register(projectExtras)
      await v1.register(webhookRoutes)
      await v1.register(automationRoutes)
      await v1.register(moveRoutes)
      await v1.register(customFieldRoutes)
      await v1.register(fieldConfigRoutes)
      await v1.register(screenRoutes)
      await v1.register(remoteLinkRoutes)
      await v1.register(subscriptionRoutes)
      await v1.register(notificationSchemeRoutes)
      await v1.register(incomingMailRoutes)
    }
    await api.register(routes, { prefix: '/api/v1' })
    // ponytail: the unversioned /api is kept as a hidden alias so clients built before /api/v1 keep working;
    // remove it once the web app calls /api/v1 everywhere (see API_PREFIX in src/api/client.ts).
    await api.register(routes, { prefix: '/api' })   // hidden from the docs in the swagger transform below
    // Xray's addresses for importing CI results: same sign-in and rate limits as the API
    await api.register(raven, { prefix: '/rest/raven/1.0' })
    await api.register(jiraWebhooks, { prefix: '/rest/webhooks/1.0' })   // Jira's webhook REST (spec 0715 R7)
    await api.register(jiraRemoteLinks, { prefix: '/rest/api/2' })   // Jira's remote issue links (spec 0507 R2)
  }
  await app.register(resources)

  await startListener()
  const stopJobs = startJobWorker(app.log)
  // Entra from ENTRA_* the first time (an upgrade signs in as before); recovery_admin only while recovery mode is on
  if (process.env.DATABASE_URL) await startAuth(app.log)
  // every enabled user directory has its next synchronisation queued (spec 0712)
  if (process.env.DATABASE_URL) await startDirectories().catch(e => app.log.error(e))
  // every workspace removes its long-deleted work items daily (spec 0202)
  if (process.env.DATABASE_URL)
    for (const w of (await pool.query<{ id: string }>('select id from workspaces')).rows) await schedulePurge(db, w.id).catch(e => app.log.error(e))
  // every filter subscription has its next run queued (spec 0604)
  if (process.env.DATABASE_URL) await startSubscriptions().catch(e => app.log.error(e))
  // every enabled mail handler has its next run queued (spec 0607)
  if (process.env.DATABASE_URL) await startMailHandlers().catch(e => app.log.error(e))
  app.addHook('onClose', async () => stopJobs())
  app.addHook('onClose', async () => { await stopListener(); await pool.end() })
  return app
}
