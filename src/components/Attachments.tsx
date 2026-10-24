import { useEffect, useRef, useState } from 'react'
import { Paperclip, Download, Trash2, FileText, Upload } from 'lucide-react'
import { useStore, uid, userOf, timeAgo, type Issue } from '../data/store'
import type { Attachment } from '../data/reducer'
import { fileUrl, saveFile, readAsDataUrl, usedBytes, formatBytes, MAX_FILE, MAX_TOTAL } from '../data/files'
import { apiEnabled, ApiError } from '../api/client'
import { attachmentUrl, deleteAttachment, uploadAttachment } from '../api/attachments'
import { usePublicSettings } from '../api/settings-public'
import { useApp } from '../appContext'

const failure = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : 'something went wrong')

/** Attachments section on a work item: add by button or drop, preview images, download, remove.
 *  With a server the files live in its storage and everyone with access sees them; without one they stay in this browser. */
export default function Attachments({ issue, pickRef }: { issue: Issue; pickRef?: React.RefObject<HTMLInputElement | null> }) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const ownRef = useRef<HTMLInputElement>(null)
  const input = pickRef ?? ownRef
  const [over, setOver] = useState(false)
  const [uploading, setUploading] = useState<string[]>([])
  const policy = usePublicSettings().attachments   // System settings
  const maxFile = apiEnabled ? policy.maxSizeMb * 1024 * 1024 : MAX_FILE

  const add = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (file.size > maxFile) { toast(`${file.name} is larger than ${formatBytes(maxFile)}`, { tone: 'warn' }); continue }
      if (apiEnabled) {
        setUploading(u => [...u, file.name])
        try {
          dispatch({ type: 'addAttachment', issueId: issue.id, attachment: await uploadAttachment(issue, file) })
        } catch (e) {
          toast(`Couldn't attach ${file.name}: ${failure(e)}`, { tone: 'warn' })
        } finally { setUploading(u => u.filter(n => n !== file.name)) }
        continue
      }
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

  const remove = async (a: Attachment) => {
    if (apiEnabled) {
      try { await deleteAttachment(a.id) } catch (e) { toast(`Couldn't remove ${a.name}: ${failure(e)}`, { tone: 'warn' }); return }
      dispatch({ type: 'removeAttachment', issueId: issue.id, attachmentId: a.id })
      toast(`Removed ${a.name}`)
      return
    }
    dispatch({ type: 'removeAttachment', issueId: issue.id, attachmentId: a.id }); toast(`Removed ${a.name}`, { undo: 'removeAttachment' })
  }

  const download = async (a: Attachment) => {
    try { window.location.assign(await attachmentUrl(a.id)) }   // the link answers with "attachment", so the page stays put
    catch (e) { toast(`Couldn't download ${a.name}: ${failure(e)}`, { tone: 'warn' }) }
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
      {uploading.length > 0 && <p className="muted sm" role="status">Uploading {uploading.join(', ')}…</p>}
      {issue.attachments.length === 0 && !uploading.length ? (
        <button className="attach-drop" onClick={() => input.current?.click()}>
          <Upload size={16} />Drop files here or <span className="link">browse</span><span className="muted sm">Up to {formatBytes(maxFile)} each</span>
        </button>
      ) : (
        <div className="attach-grid">
          {issue.attachments.map(a => (
            <div key={a.id} className="attach-card">
              <Preview a={a} onDownload={() => download(a)} />
              <div className="attach-meta">
                <span className="attach-name" title={a.name}>{a.name}</span>
                <span className="muted sm">{formatBytes(a.size)} · {userOf(state, a.addedBy)?.name ?? 'Someone'} · {timeAgo(a.addedAt)}</span>
              </div>
              <div className="attach-actions">
                {apiEnabled
                  ? <button className="icon-btn sm" onClick={() => download(a)} aria-label={`Download ${a.name}`} title="Download"><Download size={14} /></button>
                  : fileUrl(a.id) && <a className="icon-btn sm" href={fileUrl(a.id)} download={a.name} aria-label={`Download ${a.name}`} title="Download"><Download size={14} /></a>}
                <button className="icon-btn sm" onClick={() => remove(a)} aria-label={`Remove ${a.name}`} title="Remove"><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/** Thumbnail for images, an icon for anything else. With a server, an image's short-lived link is fetched when shown. */
function Preview({ a, onDownload }: { a: Attachment; onDownload: () => void }) {
  const image = a.type.startsWith('image/')
  const [url, setUrl] = useState(apiEnabled ? undefined : fileUrl(a.id))
  useEffect(() => {
    if (!apiEnabled || !image) return
    let live = true
    attachmentUrl(a.id).then(u => { if (live) setUrl(u) }, () => {})
    return () => { live = false }
  }, [a.id, image])
  const body = image && url ? <img src={url} alt={a.name} /> : <FileText size={26} strokeWidth={1.5} />
  return apiEnabled
    ? <button className="attach-preview" onClick={onDownload} title={`Download ${a.name}`}>{body}</button>
    : <a className="attach-preview" href={url} download={a.name} title={`Download ${a.name}`}>{body}</a>
}
