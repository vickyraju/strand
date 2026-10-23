import { S3Client } from '@aws-sdk/client-s3'

// One S3 client for attachments and backups. Credentials come from the pod's IAM role (IRSA); the bucket's default
// encryption (SSE-KMS) applies to every object. S3_ENDPOINT points at another S3-compatible store (tests, local development).
let client: S3Client | undefined
export const s3 = () => (client ??= new S3Client({
  region: process.env.AWS_REGION,   // AWS_REGION is set by EKS; the SDK reads it when this is undefined
  ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true } : {}),
}))

/** The attachments bucket (empty when file storage is not configured). */
export const filesBucket = () => process.env.S3_BUCKET ?? ''
