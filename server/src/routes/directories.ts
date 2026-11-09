// Administration › User directories (spec 0712): Active Directory and LDAP, Read Only, in order. System admins who signed
// in themselves (R13). The bind password is write-only: stored encrypted, never returned (R3).
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, tx } from '../db.ts'
import { HttpError } from '../auth.ts'
import { audit, changes } from '../audit.ts'
import { kickJobs } from '../jobs.ts'
import { seal } from '../secrets.ts'
import { bindPassword, directoryConfig, PRESETS, scheduleSync, syncNow, testDirectory, type Directory } from '../directories.ts'
import { requireNoToken } from './authentication.ts'

const T = ['User directories']
const id = z.object({ id: z.string().uuid() })
const type = z.enum(['ad', 'ldap'])
const password = z.string().min(1).max(1024)
/** Where the stored password may be sent: changing any of these needs it again, so it can't go to another server (R3). */
const WHERE = ['host', 'port', 'security', 'bindDn'] as const

const VIEW = `select d.id, d.name, d.type, d.position, d.enabled, d.config, d.password_enc is not null as has_password, d.last_sync, d.created_at, d.updated_at,
  (select jsonb_build_object('jobId', j.id, 'status', j.status, 'progress', j.progress) from jobs j
    where j.kind = 'directory.sync' and j.payload->>'directoryId' = d.id::text and (j.status = 'running' or (j.status = 'queued' and j.run_at <= now()))
    order by j.created_at desc limit 1) as syncing,
  (select count(*)::int from users u where u.directory_id = d.id and u.active) as users
  from user_directories d`

