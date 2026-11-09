import { useState } from 'react'
import { api, ApiError, errorMessage } from '../../api/client'
import { useApp } from '../../appContext'
import { Modal } from '../ui'

// Local users (spec 0714), as Jira's internal directory: Create user, and Edit / Set password for someone in it.

export interface LocalPerson { id: string; name: string; email: string; username?: string | null; active: boolean; hasPassword?: boolean }
type Errors = Record<string, string>
const errorsOf = (e: unknown): Errors => (e instanceof ApiError ? { ...e.errors, '': e.message } : { '': errorMessage(e) })

function Field({ id, label, value, onChange, errors, hint, type = 'text', autoFocus }: {
  id: string; label: string; value: string; onChange: (v: string) => void; errors: Errors; hint?: string; type?: string; autoFocus?: boolean
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label className="label" htmlFor={`lu-${id}`}>{label}</label>
      <input id={`lu-${id}`} className="input" type={type} value={value} onChange={e => onChange(e.target.value)} aria-invalid={!!errors[id]}
        autoComplete={type === 'password' ? 'new-password' : 'off'} autoFocus={autoFocus} />
      {errors[id] ? <p className="hint error">{errors[id]}</p> : hint && <p className="hint">{hint}</p>}
    </div>
  )
}

/** Jira's Create user: Username, Password, Full name, Email, Send notification email, Create another. */
export function CreateUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { toast } = useApp()
  const empty = { username: '', name: '', email: '', password: '' }
  const [f, setF] = useState(empty)
  const [notify, setNotify] = useState(false)
  const [another, setAnother] = useState(false)
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true); setErrors({})
    try {
      const r = await api<{ id: string; emailed: boolean }>('POST', '/api/admin/users', { username: f.username, name: f.name, email: f.email, ...(f.password ? { password: f.password } : {}), notify })
      toast(`${f.name} created${notify ? (r.emailed ? ': the email is on its way' : ', but the email couldn’t be sent') : ''}`, r.emailed || !notify ? undefined : { tone: 'warn' })
      onCreated()
      if (another) setF(empty); else onClose()
    } catch (e) { setErrors(errorsOf(e)) } finally { setBusy(false) }
  }
  const set = (k: keyof typeof empty) => (v: string) => setF({ ...f, [k]: v })
  return (
    <Modal title="Create user" onClose={onClose} footer={<>
      <label className="check-row inline" style={{ marginRight: 'auto' }}><input type="checkbox" checked={another} onChange={e => setAnother(e.target.checked)} />Create another</label>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !f.username || !f.name || !f.email} onClick={() => void submit()}>Create user</button>
    </>}>
      <form onSubmit={e => { e.preventDefault(); void submit() }}>
        {errors[''] && <p role="alert" className="text-danger" style={{ marginBottom: 10 }}>{errors['']}</p>}
        <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>A person in Strand’s internal directory. People from your company directory or Microsoft sign in without being created here.</p>
        <Field id="email" label="Email" value={f.email} onChange={set('email')} errors={errors} type="email" autoFocus />
        <Field id="name" label="Full name" value={f.name} onChange={set('name')} errors={errors} />
        <Field id="username" label="Username" value={f.username} onChange={set('username')} errors={errors} hint="What they type on the login form" />
        <Field id="password" label="Password" value={f.password} onChange={set('password')} errors={errors} type="password" hint="Leave empty to send them a link to set it" />
        <label className="check-row"><input type="checkbox" checked={notify} onChange={e => setNotify(e.target.checked)} />Send notification email (their username and a link to set the password, valid 24 hours)</label>
        {errors.notify && <p className="hint error">{errors.notify}</p>}
      </form>
    </Modal>
  )
}

/** Jira's Edit (username, full name, email, active) and Set password, for someone in the internal directory. */
export function EditUserDialog({ person, onClose, onSaved }: { person: LocalPerson; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp()
  const [f, setF] = useState({ username: person.username ?? '', name: person.name, email: person.email, active: person.active })
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true); setErrors({})
    try {
      const patch = {
        ...(f.username && f.username !== (person.username ?? '') ? { username: f.username } : {}), ...(f.name !== person.name ? { name: f.name } : {}),
        ...(f.email !== person.email ? { email: f.email } : {}), ...(f.active !== person.active ? { active: f.active } : {}),
      }
      if (Object.keys(patch).length) await api('PATCH', `/api/admin/users/${person.id}`, patch)
      if (password) await api('PUT', `/api/admin/users/${person.id}/password`, { password })
      toast(`${f.name} saved${password ? ': new password set, their sign-ins ended' : ''}`)
      onSaved(); onClose()
    } catch (e) { setErrors(errorsOf(e)) } finally { setBusy(false) }
  }
  return (
    <Modal title={`Edit ${person.name}`} onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !f.name || !f.email} onClick={() => void save()}>Update</button>
    </>}>
      <form onSubmit={e => { e.preventDefault(); void save() }}>
        {errors[''] && <p role="alert" className="text-danger" style={{ marginBottom: 10 }}>{errors['']}</p>}
        <Field id="username" label="Username" value={f.username} onChange={v => setF({ ...f, username: v })} errors={errors} hint={person.username ? undefined : 'None yet: they sign in with Microsoft. Give one to let them use the login form.'} />
        <Field id="name" label="Full name" value={f.name} onChange={v => setF({ ...f, name: v })} errors={errors} />
        <Field id="email" label="Email" value={f.email} onChange={v => setF({ ...f, email: v })} errors={errors} type="email" />
        <label className="check-row"><input type="checkbox" checked={f.active} onChange={e => setF({ ...f, active: e.target.checked })} />Active</label>
        <h3 className="dir-section">Set password</h3>
        <Field id="password" label="New password" value={password} onChange={setPassword} errors={errors} type="password"
          hint={person.hasPassword ? 'Leave empty to keep their password. A new one ends their login-form sign-ins.' : 'They have no password in Strand yet.'} />
      </form>
    </Modal>
  )
}
