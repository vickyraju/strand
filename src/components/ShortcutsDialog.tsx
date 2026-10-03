import { Modal } from './ui'

const GROUPS: [string, [string, string][]][] = [
  ['Global', [
    ['⌘ K', 'Search or jump to anything'],
    ['C', 'Create a work item'],
    ['G then H', 'Go to Your work'],
    ['G then I', 'Go to Inbox'],
    ['G then P', 'Go to Projects'],
    ['G then S', 'Go to Search'],
    ['?', 'Show keyboard shortcuts'],
  ]],
  ['Work item', [
    ['J / K', 'Next / previous work item'],
    ['Esc', 'Close the side panel'],
    ['⌘ ↵', 'Save a comment or create'],
  ]],
  ['Lists and inbox', [
    ['J / K', 'Move down / up'],
    ['↵', 'Open'],
    ['X', 'Select (lists)'],
    ['E', 'Archive (inbox)'],
  ]],
]

export default function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} width={560}>
      <div className="shortcuts">
        {GROUPS.map(([group, rows]) => (
          <section key={group}>
            <h3 className="section-label">{group}</h3>
            {rows.map(([keys, label]) => (
              <div key={label} className="shortcut-row">
                <span>{label}</span>
                <span>{keys.split(' ').map((k, i) => k === 'then' ? <span key={i} className="muted"> then </span> : <kbd key={i} className="kbd">{k}</kbd>)}</span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Modal>
  )
}
