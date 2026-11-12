// Attachments on the server: the file goes straight from the browser to storage through a short-lived upload URL,
// then the server checks it arrived. Only then does the attachment show for everyone.
import { api } from './client'
import { issueSync } from './sync'
import type { Attachment, Issue } from '../data/reducer'


export async function uploadAttachment(issue: Issue, file: File): Promise<Attachment> {
  const type = file.type || 'application/octet-stream'
  const t = await api<{ id: string; uploadUrl: string }>('POST', `/api/issues/${encodeURIComponent(issueSync.serverKey(issue))}/attachments`,
    { name: file.name, size: file.size, type })
  const put = await fetch(t.uploadUrl, { method: 'PUT', body: file, headers: { 'content-type': type } })
  if (!put.ok) throw new Error(`the upload failed (${put.status})`)
  const a = await api<{ id: string; name: string; size: number; type: string; addedBy: string | null; addedAt: string }>('POST', `/api/attachments/${t.id}/complete`)
  return { id: a.id, name: a.name, size: a.size, type: a.type, addedBy: a.addedBy ?? '', addedAt: Date.parse(a.addedAt) }
}

/** A download link that works for a few minutes. */
export const attachmentUrl = (id: string) => api<{ url: string }>('GET', `/api/attachments/${id}/url`).then(r => r.url)

export const deleteAttachment = (id: string) => api<void>('DELETE', `/api/attachments/${id}`)
