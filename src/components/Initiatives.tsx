import { useEffect, useState } from 'react'
import { api, apiEnabled, ApiError } from '../api/client'
import { useApp } from '../appContext'
import { useStore, type Issue, type Project } from '../data/store'
import { Picker, TypeIcon } from './ui'

// Initiatives (spec 0803 R1): an epic's Initiative (Jira's Parent Link), an initiative's epics, and a project's switch.

interface Ini { id: string; key: string; title: string; projectKey: string }

/** The epic's initiative: initiatives in any project the person can see, searched on the server. */
export function InitiativeField({ issue, onChange }: { issue: Issue; onChange: (parentLinkId: string | undefined) => void }) {
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<Ini[]>([])
  const [current, setCurrent] = useState<Ini | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!apiEnabled) return
    const t = setTimeout(() => { setBusy(true); api<Ini[]>('GET', `/api/initiatives?query=${encodeURIComponent(query)}`).then(setFound, () => {}).finally(() => setBusy(false)) }, 200)
    return () => clearTimeout(t)
  }, [query])
  useEffect(() => {
    if (!issue.parentLinkId) { setCurrent(null); return }
    const known = found.find(i => i.id === issue.parentLinkId)
    if (known) setCurrent(known)
    else api<{ key: string; title: string }>('GET', `/api/issues/${issue.parentLinkId}`).then(r => setCurrent({ id: issue.parentLinkId!, key: r.key, title: r.title, projectKey: r.key.split('-')[0]! }), () => {})
  }, [issue.parentLinkId, found])
  return (
    <Picker value={issue.parentLinkId} search remote={{ onSearch: setQuery, searching: busy }} className="field-btn" title="Initiative"
      options={[{ value: undefined, label: 'None' }, ...found.map(i => ({ value: i.id as string | undefined, label: `${i.key} ${i.title}`, icon: <TypeIcon type="initiative" size={12} /> }))]}
      onChange={onChange}
      trigger={current ? <><TypeIcon type="initiative" size={13} /><span className="cell-ellipsis">{current.key} {current.title}</span></> : <span className="muted">None</span>} />
  )
}

/** An initiative's epics, wherever they are, and how many are done. */
export function InitiativeEpics({ issue }: { issue: Issue }) {
  const { openIssue } = useApp()
  const [epics, setEpics] = useState<{ id: string; key: string; title: string; category: string }[] | null>(null)
  useEffect(() => {
    if (!apiEnabled) return
    api<{ items: { id: string; key: string; title: string; category: string }[] }>('GET', `/api/search?jql=${encodeURIComponent(`"Parent Link" = ${issue.key} ORDER BY key`)}&limit=200`)
      .then(r => setEpics(r.items), () => setEpics([]))
  }, [issue.key])
  if (!epics) return null
  const done = epics.filter(e => e.category === 'done').length
  return (
    <section className="detail-section" aria-label="Epics in this initiative">
      <div className="section-title-row"><h2 className="section-title">Epics in this initiative</h2>{epics.length > 0 && <span className="muted sm">{done} of {epics.length} done</span>}</div>
      {epics.length === 0 ? <p className="muted sm">No epics yet: an epic joins this initiative from its Initiative field.</p> : (
        <ul className="plain-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>{epics.map(e => (
          <li key={e.id}><button className="link-btn" onClick={() => openIssue(e.id)}><TypeIcon type="epic" size={12} /> {e.key} {e.title}</button>
            <span className={`lozenge lozenge-${e.category === 'done' ? 'done' : e.category === 'in-progress' ? 'in-progress' : 'todo'}`} style={{ marginLeft: 6 }}>{e.category === 'done' ? 'Done' : e.category === 'in-progress' ? 'In progress' : 'To do'}</span></li>
        ))}</ul>
      )}
    </section>
  )
}

/** Project settings › Initiatives: the Initiative work type on or off. */
export function InitiativesPanel({ project, admin }: { project: Project; admin: boolean }) {
  const { dispatch } = useStore()
  const { toast } = useApp()
  const [busy, setBusy] = useState(false)
  const turn = async (enabled: boolean) => {
    setBusy(true)
    try {
      await api('PUT', `/api/projects/${encodeURIComponent(project.key)}/initiatives`, { enabled })
      const p = await api<{ initiatives: boolean; types: { key: string; name: string; color: string; icon: string }[] }>('GET', `/api/projects/${encodeURIComponent(project.key)}`)
      dispatch({ type: 'updateProject', id: project.id, patch: { initiatives: p.initiatives, types: p.types.map(t => ({ key: t.key, name: t.name, color: t.color, icon: t.icon })) } })
      toast(enabled ? 'Initiatives are on: Initiative is now a work type' : 'Initiatives are off')
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not reach the server.', { tone: 'warn' }) }
    setBusy(false)
  }
  return (
    <section className="panel" aria-label="Initiatives">
      <div className="panel-title-row">
        <div>
          <h2 className="panel-title">Initiatives</h2>
          <p className="muted">Initiatives sit above epics: an epic in any project joins one through its Initiative field, and plans show them together. Many teams keep their initiatives in a project of their own.</p>
        </div>
        {admin && <button className="btn btn-secondary" disabled={busy} onClick={() => void turn(!project.initiatives)}>{project.initiatives ? 'Turn off' : 'Turn on'}</button>}
      </div>
    </section>
  )
}
