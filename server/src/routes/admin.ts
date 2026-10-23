import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { db, tx } from '../db.ts'
import { HttpError, requireAdmin } from '../auth.ts'
import { audit, changes } from '../audit.ts'
import { enqueue, kickJobs } from '../jobs.ts'
import { backupBucket, backupSettings } from '../backups.ts'
import { s3 } from '../storage.ts'

const idP = z.object({ id: z.string().uuid() })
const TAG = ['Admin']

const plugin: FastifyPluginAsyncZod = async app => {
  // ── Backups taken when a project is deleted (a workspace setting, for global admins) ──
  app.get('/admin/settings/project-backups', { schema: { tags: TAG, summary: 'Whether deleting a project backs it up first, and where (global admins)' } }, async req => {
    requireAdmin(req)
    const s = await backupSettings(db, req.me.workspaceId)
    return { enabled: s.enabled, bucket: s.bucket ?? null, prefix: s.prefix ?? 'project-backups/', effectiveBucket: backupBucket(s) || null }
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
    const next = { enabled: req.body.enabled, ...(req.body.bucket ? { bucket: req.body.bucket } : {}), ...(req.body.prefix !== undefined ? { prefix: req.body.prefix } : {}) }
    await tx(async d => {
      const before = await backupSettings(d, req.me.workspaceId)
      await d.query(
        `insert into workspace_settings (workspace_id, project_backups, updated_by) values ($1, $2, $3)
         on conflict (workspace_id) do update set project_backups = $2, updated_at = now(), updated_by = $3`,
        [req.me.workspaceId, JSON.stringify(next), req.me.id])
      const c = changes(before as any, next as any)
      if (c.changed) await audit(d, req, { action: 'settings.project_backups.updated', type: 'settings', name: 'Project backups', before: c.before, after: c.after })
    })
    const s = await backupSettings(db, req.me.workspaceId)
    return { enabled: s.enabled, bucket: s.bucket ?? null, prefix: s.prefix ?? 'project-backups/', effectiveBucket: backupBucket(s) || null }
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
