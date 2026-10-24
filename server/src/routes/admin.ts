import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { db, tx } from '../db.ts'
import { HttpError, requireAdmin } from '../auth.ts'
import { audit, changes } from '../audit.ts'
import { enqueue, kickJobs } from '../jobs.ts'
import { allowedBackupBuckets, backupBucket, backupSettings } from '../backups.ts'
import { s3 } from '../storage.ts'
import { SETTINGS, getSetting, isSettingKey, setSetting, type SettingKey } from '../settings.ts'

const idP = z.object({ id: z.string().uuid() })
const TAG = ['Admin']

const plugin: FastifyPluginAsyncZod = async app => {
  // ── People in the workspace (global admins). Accounts and admin rights come from Entra (sign-in and SCIM), so this is a view, not an editor ──
  app.get('/admin/users', { schema: { tags: TAG, summary: 'Everyone in the workspace, with role, status and how many projects they are in (global admins)' } }, async req => {
    requireAdmin(req)
    return db.query(
      `select u.id, u.name, u.email, u.initials, u.color, u.title, u.active, m.role, u.created_at,
              (select count(*)::int from project_access pm join projects p on p.id = pm.project_id
                where pm.user_id = u.id and p.workspace_id = $1 and p.deleting_at is null) as projects
         from memberships m join users u on u.id = m.user_id
        where m.workspace_id = $1 order by u.active desc, lower(u.name), u.id limit 5000`, [req.me.workspaceId])
  })

  // ── System settings: policies a workspace admin controls (rate limiting, attachments, tokens, export and bulk sizes, due reminders) ──
  const keyP = z.object({ key: z.string().describe(`One of: ${Object.keys(SETTINGS).filter(k => !('ownRoutes' in SETTINGS[k as SettingKey])).join(', ')}`) })
  const view = async (ws: string, key: SettingKey) => {
    const s = SETTINGS[key]
    return { key, label: s.label, description: s.description, value: await getSetting(ws, key), default: s.default }
  }
  app.get('/admin/settings', { schema: { tags: TAG, summary: 'Every system setting with its current value and default (global admins)' } }, async req => {
    requireAdmin(req)
    return Promise.all((Object.keys(SETTINGS) as SettingKey[]).filter(k => !('ownRoutes' in SETTINGS[k])).map(k => view(req.me.workspaceId, k)))
  })
  app.put('/admin/settings/:key', { schema: {
    tags: TAG, summary: 'Change one system setting (global admins). Send the whole value; it is checked against the setting\'s rules', params: keyP, body: z.record(z.string(), z.unknown()),
  } }, async req => {
    requireAdmin(req)
    const key = req.params.key
    if (!isSettingKey(key) || 'ownRoutes' in SETTINGS[key]) throw new HttpError(404, 'No such setting')
    const parsed = SETTINGS[key].schema.safeParse(req.body)
    if (!parsed.success) throw new HttpError(400, 'That setting is not valid',
      Object.fromEntries(parsed.error.issues.map(i => [i.path.join('.') || 'value', i.message])))
    await tx(async d => {
      const before = await getSetting(req.me.workspaceId, key, d)
      await setSetting(d, req.me.workspaceId, key, parsed.data, req.me.id)
      const c = changes(before as any, parsed.data as any)
      if (c.changed) await audit(d, req, { action: `settings.${key}.updated`, type: 'settings', name: SETTINGS[key].label, before: c.before, after: c.after })
    })
    return view(req.me.workspaceId, key)
  })
  // Rate limiting › Limited accounts: who was refused in the last 24 hours (newest first)
  app.get('/admin/rate-limits/limited', { schema: { tags: TAG, summary: 'People whose access tokens were rate limited in the last 24 hours (global admins)' } }, async req => {
    requireAdmin(req)
    return db.query(
      `select u.id as user_id, u.name, u.email, r.first_at, r.last_at, r.times
         from rate_limited_accounts r join users u on u.id = r.user_id
        where r.workspace_id = $1 and r.last_at > now() - interval '24 hours' order by r.last_at desc limit 500`, [req.me.workspaceId])
  })

  // what the web app needs to behave like the server (limits it shows or checks before sending)
  app.get('/settings/public', { schema: { tags: ['Me'], summary: 'Settings every signed-in person may see: attachment, token, export, bulk and due-date limits' } }, async req =>
    Object.fromEntries(await Promise.all((Object.keys(SETTINGS) as SettingKey[]).filter(k => SETTINGS[k].public).map(async k => [k, await getSetting(req.me.workspaceId, k)]))))

  // ── Backups taken when a project is deleted (a workspace setting, for global admins) ──
  app.get('/admin/settings/project-backups', { schema: { tags: TAG, summary: 'Whether deleting a project backs it up first, and where (global admins)' } }, async req => {
    requireAdmin(req)
    const s = await backupSettings(db, req.me.workspaceId)
    return { enabled: s.enabled, bucket: s.bucket ?? null, prefix: s.prefix ?? 'project-backups/', effectiveBucket: backupBucket(s) || null, allowedBuckets: allowedBackupBuckets() }
  })

  app.put('/admin/settings/project-backups', { schema: {
    tags: TAG, summary: 'Turn project backups on or off and choose where they go (global admins)',
    body: z.object({
      enabled: z.boolean(),
      bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'An S3 bucket name').nullable().optional().describe('Empty: BACKUP_BUCKET, else the attachments bucket'),
      prefix: z.string().max(200).regex(/^[A-Za-z0-9!_.*'()/-]*$/).optional(),
    }),
  } }, async req => {
    requireAdmin(req)
    if (req.body.bucket && !allowedBackupBuckets().includes(req.body.bucket))
      throw new HttpError(400, 'That bucket is not one the operators allow for backups (BACKUP_BUCKETS)', { bucket: 'Not an allowed backup bucket' })
    const next = { enabled: req.body.enabled, ...(req.body.bucket ? { bucket: req.body.bucket } : {}), ...(req.body.prefix !== undefined ? { prefix: req.body.prefix } : {}) }
    await tx(async d => {
      const before = await backupSettings(d, req.me.workspaceId)
      await setSetting(d, req.me.workspaceId, 'projectBackups', next, req.me.id)
      const c = changes(before as any, next as any)
      if (c.changed) await audit(d, req, { action: 'settings.project_backups.updated', type: 'settings', name: 'Project backups', before: c.before, after: c.after })
    })
    const s = await backupSettings(db, req.me.workspaceId)
    return { enabled: s.enabled, bucket: s.bucket ?? null, prefix: s.prefix ?? 'project-backups/', effectiveBucket: backupBucket(s) || null, allowedBuckets: allowedBackupBuckets() }
  })

  app.get('/admin/project-backups', { schema: { tags: TAG, summary: 'Backups of deleted projects, newest first (global admins)' } }, async req => {
    requireAdmin(req)
    return db.query(
      `select id, project_id, project_key, project_name, bucket, object_key, items, files, bytes, created_at, created_by, restored_at
         from project_backups where workspace_id = $1 order by created_at desc limit 500`, [req.me.workspaceId])
  })

  app.get('/admin/project-backups/:id/url', { schema: { tags: TAG, summary: 'Download link for a backup document (5 min, global admins)', params: idP } }, async req => {
    requireAdmin(req)
    const [b] = await db.query<{ bucket: string; objectKey: string; projectKey: string }>(
      'select bucket, object_key, project_key from project_backups where id = $1 and workspace_id = $2', [req.params.id, req.me.workspaceId])
    if (!b) throw new HttpError(404, 'Backup not found')
    await tx(d => audit(d, req, { action: 'project.backup.downloaded', type: 'backup', id: req.params.id, name: b.projectKey }))
    return { url: await getSignedUrl(s3(), new GetObjectCommand({ Bucket: b.bucket, Key: b.objectKey, ResponseContentDisposition: `attachment; filename="${b.projectKey}-backup.json"` }), { expiresIn: 300 }) }
  })

  app.post('/admin/project-backups/:id/restore', { schema: { tags: TAG, summary: 'Restore a deleted project from its backup (runs in the background; global admins)', params: idP,
    response: { 202: z.object({ jobId: z.string().uuid().describe('Follow it at GET /jobs/{id}') }) } } }, async (req, reply) => {
    requireAdmin(req)
    const jobId = await tx(async d => {
      const [b] = await d.query<{ projectKey: string; restoredAt: string | null }>(
        'select project_key, restored_at from project_backups where id = $1 and workspace_id = $2', [req.params.id, req.me.workspaceId])
      if (!b) throw new HttpError(404, 'Backup not found')
      if (b.restoredAt) throw new HttpError(409, 'This backup has already been restored')
      const [taken] = await d.query('select 1 from projects where workspace_id = $1 and key = $2', [req.me.workspaceId, b.projectKey])
      if (taken) throw new HttpError(409, `A project with the key ${b.projectKey} already exists`)
      await audit(d, req, { action: 'project.restore_requested', type: 'backup', id: req.params.id, name: b.projectKey })
      return enqueue(d, 'project.restore', { backupId: req.params.id, actorId: req.me.id, actorEmail: req.me.email, ip: req.ip },
        { workspaceId: req.me.workspaceId, createdBy: req.me.id, dedupeKey: `project.restore:${req.params.id}`, maxAttempts: 3 })
    })
    kickJobs(app.log)
    reply.code(202)
    return { jobId }
  })

  // ── Background jobs: the person who started one, and global admins, can follow it ──
  app.get('/jobs/:id', { schema: { tags: TAG, summary: 'Progress of a background job you started', params: idP } }, async req => {
    const [j] = await db.query<any>(
      `select id, kind, status, attempts, max_attempts, last_error, result, created_by, created_at, finished_at
         from jobs where id = $1 and workspace_id = $2`, [req.params.id, req.me.workspaceId])
    if (!j || (j.createdBy !== req.me.id && !req.me.admin)) throw new HttpError(404, 'Job not found')
    return j
  })
}

export default plugin
