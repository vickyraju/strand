// Project settings › Deleted work items (spec 0202): what was deleted in this project, newest first, with who deleted it
// and when it goes for good (the period in System settings). A project admin can restore one, with what went with it.
import { useState } from 'react'
import { api, errorMessage } from '../api/client'
import { sprintDeps } from '../api/sprints'
import { timeAgo, type Project } from '../data/store'
import { useApp } from '../appContext'
import { PagedList } from './admin/scale'
import { plural } from './ui'

interface Row { id: string; key: string; title: string; type: string; deletedAt: string; deletedBy: string | null; removedAt: string; subItems: number }

export default function DeletedItems({ project }: { project: Project }) {
  const { toast } = useApp()
  const [version, setVersion] = useState(0)
  const restore = async (r: Row) => {
    try {
      await api('POST', `/api/issues/${encodeURIComponent(r.key)}/restore`)
      await sprintDeps.reloadProject(project.id)                         // the item (and its sub-items) back on screen
      toast(`${r.key} restored${r.subItems ? ` with ${plural(r.subItems, 'sub-item')}` : ''}`)
      setVersion(v => v + 1)
    } catch (e) { toast(errorMessage(e), { tone: 'warn' }) }
  }
  return (
    <section className="panel" id="deleted-items">
      <h2 className="panel-title">Deleted work items</h2>
      <p className="muted">Restore a work item deleted by mistake, with the sub-items deleted with it. Each is removed for good after the period set in System settings.</p>
      <PagedList<Row> key={version} path={`/api/projects/${encodeURIComponent(project.key)}/deleted`} idOf={r => r.id} searchLabel="Filter deleted work items" limit={20}
        empty="Nothing deleted."
        row={r => (
          <div className="paged-row">
            <span className="mono muted">{r.key}</span>
            <span className="strong" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
            {r.subItems > 0 && <span className="muted sm">+ {plural(r.subItems, 'sub-item')}</span>}
            <div style={{ flex: 1 }} />
            <span className="muted sm" title={`Removed for good ${new Date(r.removedAt).toLocaleDateString()}`}>Deleted {timeAgo(Date.parse(r.deletedAt))}{r.deletedBy ? ` by ${r.deletedBy}` : ''}</span>
            <button className="btn btn-secondary btn-sm" onClick={() => void restore(r)}>Restore</button>
          </div>
        )} />
    </section>
  )
}
