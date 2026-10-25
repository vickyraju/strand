import { useEffect, useState } from 'react'
import { Folder, FolderPlus, Pencil, Trash2, Plus } from 'lucide-react'
import { useStore, type Project } from '../../data/store'
import { api, ApiError } from '../../api/client'
import { useApp } from '../../appContext'
import { canEdit } from '../../data/access'
import { href } from '../../router'
import { Checkbox, plural } from '../ui'
import { ResultLozenge, useResults, useTestStatuses } from './shared'

// The project's Tests tab (Xray's Test Repository): a folder tree on the left, the tests in the chosen folder on the right.
// Tests are moved between folders by selecting them; folders can be added, renamed and removed (their contents move up).

interface TestFolder { id: string; parentId: string | null; name: string; position: number; tests: number }
const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Could not reach the server.')

export default function TestRepository({ project }: { project: Project }) {
  const { state, dispatch } = useStore()
  const { toast, createIssue } = useApp()
  const [folders, setFolders] = useState<TestFolder[]>([])
  const [current, setCurrent] = useState<string | null>(null)        // null: every test; '' : not in a folder
  const [picked, setPicked] = useState<string[]>([])
  const editable = canEdit(project)
  const statuses = useTestStatuses()
  const results = useResults(project.key, '')
  const base = `/api/projects/${encodeURIComponent(project.key)}/test-folders`
  const load = () => api<TestFolder[]>('GET', base).then(setFolders, e => toast(message(e), { tone: 'warn' }))
  useEffect(() => { void load() }, [project.key])   // eslint-disable-line react-hooks/exhaustive-deps

  const tests = state.issues.filter(i => i.projectId === project.id && i.type === 'test')
  const shown = current === null ? tests : tests.filter(t => (t.testFolderId ?? '') === current)
  const statusName = (id: string) => project.statuses.find(s => s.id === id)?.name ?? ''
  const children = (parent: string | null) => folders.filter(f => f.parentId === parent)
  const countIn = (id: string) => tests.filter(t => t.testFolderId === id).length

  const addFolder = async (parentId: string | null) => {
    const name = window.prompt('Folder name')?.trim()
    if (!name) return
    try { const f = await api<TestFolder>('POST', base, { name, parentId }); await load(); setCurrent(f.id) } catch (e) { toast(message(e), { tone: 'warn' }) }
  }
  const rename = async (f: TestFolder) => {
    const name = window.prompt('Rename folder', f.name)?.trim()
    if (!name || name === f.name) return
    api('PATCH', `${base}/${f.id}`, { name }).then(load, e => toast(message(e), { tone: 'warn' }))
  }
  const remove = async (f: TestFolder) => {
    if (!window.confirm(`Remove “${f.name}”? Its tests and folders move up a level.`)) return
    try {
      await api('DELETE', `${base}/${f.id}`)
      // the server moved its tests up: do the same here so the list is right without a reload
      dispatch({ type: 'loadIssues', projectId: project.id, issues: state.issues.filter(i => i.projectId === project.id)
        .map(i => (i.testFolderId === f.id ? { ...i, testFolderId: f.parentId ?? undefined } : i)) })
      setCurrent(f.parentId ?? null); await load()
    } catch (e) { toast(message(e), { tone: 'warn' }) }
  }
  const moveTo = (folderId: string) => {
    dispatch({ type: 'updateIssues', ids: tests.filter(t => picked.includes(t.id)).map(t => t.id), patch: { testFolderId: folderId || undefined } })
    toast(`Moved ${plural(picked.length, 'test')}`); setPicked([])
  }
  const Tree = ({ parent, depth }: { parent: string | null; depth: number }) => <>
    {children(parent).map(f => (
      <div key={f.id}>
        <div className={`repo-folder${current === f.id ? ' is-active' : ''}`} style={{ paddingLeft: 8 + depth * 14 }}>
          <button className="repo-folder-name" onClick={() => setCurrent(f.id)}><Folder size={14} />{f.name}<span className="muted sm">{countIn(f.id)}</span></button>
          {editable && <span className="repo-folder-tools">
            <button className="icon-btn sm" onClick={() => addFolder(f.id)} aria-label={`New folder in ${f.name}`} title="New folder inside"><FolderPlus size={13} /></button>
            <button className="icon-btn sm" onClick={() => rename(f)} aria-label={`Rename ${f.name}`} title="Rename"><Pencil size={13} /></button>
            <button className="icon-btn sm" onClick={() => remove(f)} aria-label={`Remove ${f.name}`} title="Remove"><Trash2 size={13} /></button>
          </span>}
        </div>
        <Tree parent={f.id} depth={depth + 1} />
      </div>
    ))}
  </>

  return (
    <div className="repo">
      <nav className="repo-tree" aria-label="Test folders">
        <button className={`repo-folder-name repo-all${current === null ? ' is-active' : ''}`} onClick={() => setCurrent(null)}>All tests<span className="muted sm">{tests.length}</span></button>
        <button className={`repo-folder-name repo-all${current === '' ? ' is-active' : ''}`} onClick={() => setCurrent('')}>Not in a folder<span className="muted sm">{tests.filter(t => !t.testFolderId).length}</span></button>
        <Tree parent={null} depth={0} />
        {editable && <button className="btn btn-ghost btn-sm" onClick={() => addFolder(null)}><FolderPlus size={14} />New folder</button>}
      </nav>
      <div className="repo-list">
        <div className="repo-bar">
          {editable && <button className="btn btn-secondary btn-sm" onClick={() => createIssue({ projectId: project.id, type: 'test', ...(current ? { testFolderId: current } : {}) })}><Plus size={14} />Create test</button>}
          {editable && picked.length > 0 && (
            <select className="input input-sm" aria-label="Move to folder" value="" onChange={e => e.target.value !== '-' && moveTo(e.target.value)}>
              <option value="-">Move {plural(picked.length, 'test')} to…</option>
              <option value="">Not in a folder</option>
              {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          )}
        </div>
        {shown.length === 0 ? <p className="muted sm" style={{ padding: 16 }}>No tests here.</p> : (
          <table className="table">
            <thead><tr>{editable && <th style={{ width: 32 }} />}<th>Key</th><th>Test</th><th>Kind</th><th>Steps</th><th>Status</th><th>Latest result</th></tr></thead>
            <tbody>
              {shown.map(t => (
                <tr key={t.id}>
                  {editable && <td><Checkbox checked={picked.includes(t.id)} label={`Select ${t.key}`} onChange={on => setPicked(on ? [...picked, t.id] : picked.filter(x => x !== t.id))} /></td>}
                  <td><a href={href({ name: 'issue', key: t.key })} className="mono">{t.key}</a></td>
                  <td>{t.title}</td>
                  <td className="muted">{t.testSpec?.kind === 'cucumber' ? 'Cucumber' : t.testSpec?.kind === 'generic' ? 'Generic' : 'Manual'}</td>
                  <td className="muted">{t.testSpec?.kind === 'manual' ? t.testSpec.steps.length : '–'}</td>
                  <td>{statusName(t.status)}</td>
                  <td><ResultLozenge statuses={statuses} status={results.get(t.id)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
