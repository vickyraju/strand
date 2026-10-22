import { useEffect, useState } from 'react'
import { Copy, KeyRound, Plus, Trash2 } from 'lucide-react'
import { useApp } from '../appContext'
import { API_URL, ApiError } from '../api/client'
import {
  DEFAULT_EXPIRY_DAYS, EXPIRY_CHOICES, MAX_ACTIVE_TOKENS, activeCount, createToken, curlExample, listTokens, revokeToken, tokenStatus,
  type AccessToken, type CreatedToken,
} from '../api/tokens'
import { Modal } from './ui'

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Could not reach the server.')

/** Settings > Personal access tokens (API mode only): create, see and revoke the tokens that let scripts call the API as you. */
export default function AccessTokens() {
  const { toast } = useApp()
  const [tokens, setTokens] = useState<AccessToken[] | null>(null)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [days, setDays] = useState<number>(DEFAULT_EXPIRY_DAYS)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<CreatedToken | null>(null)   // the secret, held only until the dialog is closed
  const [revoking, setRevoking] = useState<AccessToken | null>(null)

  const load = () => listTokens().then(t => { setTokens(t); setError('') }, e => setError(message(e)))
  useEffect(() => { void load() }, [])

  const atLimit = tokens ? activeCount(tokens) >= MAX_ACTIVE_TOKENS : false

  const create = async () => {
    setBusy(true); setError('')
    try {
      setCreated(await createToken(name.trim(), days))
      setName('')
      await load()
    } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }

  const revoke = async (t: AccessToken) => {
    setRevoking(null)
    try { await revokeToken(t.id); toast(`Revoked “${t.name}”`); await load() } catch (e) { setError(message(e)) }
  }

  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Copy failed: select the text and copy it', { tone: 'warn' }))

  return (
    <section className="panel" id="tokens">
      <h2 className="panel-title">Personal access tokens</h2>
      <p className="muted">Let a script or integration call the API as you. A token has your permissions and stops working when it expires or when you revoke it. Treat it like a password.</p>

      {error && <p role="alert" className="hint error">{error}</p>}

      {tokens && tokens.length > 0 && (
        <table className="table" style={{ marginTop: 12 }}>
          <thead><tr><th>Name</th><th>Token</th><th>Created</th><th>Expires</th><th>Last used</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {tokens.map(t => {
              const status = tokenStatus(t)
              return (
                <tr key={t.id}>
                  <td className="strong">{t.name}</td>
                  <td className="mono">jbp_…{t.hint}</td>
                  <td>{day(t.createdAt)}</td>
                  <td>
                    {day(t.expiresAt)}{' '}
                    {status === 'expires-soon' && <span className="lozenge lozenge-todo">Expires soon</span>}
                    {status === 'expired' && <span className="lozenge lozenge-overdue">Expired</span>}
                  </td>
                  <td className="muted">{t.lastUsedAt ? day(t.lastUsedAt) : 'Never'}</td>
                  <td><button className="icon-btn" onClick={() => setRevoking(t)} aria-label={`Revoke ${t.name}`} title="Revoke"><Trash2 size={14} /></button></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {tokens && tokens.length === 0 && <p className="muted" style={{ marginTop: 12 }}>You have no tokens yet.</p>}

      <form className="form-row" style={{ marginTop: 14, alignItems: 'flex-end' }} onSubmit={e => { e.preventDefault(); if (name.trim() && !atLimit) void create() }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <label className="label" htmlFor="tok-name">Token name</label>
          <input id="tok-name" className="input" value={name} maxLength={40} onChange={e => setName(e.target.value)} placeholder="e.g. Release script" />
        </div>
        <div>
          <label className="label" htmlFor="tok-days">Expires after</label>
          <select id="tok-days" className="input" value={days} onChange={e => setDays(Number(e.target.value))}>
            {EXPIRY_CHOICES.map(d => <option key={d} value={d}>{d === 365 ? '1 year' : `${d} days`}</option>)}
          </select>
        </div>
        <button type="submit" className="btn btn-primary" disabled={!name.trim() || busy || atLimit}><Plus size={15} />Create token</button>
      </form>
      {atLimit && <p className="hint">You have {MAX_ACTIVE_TOKENS} active tokens, the most allowed. Revoke one to create another.</p>}

      {created && (
        <Modal title="Your new token" onClose={() => setCreated(null)}
          footer={<button className="btn btn-primary" onClick={() => setCreated(null)}>Done</button>}>
          <div className="callout callout-warn"><KeyRound size={16} /><span>Copy this token now. For your security it can’t be shown again.</span></div>
          <label className="label" htmlFor="tok-secret" style={{ marginTop: 12 }}>{created.name}</label>
          <div className="form-row" style={{ flexWrap: 'nowrap' }}>
            <input id="tok-secret" className="input mono" style={{ flex: 1, minWidth: 0 }} readOnly value={created.token} onFocus={e => e.currentTarget.select()} />
            <button className="btn btn-secondary" style={{ flexShrink: 0 }} onClick={() => copy(created.token)}><Copy size={14} />Copy</button>
          </div>
          <p className="hint">Expires {day(created.expiresAt)}. Try it:</p>
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginTop: 4 }}>{curlExample(API_URL ?? '', created.token)}</pre>
        </Modal>
      )}

      {revoking && (
        <Modal title={`Revoke “${revoking.name}”?`} onClose={() => setRevoking(null)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setRevoking(null)}>Cancel</button>
            <button className="btn btn-danger" onClick={() => void revoke(revoking)}>Revoke</button>
          </>}>
          <p>Anything using this token stops working immediately. This can’t be undone.</p>
        </Modal>
      )}
    </section>
  )
}
