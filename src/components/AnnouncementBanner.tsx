import { useState } from 'react'
import { Megaphone, X } from 'lucide-react'
import { announcementParts, fingerprint } from '../data/announcement'

const CLOSED = 'jira-build:announcement-closed'

/** The announcement banner (spec 0701): plain text with links; closed in this browser until it changes. */
export default function AnnouncementBanner({ text, preview }: { text: string; preview?: boolean }) {
  const print = fingerprint(text)
  // the fingerprint closed last (the text can arrive after the first render, so it is compared on every render)
  const [closedPrint, setClosedPrint] = useState(() => localStorage.getItem(CLOSED))
  if (!text.trim() || (!preview && closedPrint === print)) return null
  return (
    <div className="announcement" role="region" aria-label="Announcement">
      <Megaphone size={15} className="announcement-icon" aria-hidden />
      <p className="announcement-text">
        {announcementParts(text).map((p, i) => ('href' in p
          ? <a key={i} href={p.href} target="_blank" rel="noopener noreferrer">{p.href}</a>
          : <span key={i}>{p.text}</span>))}
      </p>
      {!preview && <button className="icon-btn sm" aria-label="Close the announcement" onClick={() => { localStorage.setItem(CLOSED, print); setClosedPrint(print) }}><X size={14} /></button>}
    </div>
  )
}
