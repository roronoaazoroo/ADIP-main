// ============================================================
// FILE: src/components/ViewModeToggle.jsx
// ROLE: CTO/Dev toggle pill — placed in NavBar
// ============================================================
import React from 'react'
import { useViewMode } from '../context/ViewModeContext'

export default function ViewModeToggle() {
  const { viewMode, setViewMode } = useViewMode()
  const isCto = viewMode === 'cto'

  return (
    <div
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        background: '#f1f5f9',
        borderRadius: '999px',
        padding: '3px',
        border: '1px solid #e2e8f0',
        boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.04)',
      }}
    >
      {/* Sliding Highlight */}
      <div
        style={{
          position: 'absolute',
          top: '3px',
          left: '3px',
          height: 'calc(100% - 6px)',
          width: '50px',
          background: '#ffffff',
          borderRadius: '999px',
          boxShadow: '0 2px 6px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
          transform: isCto ? 'translateX(0)' : 'translateX(50px)',
          transition: 'transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
          zIndex: 1,
        }}
      />
      
      {/* CTO Button */}
      <button
        onClick={() => setViewMode('cto')}
        aria-pressed={isCto}
        title="Executive view — plain English summaries"
        style={{
          position: 'relative',
          zIndex: 2,
          width: '50px',
          padding: '5px 0',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: '11px',
          fontWeight: 700,
          color: isCto ? '#003359' : '#94a3b8',
          transition: 'color 0.3s ease',
          letterSpacing: '0.05em',
          outline: 'none',
        }}
      >
        CTO
      </button>

      {/* DEV Button */}
      <button
        onClick={() => setViewMode('dev')}
        aria-pressed={!isCto}
        title="Developer view — raw ARM JSON and field-level diffs"
        style={{
          position: 'relative',
          zIndex: 2,
          width: '50px',
          padding: '5px 0',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: '11px',
          fontWeight: 700,
          color: !isCto ? '#003359' : '#94a3b8',
          transition: 'color 0.3s ease',
          letterSpacing: '0.05em',
          outline: 'none',
        }}
      >
        DEV
      </button>
    </div>
  )
}
