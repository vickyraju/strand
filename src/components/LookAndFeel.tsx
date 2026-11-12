import { useState } from 'react'
import { api, ApiError, errorMessage } from '../api/client'
import { imageUrl, setLook, useLook, type Look } from '../api/look'
import { useApp } from '../appContext'
import { brandReadable, contrast } from '../../server/src/shared/brand.ts'
import { ConfirmDialog, Toggle } from './ui'

// System settings › Look and feel (spec 0702): the site title, logo, favicon and brand colour, with Reset defaults.

/** The uploadable images (spec 0702; mark: the collapsed menu's logo, spec 0719). */
type Which = 'logo' | 'favicon' | 'mark'
export default function LookAndFeel() {
  const { toast } = useApp()
  const look = useLook()
  const [draft, setDraft] = useState({ siteTitle: look.siteTitle, showTitle: look.showTitle, brandColor: look.brandColor })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [resetting, setResetting] = useState(false)
  const done = (l: Look, what: string) => { setLook(l); setDraft({ siteTitle: l.siteTitle, showTitle: l.showTitle, brandColor: l.brandColor }); toast(what) }
  const fail = (e: unknown) => { if (e instanceof ApiError && e.errors) setErrors(e.errors); toast(errorMessage(e), { tone: 'warn' }) }
  const dirty = draft.siteTitle !== look.siteTitle || draft.showTitle !== look.showTitle || draft.brandColor.toUpperCase() !== look.brandColor
  const valid = /^#[0-9a-fA-F]{6}$/.test(draft.brandColor)
  const readable = valid && brandReadable(draft.brandColor)

  const upload = (which: Which, label: string, file: File) => {
    const r = new FileReader()
    r.onload = () => api<Look>('PUT', `/api/admin/look-and-feel/${which}`, { image: String(r.result) }).then(l => done(l, `${label} saved`), fail)
    r.readAsDataURL(file)
  }
  const image = (which: Which, label: string, hint: string) => (
    <div className="settings-row">
      <span className="settings-label">{label}<span className="muted sm">{hint}</span></span>
      {look[which] ? <img src={imageUrl(look[which])!} alt={`Current ${label.toLowerCase()}`} className={which === 'logo' ? 'site-logo' : which === 'mark' ? 'site-mark' : 'favicon-preview'} />
        : <span className="muted sm">{which === 'mark' ? 'The favicon, else Jira Build POC’s' : 'Jira Build POC’s own'}</span>}
      <label className="btn btn-secondary btn-sm">Upload…<input type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label={`Upload ${label.toLowerCase()}`}
        onChange={e => { const f = e.target.files?.[0]; if (f) upload(which, label, f); e.target.value = '' }} /></label>
      {look[which] && <button className="btn btn-ghost btn-sm" onClick={() => api<Look>('DELETE', `/api/admin/look-and-feel/${which}`).then(l => done(l, `${label} removed`), fail)}>Remove</button>}
    </div>
  )

  return (
    <section className="panel" aria-label="Look and feel">
      <h2 className="panel-title">Look and feel</h2>
      <p className="muted">The site’s title, logo, favicon and colour, for everyone and on the login page.</p>
      <div className="settings-grid">
        <label className="settings-row">
          <span className="settings-label">Site title<span className="muted sm">In the browser tab, the menu and the login page</span></span>
          <input className="input" style={{ width: 240 }} maxLength={60} value={draft.siteTitle} onChange={e => setDraft({ ...draft, siteTitle: e.target.value })} aria-invalid={!!errors.siteTitle} />
        </label>
        <div className="settings-row">
          <span className="settings-label">Show site title next to logo</span>
          <Toggle on={draft.showTitle} label="Show site title next to logo" onChange={v => setDraft({ ...draft, showTitle: v })} />
        </div>
        <div className="settings-row">
          <span className="settings-label">Brand colour<span className="muted sm">Buttons, links and selection. White text on it must be readable.</span></span>
          <input type="color" aria-label="Brand colour picker" value={valid ? draft.brandColor : '#368727'} onChange={e => setDraft({ ...draft, brandColor: e.target.value.toUpperCase() })} />
          <input className="input mono" style={{ width: 100 }} aria-label="Brand colour" value={draft.brandColor} onChange={e => setDraft({ ...draft, brandColor: e.target.value })} aria-invalid={!readable} />
          {valid && <span className="brand-sample" style={{ background: draft.brandColor }}>Sample button</span>}
          {valid && !readable && <span className="hint error">Too light for white text (contrast {contrast(draft.brandColor, '#FFFFFF').toFixed(1)} to 1; at least 4.5)</span>}
          {errors.brandColor && <span className="hint error">{errors.brandColor}</span>}
        </div>
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn btn-primary" disabled={!dirty || !readable || !draft.siteTitle.trim()}
          onClick={() => { setErrors({}); api<Look>('PUT', '/api/admin/look-and-feel', draft).then(l => done(l, 'Look and feel saved'), fail) }}>Save</button>
        {dirty && <button className="btn btn-ghost" onClick={() => setDraft({ siteTitle: look.siteTitle, showTitle: look.showTitle, brandColor: look.brandColor })}>Discard changes</button>}
      </div>
      <div className="settings-grid" style={{ marginTop: 18 }}>
        {image('logo', 'Logo', 'PNG, JPEG or WebP, up to 256 KB; shown 26 px high')}
        {image('favicon', 'Favicon', 'PNG, JPEG or WebP, up to 64 KB; square works best')}
        {image('mark', 'Collapsed menu logo', 'Shown when the menu is collapsed; PNG, JPEG or WebP, up to 64 KB; square works best')}
      </div>
      <div className="btn-row" style={{ marginTop: 18 }}>
        <button className="btn btn-secondary" onClick={() => setResetting(true)}>Reset defaults</button>
      </div>
      {resetting && <ConfirmDialog title="Reset the look and feel?" action="Reset defaults" onClose={() => setResetting(false)}
        onConfirm={async () => { const l = await api<Look>('DELETE', '/api/admin/look-and-feel'); done(l, 'Back to Jira Build POC’s look'); setResetting(false) }}>
        <p>Jira Build POC’s title, logomark, favicon and green come back. Your logo and favicon are removed.</p>
      </ConfirmDialog>}
    </section>
  )
}
