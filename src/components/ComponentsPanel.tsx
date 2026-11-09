import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useStore, uid, userOf, type Component, type Project } from '../data/store'
import { useApp } from '../appContext'
import { UserSelect } from './UserPicker'
import { Avatar, Modal, plural } from './ui'
import { api, apiEnabled, errorMessage } from '../api/client'
import { issueSync } from '../api/sync'
import { changeOnServer } from '../api/settings'

const DEFAULT_ASSIGNEE: Record<Component['defaultAssignee'], string> = {
  none: 'Nobody (unassigned)', component_lead: 'The component lead', project_lead: 'The project lead',
}

/** Project settings › Components (Jira's): parts of the project. Work items can be in several; new work in one, with
 *  nobody chosen, goes to its default assignee. */
export default function ComponentsPanel({ project }: { project: Project }) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const [editing, setEditing] = useState<Component | null>(null)
  const [removing, setRemoving] = useState<Component | null>(null)
  const list = project.components ?? []
  const set = (components: Component[]) => dispatch({ type: 'updateProject', id: project.id, patch: { components } })
  const usage = (id: string) => state.issues.filter(i => i.projectId === project.id && i.componentIds?.includes(id)).length

  return (
    <section className="panel" aria-label="Components">
      <div className="panel-title-row">
        <div>
          <h2 className="panel-title">Components</h2>
          <p className="muted">Parts of {project.name}, such as “API” or “Billing”. A work item can be in several; each component can send new work to its lead.</p>
        </div>
        <button className="btn btn-secondary" onClick={() => setEditing({ id: uid(), name: '', description: '', defaultAssignee: 'none' })}><Plus size={14} />Add component</button>
      </div>
      {list.length === 0 ? <p className="muted sm">No components yet.</p> : (
        <div className="people">
          {list.map(c => {
            const lead = userOf(state, c.leadId)
            return (
              <div key={c.id} className="person">
                <Avatar user={lead} size={30} />
                <div className="person-text">
                  <span className="strong">{c.name}</span>
                  <span className="muted sm">{lead ? `Lead: ${lead.name}` : 'No lead'} · new work goes to {DEFAULT_ASSIGNEE[c.defaultAssignee].toLowerCase()} · {plural(usage(c.id), 'item')} here</span>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditing(c)}>Edit</button>
                <button className="icon-btn" onClick={() => setRemoving(c)} aria-label={`Delete ${c.name}`} title="Delete"><Trash2 size={14} /></button>
              </div>
            )
          })}
        </div>
      )}
      {editing && <ComponentDialog component={editing} project={project} onClose={() => setEditing(null)} onSave={c => {
        if (list.some(x => x.id !== c.id && x.name.toLowerCase() === c.name.toLowerCase())) { toast('A component with that name already exists', { tone: 'warn' }); return }
        set(list.some(x => x.id === c.id) ? list.map(x => (x.id === c.id ? c : x)) : [...list, c])
        toast(`Saved ${c.name}`); setEditing(null)
      }} />}
      {removing && <DeleteComponentDialog project={project} component={removing} onClose={() => setRemoving(null)} />}
    </section>
  )
}

function ComponentDialog({ component, project, onClose, onSave }: { component: Component; project: Project; onClose: () => void; onSave: (c: Component) => void }) {
  const [c, setC] = useState(component)
  const valid = !!c.name.trim()
  const submit = () => { if (valid) onSave({ ...c, name: c.name.trim() }) }
  return (
    <Modal title={component.name ? `Edit ${component.name}` : 'Add component'} onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!valid} onClick={submit}>Save</button>
    </>}>
      <form onSubmit={e => { e.preventDefault(); submit() }}>
        <label className="label" htmlFor="cmp-name">Name</label>
        <input id="cmp-name" className="input" autoFocus value={c.name} onChange={e => setC({ ...c, name: e.target.value })} />
        <label className="label" htmlFor="cmp-desc" style={{ marginTop: 10 }}>Description</label>
        <input id="cmp-desc" className="input" value={c.description} onChange={e => setC({ ...c, description: e.target.value })} />
        <div style={{ marginTop: 10 }}>
          <UserSelect label="Component lead" projectId={project.key} value={c.leadId} placeholder="No lead" onChange={leadId => setC({ ...c, leadId })} />
        </div>
        <label className="label" htmlFor="cmp-def" style={{ marginTop: 10 }}>New work in it goes to</label>
        <select id="cmp-def" className="input" value={c.defaultAssignee} onChange={e => setC({ ...c, defaultAssignee: e.target.value as Component['defaultAssignee'] })}>
          {Object.entries(DEFAULT_ASSIGNEE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <p className="hint">Only when nobody is chosen as the assignee.</p>
      </form>
    </Modal>
  )
}

/** Jira's Delete component: its work items move to another component, or lose it (spec 0304 R2). */
function DeleteComponentDialog({ project, component, onClose }: { project: Project; component: Component; onClose: () => void }) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const mine = state.issues.filter(i => i.projectId === project.id && i.componentIds?.includes(component.id))
  const [items, setItems] = useState<number | null>(apiEnabled ? null : mine.length)
  useEffect(() => {
    if (apiEnabled) api<{ items: number }>('GET', `/api/projects/${project.key}/components/${component.id}/usage`).then(u => setItems(u.items), () => setItems(mine.length))
  }, [project.key, component.id])   // eslint-disable-line react-hooks/exhaustive-deps
  const others = (project.components ?? []).filter(c => c.id !== component.id)
  const [moveTo, setMoveTo] = useState('')
  const next = { ...project, components: others }
  const show = () => dispatch({ type: 'updateProject', id: project.id, patch: { components: others } })
  return (
    <Modal title={`Delete “${component.name}”?`} onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-danger" disabled={items === null} onClick={async () => {
        try {
          if (apiEnabled) {
            await issueSync.idle()
            await changeOnServer('components', () => api('DELETE', `/api/projects/${project.key}/components/${component.id}${moveTo ? `?moveTo=${moveTo}` : ''}`), next, show)
          } else {
            for (const i of mine) dispatch({ type: 'updateIssues', ids: [i.id], patch: { componentIds: [...new Set(i.componentIds!.flatMap(x => x === component.id ? (moveTo ? [moveTo] : []) : [x]))] } })
            show()
          }
          toast(`${component.name} deleted`); onClose()
        } catch (e) { toast(errorMessage(e), { tone: 'warn' }) }
      }}>Delete component</button>
    </>}>
      {items === null ? <p className="muted">Counting its work items…</p> : items === 0 ? <p>No work items are in {component.name}.</p> : <>
        <label className="label" htmlFor="comp-move">{plural(items, 'work item')} {items === 1 ? 'is' : 'are'} in it: move to</label>
        <select id="comp-move" className="input" value={moveTo} onChange={e => setMoveTo(e.target.value)}>
          <option value="">No component (remove it from them)</option>
          {others.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <p className="muted sm" style={{ marginTop: 10 }}>The work items themselves aren’t deleted.</p>
      </>}
    </Modal>
  )
}
