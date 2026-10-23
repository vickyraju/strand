import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { db, pool } from '../db.ts'
import { HttpError, type Me } from '../auth.ts'
import { minFor, need, roleOf, type ProjectRole } from '../access.ts'
import { issueByKey } from './issues.ts'
import { s3, filesBucket } from '../storage.ts'

// Files go browser → S3 directly via presigned URLs; the API never proxies bytes.
const MAX_BYTES = 25 * 1024 * 1024
const bucket = filesBucket
const needBucket = () => { if (!bucket()) throw new HttpError(503, 'File storage is not configured (S3_BUCKET)') }

/** An upload that is never confirmed is removed after this long. */
const PENDING_MS = 24 * 60 * 60_000

/** Deletes files that should no longer exist: uploads never confirmed, and objects queued by deleted attachments
 *  (removed directly, or with their item or project). A failed delete stays queued and is tried again next time.
 *  Runs on one API pod at a time (advisory lock).
 *  ponytail: a timer in the API process; move to the background job runner once there is one. */
export async function sweepFiles(now = Date.now()) {
  if (!bucket()) return { deleted: 0, failed: 0 }
  const c = await pool.connect()
  try {
    const [{ locked }] = (await c.query("select pg_try_advisory_lock(hashtext('strand.sweep_files')) as locked")).rows
    if (!locked) return { deleted: 0, failed: 0 }
    try {
      await c.query('delete from attachments where uploaded_at is null and added_at < $1', [new Date(now - PENDING_MS)])
      const queued = (await c.query('select object_key from file_deletions order by queued_at limit 200')).rows as { object_key: string }[]
      let deleted = 0, failed = 0
      for (const { object_key } of queued) {
        try {
          await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: object_key }))   // deleting a missing object succeeds too
          await c.query('delete from file_deletions where object_key = $1', [object_key]); deleted++
        } catch (e) {
          await c.query('update file_deletions set attempts = attempts + 1, last_error = $2 where object_key = $1', [object_key, String((e as Error).message ?? e).slice(0, 500)]); failed++
        }
      }
      return { deleted, failed }
    } finally { await c.query("select pg_advisory_unlock(hashtext('strand.sweep_files'))") }
  } finally { c.release() }
}

const plugin: FastifyPluginAsyncZod = async app => {
  const every = Number(process.env.FILE_SWEEP_MS ?? 10 * 60_000)
  if (every > 0) {
    const timer = setInterval(() => { sweepFiles().catch(e => app.log.error(e)) }, every)
    timer.unref()
    app.addHook('onClose', async () => clearInterval(timer))
  }

  // Step 1: register the attachment, get a URL to PUT the bytes to
  app.post('/issues/:key/attachments', { schema: {
    tags: ['Attachments'], summary: 'Register an attachment; returns a presigned uploadUrl to PUT the bytes to (5 min). Then call /attachments/:id/complete',
    params: z.object({ key: z.string().describe('Issue key, e.g. PAY-12') }),
    body: z.object({ name: z.string().min(1).max(255), size: z.number().int().positive().max(MAX_BYTES), type: z.string().max(255) }),
  } }, async req => {
    needBucket()
    const b = req.body
    const i = await issueByKey(db, req, req.params.key)
    const objectKey = `${req.me.workspaceId}/${i.id}/${randomUUID()}`
    const [a] = await db.query<any>(
      `insert into attachments (issue_id, name, size, type, object_key, added_by) values ($1, $2, $3, $4, $5, $6)
       returning id, name, size, type, added_by, added_at`, [i.id, b.name, b.size, b.type, objectKey, req.me.id])
    const uploadUrl = await getSignedUrl(s3(), new PutObjectCommand({ Bucket: bucket(), Key: objectKey, ContentType: b.type, ContentLength: b.size }), { expiresIn: 300 })
    return { ...a, uploadUrl }
  })

  /** An attachment by id, only if I can see its project (and, for changes, am a member of it). */
  const owned = async (id: string, req: { me: Me; method: string }, min?: ProjectRole) => {
    const [a] = await db.query<{ objectKey: string; name: string; size: string; projectId: string; uploadedAt: string | null; addedBy: string | null }>(
      `select a.object_key, a.name, a.size, a.uploaded_at, a.added_by, i.project_id from attachments a join issues i on i.id = a.issue_id
        where a.id = $1 and i.workspace_id = $2`,
      [z.string().uuid().parse(id), req.me.workspaceId])
    const role = a ? await roleOf(db, req.me, a.projectId) : null
    if (!a || !role) throw new HttpError(404, 'Not found')
    need(role, min ?? minFor(req.method))
    return a
  }

  // Step 2: after the PUT, confirm. The file must be in storage with the registered size; only then does the attachment show.
  app.post('/attachments/:id/complete', { schema: { tags: ['Attachments'], summary: 'Confirm an upload: checks the file arrived, then shows the attachment', params: z.object({ id: z.string().uuid() }) } }, async req => {
    needBucket()
    const a = await owned(req.params.id, req)
    if (a.addedBy !== req.me.id) throw new HttpError(403, 'Only the person who uploaded it can confirm it')
    const head = await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: a.objectKey })).catch(() => null)
    if (!head || Number(head.ContentLength) !== Number(a.size)) throw new HttpError(409, 'The file has not arrived (or is not the size that was registered); upload it again')
    const [row] = await db.query<any>(
      'update attachments set uploaded_at = coalesce(uploaded_at, now()) where id = $1 returning id, name, size, type, added_by, added_at', [req.params.id])
    return row
  })

  app.get('/attachments/:id/url', { schema: { tags: ['Attachments'], summary: 'Presigned download URL (5 min)', params: z.object({ id: z.string().uuid() }) } }, async req => {
    needBucket()
    const a = await owned(req.params.id, req)
    if (!a.uploadedAt) throw new HttpError(404, 'Not found')
    const url = await getSignedUrl(s3(), new GetObjectCommand({
      Bucket: bucket(), Key: a.objectKey, ResponseContentDisposition: `attachment; filename="${encodeURIComponent(a.name)}"`,
    }), { expiresIn: 300 })
    return { url }
  })

  // The row goes now; its file is queued (database trigger) and removed from storage by the sweeper, with retries
  app.delete('/attachments/:id', { schema: { tags: ['Attachments'], summary: 'Delete an attachment; its file is removed from storage shortly after', params: z.object({ id: z.string().uuid() }) } }, async (req, reply) => {
    await owned(req.params.id, req)
    await db.query('delete from attachments where id = $1', [req.params.id])
    reply.code(204).send()
  })
}

export default plugin
