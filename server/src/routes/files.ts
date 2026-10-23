import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { db } from '../db.ts'
import { HttpError, type Me } from '../auth.ts'
import { minFor, need, roleOf, type ProjectRole } from '../access.ts'
import { issueByKey } from './issues.ts'

// Files go browser → S3 directly via presigned URLs; the API never proxies bytes.
// Dev: point S3_ENDPOINT at Supabase Storage's S3 endpoint. Prod: leave unset (IRSA credentials on EKS).
const MAX_BYTES = 25 * 1024 * 1024
const bucket = process.env.S3_BUCKET ?? ''
const s3 = new S3Client({
  region: process.env.AWS_REGION ?? 'us-east-1',
  ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true } : {}),
})
const needBucket = () => { if (!bucket) throw new HttpError(503, 'File storage is not configured (S3_BUCKET)') }

const plugin: FastifyPluginAsyncZod = async app => {
  // Step 1: register the attachment, get a URL to PUT the bytes to
  app.post('/issues/:key/attachments', { schema: {
    tags: ['Attachments'], summary: 'Register an attachment; returns a presigned uploadUrl to PUT the bytes to (5 min)',
    params: z.object({ key: z.string().describe('Issue key, e.g. PAY-12') }),
    body: z.object({ name: z.string().min(1).max(255), size: z.number().int().positive().max(MAX_BYTES), type: z.string().max(255) }),
  } }, async req => {
    needBucket()
    const b = req.body
    const i = await issueByKey(db, req, req.params.key)
    const objectKey = `${req.me.workspaceId}/${i.id}/${randomUUID()}`
    const [a] = await db.query<any>(
      `insert into attachments (issue_id, name, size, type, object_key, added_by) values ($1, $2, $3, $4, $5, $6)
       returning id, name, size, type, added_at`, [i.id, b.name, b.size, b.type, objectKey, req.me.id])
    const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: objectKey, ContentType: b.type, ContentLength: b.size }), { expiresIn: 300 })
    return { ...a, uploadUrl }
  })

  /** An attachment by id, only if I can see its project (and, for changes, am a member of it). */
  const owned = async (id: string, req: { me: Me; method: string }, min?: ProjectRole) => {
    const [a] = await db.query<{ objectKey: string; name: string; projectId: string }>(
      `select a.object_key, a.name, i.project_id from attachments a join issues i on i.id = a.issue_id where a.id = $1 and i.workspace_id = $2`,
      [z.string().uuid().parse(id), req.me.workspaceId])
    const role = a ? await roleOf(db, req.me, a.projectId) : null
    if (!a || !role) throw new HttpError(404, 'Not found')
    need(role, min ?? minFor(req.method))
    return a
  }

  app.get('/attachments/:id/url', { schema: { tags: ['Attachments'], summary: 'Presigned download URL (5 min)', params: z.object({ id: z.string().uuid() }) } }, async req => {
    needBucket()
    const a = await owned(req.params.id, req)
    const url = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: bucket, Key: a.objectKey, ResponseContentDisposition: `attachment; filename="${encodeURIComponent(a.name)}"`,
    }), { expiresIn: 300 })
    return { url }
  })

  app.delete('/attachments/:id', { schema: { tags: ['Attachments'], summary: 'Delete an attachment and its file', params: z.object({ id: z.string().uuid() }) } }, async (req, reply) => {
    needBucket()
    const a = await owned(req.params.id, req)
    await db.query('delete from attachments where id = $1', [req.params.id])
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: a.objectKey }))
    reply.code(204).send()
  })
}

export default plugin
