// One error shape for every API response:
//   { error: "human readable", code: "machine_code", errors?: { "<field>": "<message>" } }
// `errors` is only present for input validation, keyed by field (like Jira's field errors).
import { ZodError } from 'zod'
import { HttpError } from './auth.ts'

export interface ErrorBody { error: string; code: string; errors?: Record<string, string> }

const CODES: Record<number, string> = {
  400: 'invalid_input', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 405: 'method_not_allowed',
  409: 'conflict', 413: 'payload_too_large', 415: 'unsupported_media_type', 429: 'rate_limited', 503: 'unavailable',
}
export const codeFor = (status: number) => CODES[status] ?? (status >= 500 ? 'internal' : 'error')

/** Field name from a validation path: "/labels/0" → "labels.0"; a missing root means the whole body. */
const fieldOf = (path: string | undefined, where: string | undefined) => {
  const p = (path ?? '').split('/').filter(Boolean).join('.')
  return p || where || 'body'
}

export function toErrorBody(err: any): { status: number; body: ErrorBody } {
  // Input validation (route schemas) → 400 with one message per field
  const issues: { path?: string; field?: string; message?: string }[] | undefined =
    err.validation?.map((v: any) => ({ path: v.instancePath, message: v.message, field: err.validationContext }))
    ?? (err instanceof ZodError ? err.issues.map(i => ({ path: '/' + i.path.join('/'), message: i.message })) : undefined)
  if (issues) {
    const errors: Record<string, string> = {}
    for (const i of issues) { const f = fieldOf(i.path, i.field); if (!(f in errors)) errors[f] = i.message ?? 'Invalid value' }
    return { status: 400, body: { error: 'Invalid input', code: 'invalid_input', errors } }
  }
  if (err instanceof HttpError) return { status: err.status, body: { error: err.message, code: codeFor(err.status) } }
  // Postgres constraint errors
  if (err.code === '23505') return { status: 409, body: { error: 'Already exists', code: 'conflict' } }
  if (err.code === '23503') return { status: 409, body: { error: 'Still referenced by other records', code: 'conflict' } }
  if (err.code === '23514' || err.code === '22P02') return { status: 400, body: { error: 'Invalid value', code: 'invalid_input' } }
  // Framework errors with a 4xx status (bad JSON, body too large, wrong content type, rate limit…)
  if (err.statusCode && err.statusCode < 500) return { status: err.statusCode, body: { error: err.message, code: codeFor(err.statusCode) } }
  return { status: 500, body: { error: 'Internal error', code: 'internal' } }
}

/** The JSON-schema description used for every documented error response. */
export const errorSchema = {
  type: 'object',
  required: ['error', 'code'],
  properties: {
    error: { type: 'string', description: 'Human-readable message' },
    code: { type: 'string', description: 'Stable machine-readable code', enum: ['invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict', 'rate_limited', 'internal'] },
    errors: { type: 'object', additionalProperties: { type: 'string' }, description: 'Validation messages by field (400 only)' },
  },
} as const
