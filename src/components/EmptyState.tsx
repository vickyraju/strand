import { LayoutGrid } from 'lucide-react'

export default function EmptyState() {
  return (
    <div style={{
      flex:            1,
      display:         'flex',
      flexDirection:   'column',
      alignItems:      'center',
      justifyContent:  'center',
      gap:             12,
      background:      '#FAFAF9',
      overflow:        'hidden',
      userSelect:      'none',
    }}>
      <div style={{
        width:           40,
        height:          40,
        borderRadius:    10,
        background:      '#F5F5F4',
        border:          '1px solid #E7E5E4',
        display:         'flex',
        alignItems:      'center',
        justifyContent:  'center',
      }}>
        <LayoutGrid size={18} color="#A8A29E" strokeWidth={1.5} />
      </div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 15, fontWeight: 500, color: '#1C1917', marginBottom: 4 }}>
          Select a view
        </div>
        <div style={{ fontSize: 13, color: '#A8A29E', maxWidth: 240, lineHeight: 1.6 }}>
          Choose a project or view from the navigation to get started.
        </div>
      </div>
    </div>
  )
}
