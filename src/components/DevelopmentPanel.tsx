import { useEffect, useState } from 'react'
import { Copy, GitBranch, GitCommitHorizontal, GitPullRequest } from 'lucide-react'
import { api } from '../api/client'
import { useApp } from '../appContext'
import { timeAgo } from '../data/store'
import { Modal, plural } from './ui'
import { branchName } from '../../server/src/integrations/links.ts'

// The item's Development panel (spec 0707), as Jira's: branches, commits and pull requests that name it, each line opening
// its list by repository. Better than Jira's: a count per pull request status, each commit's branch, and the branch name to copy.

interface Dev { id: string; externalId: string; url: string | null; title: string; state: string | null; author: { login?: string; name?: string } | null
  branchFrom: string | null; branchTo: string | null; reviewState: string | null; updatedAt: string; repo: string }
interface DevInfo { pullRequests: Dev[]; branches: Dev[]; commits: Dev[] }
type Kind = 'branches' | 'commits' | 'pullRequests'

const PR_STATES: [string, string, string][] = [['open', 'Open', 'lozenge-in-progress'], ['merged', 'Merged', 'lozenge-done'], ['closed', 'Declined', 'lozenge-todo']]
const REVIEW: Record<string, string> = { approved: 'Approved', changes_requested: 'Changes requested' }
const who = (d: Dev) => d.author?.name ?? d.author?.login ?? ''

export default function DevelopmentPanel({ issueKey, title }: { issueKey: string; title: string }) {
  const { toast } = useApp()
  const [info, setInfo] = useState<DevInfo | null>(null)
  const [open, setOpen] = useState<Kind | null>(null)
  useEffect(() => { setInfo(null); api<DevInfo>('GET', `/api/issues/${issueKey}/development`).then(setInfo, () => {}) }, [issueKey])
  const name = branchName(issueKey, title)
  const copy = (text: string, what: string) => { void navigator.clipboard?.writeText(text); toast(`Copied the ${what}`) }
  const { branches = [], commits = [], pullRequests = [] } = info ?? {}
  return (
    <div className="side-card dev-panel" aria-label="Development">
      <h2 className="side-title">Development</h2>
      {branches.length > 0 && <button className="dev-line" onClick={() => setOpen('branches')}><GitBranch size={14} />{plural(branches.length, 'branch')}</button>}
      {commits.length > 0 && <button className="dev-line" onClick={() => setOpen('commits')}><GitCommitHorizontal size={14} />{plural(commits.length, 'commit')}
        <span className="muted sm">· latest {timeAgo(Date.parse(commits[0]!.updatedAt))}</span></button>}
      {pullRequests.length > 0 && <button className="dev-line" onClick={() => setOpen('pullRequests')}><GitPullRequest size={14} />{plural(pullRequests.length, 'pull request')}
        {PR_STATES.map(([s, label, cls]) => { const n = pullRequests.filter(p => p.state === s).length; return n ? <span key={s} className={`lozenge ${cls}`}>{n} {label}</span> : null })}</button>}
      <div className="dev-branch">
        <span className="muted sm">Branch name</span>
        <code className="mono sm" title={name}>{name}</code>
        <button className="icon-btn sm" aria-label="Copy branch name" onClick={() => copy(name, 'branch name')}><Copy size={13} /></button>
        <button className="link sm" onClick={() => copy(`git checkout -b ${name}`, 'git command')}>Copy git command</button>
      </div>
      {open && info && <DevDialog kind={open} info={info} onClose={() => setOpen(null)} />}
    </div>
  )
}

function DevDialog({ kind, info, onClose }: { kind: Kind; info: DevInfo; onClose: () => void }) {
  const rows = info[kind]
  const repos = [...new Set(rows.map(r => r.repo))]
  const title = { branches: 'Branches', commits: 'Commits', pullRequests: 'Pull requests' }[kind]
  const link = (d: Dev, text: string) => (d.url ? <a href={d.url} target="_blank" rel="noreferrer">{text}</a> : text)
  return (
    <Modal title={title} onClose={onClose} width={720}>
      {repos.map(repo => (
        <section key={repo} className="dev-repo">
          <h3 className="dir-section">{repo}</h3>
          <table className="table">
            <tbody>
              {rows.filter(r => r.repo === repo).map(d => (
                <tr key={d.id} style={{ cursor: 'default' }}>
                  {kind === 'branches' && <>
                    <td className="mono sm">{link(d, d.title)}</td>
                    <td className="muted sm">{plural(info.pullRequests.filter(p => p.repo === repo && p.branchFrom === d.title).length, 'pull request')}</td>
                  </>}
                  {kind === 'commits' && <>
                    <td className="mono sm">{link(d, d.externalId.slice(0, 7))}</td>
                    <td>{d.title}</td><td className="sm">{who(d)}</td><td className="mono sm">{d.branchTo}</td>
                  </>}
                  {kind === 'pullRequests' && <>
                    <td>{link(d, `#${d.externalId} ${d.title}`)}<div className="muted sm mono">{d.branchFrom} → {d.branchTo}</div></td>
                    <td className="sm">{who(d)}</td>
                    <td>{PR_STATES.filter(([s]) => s === d.state).map(([s, label, cls]) => <span key={s} className={`lozenge ${cls}`}>{label}</span>)}</td>
                    <td className="sm">{d.reviewState ? REVIEW[d.reviewState] ?? d.reviewState : ''}</td>
                  </>}
                  <td className="muted sm" style={{ whiteSpace: 'nowrap' }}>{timeAgo(Date.parse(d.updatedAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </Modal>
  )
}