const directories: FastifyPluginAsyncZod = async app => {
  const one = async (dirId: string) => {
    const [d] = await db.query(`${VIEW} where d.id = $1`, [dirId])
    if (!d) throw new HttpError(404, 'User directory not found')
    return d
  }

  app.get('/admin/directories', { schema: { tags: T, summary: 'User directories, in the order sign-in tries them, with each one’s last synchronisation (system administrators)' } }, async req => {
    requireNoToken(req)
    return db.query(`${VIEW} order by d.position`)
  })

  app.get('/admin/directories/presets', { schema: { tags: T, summary: 'Jira’s defaults for an Active Directory or an LDAP directory' } }, async req => {
    requireNoToken(req)
    return PRESETS
  })

  app.get('/admin/directories/internal', { schema: { tags: T, summary: 'Strand’s internal directory: always first; how many active people it has (spec 0714)' } }, async req => {
    requireNoToken(req)
    const [r] = await db.query<{ users: number }>('select count(*)::int as users from users where directory_id is null and active and username is distinct from $1', ['recovery_admin'])
    return { name: 'Strand internal directory', users: r!.users }
  })

  app.get('/admin/directories/:id', { schema: { tags: T, summary: 'One user directory (its password is never returned)', params: id } }, async req => {
    requireNoToken(req)
    return one(req.params.id)
  })

  app.post('/admin/directories', { schema: { tags: T, summary: 'Add a user directory; the first synchronisation starts at once',
    body: z.object({ name: z.string().trim().min(1).max(100), type, enabled: z.boolean().default(true), config: directoryConfig, password }) } }, async (req, reply) => {
    requireNoToken(req)
    const b = req.body
    const dirId = await tx(async d => {
      const [dup] = await d.query('select 1 from user_directories where lower(name) = lower($1)', [b.name])
      if (dup) throw new HttpError(409, 'A user directory with this name already exists', { name: 'Already used' })
      const [row] = await d.query<{ id: string }>(
        `insert into user_directories (name, type, position, enabled, config) values ($1, $2, (select coalesce(max(position), 0) + 1 from user_directories), $3, $4) returning id`,
        [b.name, b.type, b.enabled, JSON.stringify(b.config)])
      await d.query('update user_directories set password_enc = $2 where id = $1', [row!.id, seal(b.password, row!.id)])
      await audit(d, req, { action: 'directory.created', type: 'directory', id: row!.id, name: b.name, after: { type: b.type, enabled: b.enabled, ...b.config, password: 'set' } })
      if (b.enabled) await scheduleSync(d, { id: row!.id, config: b.config }, true)
      return row!.id
    })
    kickJobs(app.log)
    reply.code(201)
    return one(dirId)
  })

  app.put('/admin/directories/:id', { schema: { tags: T, summary: 'Change a user directory. Changing its server or service account needs the password again', params: id,
    body: z.object({ name: z.string().trim().min(1).max(100), enabled: z.boolean(), config: directoryConfig, password: password.optional().describe('Leave out to keep the stored one') }) } }, async req => {
    requireNoToken(req)
    const b = req.body
    await tx(async d => {
      const [before] = await d.query<Directory>('select * from user_directories where id = $1 for update', [req.params.id])
      if (!before) throw new HttpError(404, 'User directory not found')
      if (!b.password && WHERE.some(k => before.config[k] !== b.config[k]))
        throw new HttpError(400, 'Enter the password again: the server or the service account changed', { password: 'Enter it again' })
      const [dup] = await d.query('select 1 from user_directories where lower(name) = lower($1) and id <> $2', [b.name, before.id])
      if (dup) throw new HttpError(409, 'A user directory with this name already exists', { name: 'Already used' })
      await d.query('update user_directories set name = $2, enabled = $3, config = $4, updated_at = now() where id = $1', [before.id, b.name, b.enabled, JSON.stringify(b.config)])
      if (b.password) await d.query('update user_directories set password_enc = $2 where id = $1', [before.id, seal(b.password, before.id)])
      const c = changes({ name: before.name, enabled: before.enabled, ...before.config }, { name: b.name, enabled: b.enabled, ...b.config })
      if (c.changed || b.password)
        await audit(d, req, { action: 'directory.updated', type: 'directory', id: before.id, name: b.name, before: c.before, after: { ...c.after, ...(b.password ? { password: 'changed' } : {}) } })
      if (b.enabled && !before.enabled) await scheduleSync(d, { id: before.id, config: b.config }, true)
    })
    kickJobs(app.log)
    return one(req.params.id)
  })

  app.put('/admin/directories/order', { schema: { tags: T, summary: 'The order sign-in tries the directories in: every directory, first first',
    body: z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }) } }, async req => {
    requireNoToken(req)
    await tx(async d => {
      const all = (await d.query<{ id: string }>('select id from user_directories for update')).map(r => r.id)
      if (all.length !== req.body.ids.length || all.some(x => !req.body.ids.includes(x))) throw new HttpError(400, 'List every directory once', { ids: 'Every directory, once' })
      await d.query('update user_directories d set position = o.n from unnest($1::uuid[]) with ordinality o(id, n) where d.id = o.id', [req.body.ids])
      await audit(d, req, { action: 'directory.reordered', type: 'directory', name: 'User directories', after: { order: req.body.ids } })
    })
    return db.query(`${VIEW} order by d.position`)
  })

  app.post('/admin/directories/test', { schema: { tags: T, summary: 'Test settings, saved or not: connect, find users and groups, and optionally a test user and their password',
    body: z.object({
      id: z.string().uuid().optional().describe('A saved directory: its stored password is used when none is sent and the server is unchanged'),
      config: directoryConfig, password: password.optional(),
      testUser: z.object({ username: z.string().trim().min(1).max(256), password: z.string().max(1024).default('') }).optional(),
    }) } }, async req => {
    requireNoToken(req)
    const b = req.body
    let pw = b.password ?? ''
    if (!pw && b.id) {
      const [saved] = await db.query<Directory>('select * from user_directories where id = $1', [b.id])
      if (!saved) throw new HttpError(404, 'User directory not found')
      if (WHERE.some(k => saved.config[k] !== b.config[k])) throw new HttpError(400, 'Enter the password again: the server or the service account changed', { password: 'Enter it again' })
      pw = bindPassword(saved)
    }
    if (!pw) throw new HttpError(400, 'Enter the service account’s password', { password: 'Required' })
    return { steps: await testDirectory(b.config, pw, b.testUser) }
  })

  app.post('/admin/directories/:id/sync', { schema: { tags: T, summary: 'Synchronise now (202 with the job; one already waiting or running is returned instead)', params: id } }, async (req, reply) => {
    requireNoToken(req)
    const d = await one(req.params.id)
    if (!d.enabled) throw new HttpError(409, 'The directory is disabled')
    const jobId = await tx(x => syncNow(x, req.params.id, req.me.id))
    kickJobs(app.log)
    reply.code(202)
    return { jobId }
  })
}

export default directories
