import { useRef, useState } from 'react'
import { Paperclip, Download, Trash2, FileText, Upload } from 'lucide-react'
import { useStore, uid, userOf, timeAgo, type Issue } from '../data/store'
import { fileUrl, saveFile, readAsDataUrl, usedBytes, formatBytes, MAX_FILE, MAX_TOTAL } from '../data/files'
import { useApp } from '../appContext'

/** Attachments section on a work item: add by button or drop, preview images, download, remove. */
export default function Attachments({ issue, pickRef }: { issue: Issue; pickRef?: React.RefObject<HTMLInputElement | null> }) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const ownRef = useRef<HTMLInputElement>(null)
  const input = pickRef ?? ownRef
  const [over, setOver] = useState(false)

  const add = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (file.size > MAX_FILE) { toast(`${file.name} is larger than ${formatBytes(MAX_FILE)}`, { tone: 'warn' }); continue }
      if (usedBytes() + file.size > MAX_TOTAL) { toast(`Storage is full (${formatBytes(MAX_TOTAL)} per browser). Remove attachments to add more.`, { tone: 'warn' }); return }
      const id = uid()
      try {
        saveFile(id, await readAsDataUrl(file))
      } catch {
        toast('This browser ran out of storage for attachments', { tone: 'warn' }); return
      }
      dispatch({ type: 'addAttachment', issueId: issue.id, attachment: {
        id, name: file.name, size: file.size, type: file.type || 'application/octet-stream', addedBy: state.me?.id ?? '', addedAt: Date.now(),
      } })
    }
  }

  return (
    <section className={`detail-section attach${over ? ' drop-over' : ''}`}
      onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true) } }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false) }}
      onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); setOver(false); add(e.dataTransfer.files) } }}>
      <div className="section-title-row">
        <h3 className="section-title">Attachments {issue.attachments.length > 0 && <span className="count-pill">{issue.attachments.length}</span>}</h3>
        <div style={{ flex: 1 }} />
        <button className="icon-btn sm" onClick={() => input.current?.click()} title="Attach files" aria-label="Attach files"><Paperclip size={15} /></button>
        <input ref={input} type="file" multiple hidden onChange={e => { if (e.target.files) add(e.target.files); e.target.value = '' }} />
      </div>
      {issue.attachments.length === 0 ? (
        <button className="attach-drop" onClick={() => input.current?.click()}>
          <Upload size={16} />Drop files here or <span className="link">browse</span><span className="muted sm">Up to {formatBytes(MAX_FILE)} each</span>
        </button>
      ) : (
        <div className="attach-grid">
          {issue.attachments.map(a => {
            const url = fileUrl(a.id)
            const image = a.type.startsWith('image/') && url
            return (
              <div key={a.id} className="attach-card">
                <a className="attach-preview" href={url} download={a.name} title={`Download ${a.name}`}>
                  {image ? <img src={url} alt={a.name} /> : <FileText size={26} strokeWidth={1.5} />}
                </a>
                <div className="attach-meta">
                  <span className="attach-name" title={a.name}>{a.name}</span>
                  <span className="muted sm">{formatBytes(a.size)} · {userOf(state, a.addedBy)?.name ?? 'Someone'} · {timeAgo(a.addedAt)}</span>
                </div>
                <div className="attach-actions">
                  {url && <a className="icon-btn sm" href={url} download={a.name} aria-label={`Download ${a.name}`} title="Download"><Download size={14} /></a>}
                  <button className="icon-btn sm" onClick={() => dispatch({ type: 'removeAttachment', issueId: issue.id, attachmentId: a.id })} aria-label={`Remove ${a.name}`} title="Remove"><Trash2 size={14} /></button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
