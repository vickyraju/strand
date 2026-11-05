// Administration › Archived projects (spec 0102, Jira's Administration › Projects › Archived projects): archived projects,
// newest first, searchable, a page at a time; restoring one brings it back as it was.
import { useState } from 'react'
import { api } from '../../api/client'
import { loadProjectByKey } from '../../api/load'
import { useStore, timeAgo } from '../../data/store'
import { useApp } from '../../appContext'
import { href, navigate } from '../../router'
import { ConfirmDialog } from '../ui'
import { PagedList } from './scale'

interface Row { id: string; key: string; name: string; archivedAt: string; archivedBy: string | null }

export default function ArchivedProjects() {
  const { dispatch } = useStore()
  const { toast } = useApp()
  const [restoring, setRestoring] = useState<Row | null>(null)
  const [version, setVersion] = useState(0)
  return (
    <>
      <PagedList<Row> key={version} path="/api/admin/archived-projects" idOf={p => p.id} searchLabel="Find an archived project"
        empty="No archived projects. A system administrator archives a project from its Project settings."
        row={p => (
          <div className="paged-row">
            <span className="mono muted">{p.key}</span>
            <a className="strong" href={href({ name: 'project', key: p.key })} onClick={e => { e.preventDefault(); navigate(href({ name: 'project', key: p.key })) }}>{p.name}</a>
            <span className="muted sm">Archived {timeAgo(Date.parse(p.archivedAt))}{p.archivedBy ? ` by ${p.archivedBy}` : ''}</span>
            <div style={{ flex: 1 }} />
            <button className="btn btn-secondary btn-sm" onClick={() => setRestoring(p)}>Restore</button>
          </div>
        )} />
      {restoring && (
        <ConfirmDialog title={`Restore ${restoring.name}?`} action="Restore project" danger={false} onClose={() => setRestoring(null)}
          onConfirm={async () => {
            await api('POST', `/api/projects/${encodeURIComponent(restoring.key)}/restore`)
            const { project, sprints } = await loadProjectByKey(restoring.key)
            dispatch({ type: 'loadProject', project, sprints })
            toast(`${restoring.name} restored`)
            setVersion(v => v + 1)
          }}>
          <p>It comes back as it was: in project lists, search and boards, and its members can change its work again.</p>
        </ConfirmDialog>
      )}
    </>
  )
}
