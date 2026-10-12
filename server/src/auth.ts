import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { FastifyRequest } from 'fastify'
import { tx } from './db.ts'

export type Role = 'owner' | 'admin' | 'member' | 'viewer'
export interface Me { id: string; email: string; name: string; workspaceId: string; role: Role }

declare module 'fastify' { interface FastifyRequest { me: Me } }

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

const tenant = process.env.ENTRA_TENANT_ID
const clientId = process.env.ENTRA_CLIENT_ID
const jwks = tenant ? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`)) : null
const devAuth = process.env.AUTH_DEV === '1'
if (!devAuth && !jwks) throw new Error('Set ENTRA_TENANT_ID + ENTRA_CLIENT_ID (or AUTH_DEV=1 for local development)')

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?'

interface Identity { oid?: string; email: string; name: string; admin: boolean }

async function identify(req: FastifyRequest): Promise<Identity> {
  if (devAuth && !req.headers.authorization) {
    const email = String(req.headers['x-dev-user'] ?? 'dev@strand.local')
    return { email, name: email.split('@')[0]!, admin: req.headers['x-dev-admin'] === '1' }
  }
  const token = req.headers.authorization?.replace(/^Bearer /i, '')
  if (!token || !jwks) throw new HttpError(401, 'Missing bearer token')
  try {
    const { payload } = await jwtVerify(token, jwks, {
      audience: clientId,
      issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
    })
    const roles = (payload.roles as string[] | undefined) ?? []
    return {
      oid: payload.oid as string,
      email: String(payload.preferred_username ?? payload.email ?? '').toLowerCase(),
      name: String(payload.name ?? payload.preferred_username ?? ''),
      admin: roles.includes('Strand.Admin'),
    }
  } catch {
    throw new HttpError(401, 'Invalid token')
  }
}

/** Resolve the caller to a user + role, creating them (and the workspace, once) on first sight.
 *  ponytail: one upsert per request; add a short-lived cache keyed by oid if this shows up in profiles. */
export async function authenticate(req: FastifyRequest) {
  const who = await identify(req)
  if (!who.email) throw new HttpError(401, 'Token has no email')
  req.me = await tx(async d => {
    const [u] = await d.query<{ id: string; active: boolean }>(
      `insert into users (entra_oid, email, name, initials) values ($1, $2, $3, $4)
       on conflict (email) do update set entra_oid = coalesce(users.entra_oid, excluded.entra_oid)
       returning id, active`,
      [who.oid ?? null, who.email, who.name, initials(who.name)])
    if (!u!.active) throw new HttpError(403, 'Account is deactivated')
    let [ws] = await d.query<{ id: string }>('select id from workspaces order by created_at limit 1')
    const first = !ws
    if (!ws) [ws] = await d.query<{ id: string }>(`insert into workspaces (name) values ('Strand') returning id`)
    const want: Role = first ? 'owner' : who.admin ? 'admin' : 'member'
    const [m] = await d.query<{ role: Role }>(
      `insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)
       on conflict (workspace_id, user_id) do update set role = case
         when memberships.role = 'owner' then 'owner'
         when $4 then 'admin' else memberships.role end
       returning role`,
      [ws!.id, u!.id, want, who.admin])
    return { id: u!.id, email: who.email, name: who.name, workspaceId: ws!.id, role: m!.role }
  })
}

export const canWrite = (r: Role) => r !== 'viewer'
export const isAdmin = (r: Role) => r === 'owner' || r === 'admin'

export function requireWrite(req: FastifyRequest) {
  if (!canWrite(req.me.role)) throw new HttpError(403, 'Read-only access')
}
export function requireAdmin(req: FastifyRequest) {
  if (!isAdmin(req.me.role)) throw new HttpError(403, 'Admin only')
}
