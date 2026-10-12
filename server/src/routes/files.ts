import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { db } from '../db.ts'
import { HttpError, requireWrite } from '../auth.ts'

// Files go browser → S3 directly via presigned URLs; the API never proxies bytes.
// Dev: point S3_ENDPOINT at Supabase Storage's S3 endpoint. Prod: leave unset (IRSA credentials on EKS).
const MAX_BYTES = 25 * 1024 * 1024
const bucket = process.env.S3_BUCKET ?? ''
const s3 = new S3Client({
  region: process.env.AWS_REGION ?? 'us-east-1',
  ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true } : {}),
})
const needBucket = () => { if (!bucket) throw new HttpError(503, 'File storage is not configured (S3_BUCKET)') }

const plugin: FastifyPluginAsync = async app => {
  // Step 1: register the attachment, get a URL to PUT the bytes to
  app.post<{ Params: { key: string } }>('/issues/:key/attachments', async req => {
    requireWrite(req)
    needBucket()
    const b = z.object({ name: z.string().min(1).max(255), size: z.number().int().positive().max(MAX_BYTES), type: z.string().max(255) }).parse(req.body)
    const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(req.params.key)
    const [i] = m ? await db.query<{ id: string }>(
      `select i.id from issues i join projects p on p.id = i.project_id
        where i.workspace_id = $1 and p.key = $2 and i.number = $3 and i.deleted_at is null`,
      [req.me.workspaceId, m[1]!.toUpperCase(), Number(m[2])]) : []
    if (!i) throw new HttpError(404, 'Issue not found')
    const objectKey = `${req.me.workspaceId}/${i.id}/${randomUUID()}`
    const [a] = await db.query<any>(
      `insert into attachments (issue_id, name, size, type, object_key, added_by) values ($1, $2, $3, $4, $5, $6)
       returning id, name, size, type, added_at`, [i.id, b.name, b.size, b.type, objectKey, req.me.id])
    const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: objectKey, ContentType: b.type, ContentLength: b.size }), { expiresIn: 300 })
    return { ...a, uploadUrl }
  })

  const owned = async (id: string, ws: string) => {
    const [a] = await db.query<{ objectKey: string; name: string }>(
      `select a.object_key, a.name from attachments a join issues i on i.id = a.issue_id where a.id = $1 and i.workspace_id = $2`,
      [z.string().uuid().parse(id), ws])
    if (!a) throw new HttpError(404, 'Not found')
    return a
  }

  app.get<{ Params: { id: string } }>('/attachments/:id/url', async req => {
    needBucket()
    const a = await owned(req.params.id, req.me.workspaceId)
    const url = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: bucket, Key: a.objectKey, ResponseContentDisposition: `attachment; filename="${encodeURIComponent(a.name)}"`,
    }), { expiresIn: 300 })
    return { url }
  })

  app.delete<{ Params: { id: string } }>('/attachments/:id', async (req, reply) => {
    requireWrite(req)
    needBucket()
    const a = await owned(req.params.id, req.me.workspaceId)
    await db.query('delete from attachments where id = $1', [req.params.id])
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: a.objectKey }))
    reply.code(204).send()
  })
}

export default plugin
