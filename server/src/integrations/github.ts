// GitHub webhook handling, pure parts: signature check and turning payloads into normalized records.
// No database and no network here, so it is unit-tested with sample payloads.
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Source } from './links.ts'

/** X-Hub-Signature-256 = "sha256=" + hex HMAC-SHA256 of the raw body, keyed by the webhook secret. */
export function verifySignature(rawBody: string | Buffer, header: string | undefined, secret: string): boolean {
  if (!secret || !header?.startsWith('sha256=')) return false
  const want = Buffer.from('sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex'))
  const got = Buffer.from(header)
  return got.length === want.length && timingSafeEqual(got, want)       // constant-time, never ==
}

export interface Repo { externalId: string; fullName: string; defaultBranch: string; url: string }
export interface Norm {
  kind: 'pull_request' | 'branch' | 'commit'
  externalId: string
  url: string | null
  title: string
  state: string | null
  author: { login?: string; name?: string; avatarUrl?: string } | null   // emails are never kept
  branchFrom: string | null
  branchTo: string | null
  /** undefined = leave as is; null = clear; string = set */
  reviewState?: string | null
  payload: Record<string, unknown>
  sourceUpdatedAt: string
  texts: Source[]
  /** True when the texts are the whole truth for this record (a PR title can be edited), so old links not found again are dropped. */
  replaceLinks: boolean
}
export interface Parsed { repo: Repo | null; installationId: number | null; entities: Norm[] }

const MAX_COMMITS = 50          // per push; a force-push of a huge branch must not turn into thousands of rows
const firstLine = (s: string) => s.split('\n')[0]!.slice(0, 300)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

export function repoOf(p: any): Repo | null {
  const r = p?.repository
  if (!r || r.id == null || !r.full_name) return null
  return { externalId: String(r.id), fullName: String(r.full_name), defaultBranch: str(r.default_branch) ?? 'main', url: str(r.html_url) ?? `https://github.com/${r.full_name}` }
}

function pullRequest(p: any, reviewState?: string | null): Norm | null {
  const pr = p?.pull_request
  if (!pr || pr.number == null) return null
  return {
    kind: 'pull_request', externalId: String(pr.number), url: str(pr.html_url), title: String(pr.title ?? ''),
    state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
    author: pr.user ? { login: str(pr.user.login) ?? undefined, avatarUrl: str(pr.user.avatar_url) ?? undefined } : null,
    branchFrom: str(pr.head?.ref), branchTo: str(pr.base?.ref), reviewState,
    payload: { number: pr.number, draft: !!pr.draft, merged: !!pr.merged, mergedAt: str(pr.merged_at), headSha: str(pr.head?.sha) },
    sourceUpdatedAt: str(pr.updated_at) ?? new Date().toISOString(),
    texts: [{ via: 'branch', text: String(pr.head?.ref ?? '') }, { via: 'title', text: String(pr.title ?? '') }, { via: 'body', text: String(pr.body ?? '') }],
    replaceLinks: true,
  }
}

function branch(name: string, repo: Repo, deleted: boolean, at: string): Norm {
  return {
    kind: 'branch', externalId: name, url: `${repo.url}/tree/${encodeURI(name)}`, title: name, state: deleted ? 'deleted' : 'active',
    author: null, branchFrom: null, branchTo: null, payload: {}, sourceUpdatedAt: at, texts: [{ via: 'branch', text: name }], replaceLinks: true,
  }
}

const reviewOutcome = (state: unknown, action: unknown): string | null | undefined => {
  if (action === 'dismissed') return null
  const s = String(state ?? '').toLowerCase()                            // webhooks send lowercase; REST sends uppercase
  return s === 'approved' || s === 'changes_requested' ? s : undefined   // a plain comment changes nothing
}

/** Turn one delivery into the records it describes. Unknown events and actions produce no records. */
export function parseEvent(event: string, p: any): Parsed {
  const repo = repoOf(p)
  const installationId = p?.installation?.id != null ? Number(p.installation.id) : null
  const out: Norm[] = []
  const now = new Date().toISOString()

  if (event === 'pull_request') { const n = pullRequest(p); if (n) out.push(n) }
  else if (event === 'pull_request_review' && (p.action === 'submitted' || p.action === 'dismissed')) {
    const n = pullRequest(p, reviewOutcome(p.review?.state, p.action)); if (n) out.push(n)
  } else if (event === 'push' && repo && typeof p.ref === 'string' && p.ref.startsWith('refs/heads/')) {
    const name = p.ref.slice('refs/heads/'.length)
    out.push(branch(name, repo, !!p.deleted, str(p.head_commit?.timestamp) ?? now))
    if (!p.deleted) for (const c of (Array.isArray(p.commits) ? p.commits : []).slice(0, MAX_COMMITS)) {
      if (!c?.id) continue
      const message = String(c.message ?? '')
      out.push({
        kind: 'commit', externalId: String(c.id), url: str(c.url), title: firstLine(message), state: null,
        author: { login: str(c.author?.username) ?? undefined, name: str(c.author?.name) ?? undefined },
        branchFrom: null, branchTo: name, payload: { message: message.slice(0, 4000) }, sourceUpdatedAt: str(c.timestamp) ?? now,
        texts: [{ via: 'commit', text: message }], replaceLinks: false,
      })
    }
  } else if ((event === 'create' || event === 'delete') && repo && p.ref_type === 'branch' && typeof p.ref === 'string') {
    out.push(branch(p.ref, repo, event === 'delete', now))
  }
  return { repo, installationId, entities: out }
}
