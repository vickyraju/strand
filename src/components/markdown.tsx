import { useRef, useState, type ReactNode } from 'react'
import type { User } from '../data/store'
import { Avatar } from './ui'

// ── Rendering: a safe Markdown subset, built as React nodes (no innerHTML) ──

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s)]+|@[A-Z][\w'-]*(?: [A-Z][\w'-]*)?)/g

function inline(text: string, users: User[], key: string): ReactNode[] {
  return text.split(INLINE).filter(Boolean).map((part, i) => {
    const k = `${key}-${i}`
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) return <code key={k}>{part.slice(1, -1)}</code>
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={k}>{part.slice(2, -2)}</strong>
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={k}>{part.slice(1, -1)}</em>
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/)
    if (link) return <a key={k} href={link[2]} target="_blank" rel="noreferrer noopener">{link[1]}</a>
    if (/^https?:\/\//.test(part)) return <a key={k} href={part} target="_blank" rel="noreferrer noopener">{part}</a>
    if (part.startsWith('@')) {
      const u = users.find(x => part.startsWith(`@${x.name}`) || `@${x.name}`.startsWith(part))
      if (u) return <span key={k} className="mention">@{u.name}</span>
    }
    return part
  })
}

export function Markdown({ text, users }: { text: string; users: User[] }) {
  const lines = text.replace(/\r/g, '').split('\n')
  const out: ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('```')) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++])
      i++
      out.push(<pre key={i}><code>{body.join('\n')}</code></pre>)
      continue
    }
    const h = line.match(/^(#{1,3})\s+(.*)/)
    if (h) { out.push(h[1].length === 1 ? <h3 key={i}>{inline(h[2], users, `h${i}`)}</h3> : <h4 key={i}>{inline(h[2], users, `h${i}`)}</h4>); i++; continue }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line)
      const items: ReactNode[] = []
      while (i < lines.length && (ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/).test(lines[i])) {
        const raw = lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '')
        const task = raw.match(/^\[( |x)\]\s+(.*)/i)
        items.push(<li key={i} className={task ? 'task' : undefined}>
          {task && <input type="checkbox" checked={task[1].toLowerCase() === 'x'} readOnly aria-label="Task" />}
          {inline(task ? task[2] : raw, users, `l${i}`)}
        </li>)
        i++
      }
      out.push(ordered ? <ol key={`ol${i}`}>{items}</ol> : <ul key={`ul${i}`}>{items}</ul>)
      continue
    }
    if (line.startsWith('> ')) { out.push(<blockquote key={i}>{inline(line.slice(2), users, `q${i}`)}</blockquote>); i++; continue }
    if (!line.trim()) { i++; continue }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,3}\s|\s*[-*]\s|\s*\d+\.\s|> )/.test(lines[i])) para.push(lines[i++])
    out.push(<p key={`p${i}`}>{para.flatMap((l, k) => k ? [<br key={`br${k}`} />, ...inline(l, users, `p${i}-${k}`)] : inline(l, users, `p${i}-${k}`))}</p>)
  }
  return <div className="md">{out}</div>
}

// ── Editing: a textarea that suggests people after "@" ──

export function MentionTextarea({ value, onChange, users, onSubmit, ...rest }: {
  value: string; onChange: (v: string) => void; users: User[]; onSubmit?: () => void
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'onSubmit'>) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [query, setQuery] = useState<{ text: string; start: number } | null>(null)
  const [active, setActive] = useState(0)
  const matches = query ? users.filter(u => u.name.toLowerCase().includes(query.text.toLowerCase())).slice(0, 6) : []

  const detect = (v: string, caret: number) => {
    const m = v.slice(0, caret).match(/(^|\s)@([\w' -]{0,20})$/)
    setQuery(m ? { text: m[2], start: caret - m[2].length - 1 } : null)
    setActive(0)
  }

  const insert = (u: User) => {
    if (!query) return
    const el = ref.current!
    const caret = el.selectionStart
    const next = `${value.slice(0, query.start)}@${u.name} ${value.slice(caret)}`
    onChange(next)
    setQuery(null)
    requestAnimationFrame(() => {
      const pos = query.start + u.name.length + 2
      el.focus(); el.setSelectionRange(pos, pos)
    })
  }

  return (
    <div className="mention-wrap">
      <textarea
        ref={ref}
        value={value}
        {...rest}
        onChange={e => { onChange(e.target.value); detect(e.target.value, e.target.selectionStart) }}
        onKeyDown={e => {
          if (query && matches.length) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => (a + 1) % matches.length); return }
            if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(a => (a - 1 + matches.length) % matches.length); return }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insert(matches[active]); return }
            if (e.key === 'Escape') { e.stopPropagation(); setQuery(null); return }
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSubmit) { e.preventDefault(); onSubmit() }
        }}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
      />
      {query && matches.length > 0 && (
        <div className="picker-menu mention-menu" role="listbox" aria-label="Mention someone">
          {matches.map((u, i) => (
            <button key={u.id} type="button" role="option" aria-selected={i === active} className={`picker-item${i === active ? ' focus' : ''}`}
              onMouseDown={e => { e.preventDefault(); insert(u) }}>
              <Avatar user={u} size={20} /><span className="picker-label">{u.name}</span>{u.title && <span className="picker-hint">{u.title}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
