import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { api, ApiError, errorMessage } from '../api/client'
import { useApp } from '../appContext'
import { ConfirmDialog, LoadError, Loading, Modal, plural } from './ui'
import { PageAction } from './admin/AdminShell'

// Administration › Project categories (spec 0703), as Jira's: system administrators make categories and give each project
// at most one (in its details). Search finds work by category: category = "Name".

interface Category { id: string; name: string; description: string; projects: number }

export default function ProjectCategories() {
  const { toast } = useApp()
  const [rows, setRows] = useState<Category[] | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Category | 'new' | null>(null)
  const [removing, setRemoving] = useState<Category | null>(null)
  const load = () => api<Category[]>('GET', '/api/project-categories').then(setRows, e => setError(errorMessage(e)))
  useEffect(() => { void load() }, [])

  if (error) return <LoadError error={error} onRetry={() => { setError(''); void load() }} />
  if (!rows) return <Loading />
  return (
    <section>
      <PageAction><button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={14} />Add category</button></PageAction>
      {!rows.length ? <p className="muted">No categories yet. Group projects (by department, client or product line) and search across them with category = "Name".</p>
        : <div className="card-table" style={{ marginInline: 0 }}>
          <table className="table">
            <thead><tr><th>Name</th><th>Description</th><th className="col-num">Projects</th><th /></tr></thead>
            <tbody>
              {rows.map(c => (
                <tr key={c.id} onClick={() => setEditing(c)}>
                  <td className="strong">{c.name}</td><td className="muted">{c.description}</td><td className="col-num">{c.projects}</td>
                  <td style={{ textAlign: 'right' }}><button className="icon-btn sm" aria-label={`Delete ${c.name}`} onClick={e => { e.stopPropagation(); setRemoving(c) }}><Trash2 size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>}
      {editing && <Editor category={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load() }} />}
      {removing && <ConfirmDialog title={`Delete “${removing.name}”?`} action="Delete" onClose={() => setRemoving(null)}
        onConfirm={async () => { await api('DELETE', `/api/admin/project-categories/${removing.id}`); toast(`${removing.name} deleted`); setRemoving(null); void load() }}>
        <p>{removing.projects ? `${plural(removing.projects, 'project')} will have no category. Their work stays as it is.` : 'No project is in it.'}</p>
      </ConfirmDialog>}
    </section>
  )
}

function Editor({ category, onClose, onSaved }: { category: Category | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: category?.name ?? '', description: category?.description ?? '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const save = async () => {
    try {
      if (category) await api('PATCH', `/api/admin/project-categories/${category.id}`, f)
      else await api('POST', '/api/admin/project-categories', f)
      onSaved()
    } catch (e) { setErrors(e instanceof ApiError ? { ...e.errors, '': e.message } : { '': errorMessage(e) }) }
  }
  return (
    <Modal title={category ? `Edit ${category.name}` : 'Add a project category'} onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!f.name.trim()} onClick={() => void save()}>{category ? 'Save' : 'Add'}</button>
    </>}>
      <form onSubmit={e => { e.preventDefault(); if (f.name.trim()) void save() }}>
        {errors[''] && <p role="alert" className="text-danger" style={{ marginBottom: 10 }}>{errors['']}</p>}
        <label className="label" htmlFor="pc-name">Name</label>
        <input id="pc-name" className="input" maxLength={100} autoFocus value={f.name} onChange={e => setF({ ...f, name: e.target.value })} aria-invalid={!!errors.name} />
        {errors.name && <p className="hint error">{errors.name}</p>}
        <label className="label" htmlFor="pc-desc" style={{ marginTop: 12 }}>Description</label>
        <textarea id="pc-desc" className="input" rows={3} maxLength={1000} value={f.description} onChange={e => setF({ ...f, description: e.target.value })} />
      </form>
    </Modal>
  )
}
