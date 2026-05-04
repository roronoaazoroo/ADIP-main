// ============================================================
// FILE: src/components/MultiSelectDropdown.jsx
// ROLE: Reusable searchable checkbox dropdown
//
// Props:
//   options    — [{ value, label }]
//   selected   — string[] of selected values
//   onChange   — (selected: string[]) => void
//   placeholder — string
// ============================================================
import React, { useState, useRef, useEffect } from 'react'

export default function MultiSelectDropdown({ options, selected, onChange, placeholder = 'Select...', singleSelect = false }) {
  const [search, setSearch] = useState('')
  const [open,   setOpen]   = useState(false)
  const containerRef = useRef(null)
  const inputRef = useRef(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Focus input when opened
  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus()
    }
  }, [open])

  const filtered = options.filter(o => o.label.toLowerCase().includes(search.toLowerCase()))

  const toggle = (value) => {
    if (singleSelect) {
      onChange([value])
      setOpen(false)
    } else {
      onChange(selected.includes(value) ? selected.filter(v => v !== value) : [...selected, value])
    }
  }

  const summary = selected.length === 0 ? placeholder
    : selected.length === 1 ? (options.find(o => o.value === selected[0])?.label || selected[0])
    : `${selected.length} selected`

  return (
    <div style={{ position: 'relative' }} ref={containerRef}>
      <button type="button" className="ds-filter-select" onClick={() => setOpen(o => !o)}
        style={{ width: '100%', textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>
      </button>

      <div style={{
        position: 'absolute', zIndex: 100, background: '#fff',
        border: '1px solid rgba(0,0,0,0.06)', borderRadius: 14, width: '100%', marginTop: 8,
        boxShadow: '0 4px 20px rgba(0,51,89,0.08)',
        maxHeight: 260, overflow: 'hidden', display: 'flex', flexDirection: 'column',
        opacity: open ? 1 : 0,
        visibility: open ? 'visible' : 'hidden',
        transform: open ? 'translateY(0) scale(1)' : 'translateY(-8px) scale(0.98)',
        transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
        pointerEvents: open ? 'auto' : 'none',
        transformOrigin: 'top center'
      }}>
        <input ref={inputRef} className="ds-filter-select" placeholder="Search..."
          value={search} onChange={e => setSearch(e.target.value)}
          style={{ borderRadius: '14px 14px 0 0', borderBottom: '1px solid rgba(0,0,0,0.06)', height: 48, boxShadow: 'none', backgroundImage: 'none' }} />
        <div style={{ overflowY: 'auto', maxHeight: 200 }}>
          {filtered.length === 0 && (
            <div style={{ padding: '8px 16px', color: '#64748b', fontSize: 13 }}>No matches</div>
          )}
          {filtered.map(o => (
            <label key={o.value} style={{ display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 16px', cursor: 'pointer', fontSize: 13, color: '#1a1c1e',
              background: selected.includes(o.value) ? 'rgba(0,96,169,0.06)' : 'transparent',
              borderBottom: '1px solid rgba(0,0,0,0.02)' }}>
              {!singleSelect && (
                <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)}
                  style={{ accentColor: '#0060a9', width: 16, height: 16, cursor: 'pointer' }} />
              )}
              {singleSelect && (
                 <input type="radio" checked={selected.includes(o.value)} onChange={() => toggle(o.value)}
                  style={{ display: 'none' }} />
              )}
              <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: selected.includes(o.value) ? 600 : 400 }}>{o.label}</span>
              {singleSelect && selected.includes(o.value) && (
                <span className="material-symbols-outlined" style={{ color: '#0060a9', fontSize: 16 }}>check</span>
              )}
            </label>
          ))}
        </div>
        {!singleSelect && selected.length > 0 && (
          <button onClick={() => onChange([])}
            style={{ padding: '10px 16px', fontSize: 13, color: '#ef4444', background: '#f9f9fc',
              border: 'none', borderTop: '1px solid rgba(0,0,0,0.06)', cursor: 'pointer', textAlign: 'left', fontWeight: 600 }}>
            Clear all
          </button>
        )}
      </div>
    </div>
  )
}
