import { useEffect, useState } from 'react'
import { Plus, X, Folder } from 'lucide-react'
import { useStore, type Issue, type Project } from '../../data/store'
import { api, ApiError } from '../../api/client'
import { useApp } from '../../appContext'
import { href } from '../../router'
import { Modal, TypeIcon, plural } from '../ui'
import { ResultLozenge, useResults, useTestStatuses } from './shared'

// The tests a Test Set, Test Plan or Pre-Condition holds (Xray's associations), and, on a Test, what holds it. A plan sorts
// its tests into folders (Xray's Test Plan board). Members come from the server, which leaves out tests you can't see.

interface Member { id: string; key: string; title: string; statusId: string; folder: string; projectId: string }
interface Container { id: string; key: string; type: string; title: string }
const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Could not reach the server.')
const enc = encodeURIComponent

export function TestsPanel({ issue, project, readOnly }: { issue: Issue; project: Project; readOnly: boolean }) {
  const { state } = useStore()
  const { toast } = useApp()
  const [items, setItems] = useState<Member[] | null>(null)
  const [adding, setAdding] = useState(false)
  const plan = issue.type === 'test_plan'
  const base = `/api/issues/${enc(issue.key)}/tests`
  useEffect(() => { api<Member[]>('GET', base).then(setItems, e => toast(message(e), { tone: 'warn' })) }, [base])   // eslint-disable-line react-hooks/exhaustive-deps
  const results = useResults(project.key, plan ? `plan=${enc(issue.key)}` : null)
  const statuses = useTestStatuses()
  const remove = (m: Member) => api('DELETE', `${base}/${enc(m.key)}`).then(() => setItems(items!.filter(x => x.id !== m.id)), e => toast(message(e), { tone: 'warn' }))
  const moveTo = (m: Member, folder: string) => api<Member[]>('PATCH', `${base}/${enc(m.key)}`, { folder }).then(setItems, e => toast(message(e), { tone: 'warn' }))
  const statusName = (m: Member) => state.projects.find(p => p.id === m.projectId)?.statuses.find(s => s.id === m.statusId)?.name ?? ''
  const folders = plan ? [...new Set((items ?? []).map(m => m.folder))] : ['']

  return (
    <section className="detail-section" aria-label="Tests">
      <div className="section-title-row">
        <h2 className="section-title">Tests{items ? <span className="muted"> · {items.length}</span> : null}</h2>
        {!readOnly && <button className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}><Plus size={14} />Add tests</button>}
      </div>
      {items?.length === 0 && <p className="muted sm">No tests yet.</p>}
      {folders.map(f => (
        <div key={f}>
          {plan && <p className="test-folder-label"><Folder size={13} />{f || 'Not in a folder'}</p>}
          <ul className="test-members">
            {(items ?? []).filter(m => !plan || m.folder === f).map(m => (
              <li key={m.id} className="test-member">
                <TypeIcon type="test" project={project} />
                <a href={href({ name: 'issue', key: m.key })} className="mono">{m.key}</a>
                <span className="test-member-title">{m.title}</span>
                {plan ? <ResultLozenge statuses={statuses} status={results.get(m.id)} /> : <span className="muted sm">{statusName(m)}</span>}
                {plan && !readOnly && (
                  <input className="input input-sm test-member-folder" defaultValue={m.folder} placeholder="Folder" aria-label={`Folder for ${m.key}`}
                    onBlur={e => e.target.value.trim() !== m.folder && moveTo(m, e.target.value)} onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
                )}
                {!readOnly && <button className="icon-btn sm" onClick={() => remove(m)} aria-label={`Remove ${m.key}`} title="Remove"><X size={13} /></button>}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {adding && <AddTestsDialog issue={issue} project={project} plan={plan} onClose={() => setAdding(false)}
        onAdded={(r: { added: number; already: number; items: Member[] }) => { setItems(r.items); setAdding(false); toast(`Added ${plural(r.added, 'test')}${r.already ? ` (${r.already} already there)` : ''}`) }} />}
    </section>
  )
}

function AddTestsDialog({ issue, project, plan, onClose, onAdded }: { issue: Issue; project: Project; plan: boolean; onClose: () => void; onAdded: (r: any) => void }) {
  const { state } = useStore()
  const [mode, setMode] = useState<'pick' | 'jql'>('pick')
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [jql, setJql] = useState(`project = ${project.key} AND type = test`)
  const [folder, setFolder] = useState('')
  const [error, setError] = useState('')
  const tests = state.issues.filter(i => i.projectId === project.id && i.type === 'test'
    && (!q.trim() || i.key.toLowerCase().includes(q.trim().toLowerCase()) || i.title.toLowerCase().includes(q.trim().toLowerCase()))).slice(0, 100)
  const add = () => api('POST', `/api/issues/${enc(issue.key)}/tests`, { ...(mode === 'pick' ? { keys: picked } : { jql }), ...(plan && folder.trim() ? { folder: folder.trim() } : {}) })
    .then(onAdded, e => setError(message(e)))
  return (
    <Modal title={`Add tests to ${issue.key}`} onClose={onClose} width={600} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={mode === 'pick' ? !picked.length : !jql.trim()} onClick={add}>{mode === 'pick' ? `Add ${plural(picked.length, 'test')}` : 'Add matching tests'}</button>
    </>}>
      <div className="segmented sm" role="radiogroup" aria-label="How to add">
        <button role="radio" aria-checked={mode === 'pick'} className={mode === 'pick' ? 'on' : ''} onClick={() => setMode('pick')}>Choose</button>
        <button role="radio" aria-checked={mode === 'jql'} className={mode === 'jql' ? 'on' : ''} onClick={() => setMode('jql')}>By JQL</button>
      </div>
      {mode === 'pick' ? <>
        <input className="input" style={{ marginTop: 10 }} placeholder="Find tests by key or title" aria-label="Find tests" value={q} autoFocus onChange={e => setQ(e.target.value)} />
        <ul className="pick-list">
          {tests.length === 0 && <li className="muted sm">No tests in this project match.</li>}
          {tests.map(t => (
            <li key={t.id}><label>
              <input type="checkbox" checked={picked.includes(t.key)} onChange={e => setPicked(e.target.checked ? [...picked, t.key] : picked.filter(k => k !== t.key))} />
              <span className="mono">{t.key}</span> {t.title}
            </label></li>
          ))}
        </ul>
      </> : <>
        <textarea className="input mono" rows={3} style={{ marginTop: 10 }} aria-label="JQL" value={jql} onChange={e => setJql(e.target.value)} />
        <p className="muted sm">Every Test the query finds is added; other work types are skipped.</p>
      </>}
      {plan && <input className="input" style={{ marginTop: 10 }} placeholder="Folder in this plan (optional), e.g. Smoke/Sign in" aria-label="Folder" value={folder} onChange={e => setFolder(e.target.value)} />}
      {error && <p className="hint error" role="alert">{error}</p>}
    </Modal>
  )
}

/** On a Test: the Test Sets, Test Plans and Pre-Conditions it is in. */
export function TestContainers({ issue }: { issue: Issue }) {
  const [items, setItems] = useState<Container[] | null>(null)
  useEffect(() => { api<Container[]>('GET', `/api/issues/${enc(issue.key)}/test-containers`).then(setItems, () => setItems([])) }, [issue.key])
  if (!items?.length) return null
  const label = (t: string) => t === 'test_set' ? 'Test Sets' : t === 'test_plan' ? 'Test Plans' : 'Pre-Conditions'
  return (
    <section className="detail-section" aria-label="Used in">
      <h2 className="section-title">Used in</h2>
      {['precondition', 'test_set', 'test_plan'].filter(t => items.some(i => i.type === t)).map(t => (
        <p key={t} className="sm"><span className="muted">{label(t)}: </span>
          {items.filter(i => i.type === t).map((i, n) => <span key={i.id}>{n ? ', ' : ''}<a href={href({ name: 'issue', key: i.key })} className="mono">{i.key}</a> {i.title}</span>)}
        </p>
      ))}
    </section>
  )
}
