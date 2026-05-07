// ============================================================
// FILE: src/context/ViewModeContext.jsx
// ROLE: Global view mode toggle (CTO / Dev) — persisted per user
// ============================================================
import React, { createContext, useContext, useState } from 'react'

const ViewModeContext = createContext(null)

export function ViewModeProvider({ children }) {
  const storedMode = sessionStorage.getItem('adip.viewMode') || 'dev'
  const [viewMode, setViewModeState] = useState(storedMode)

  const setViewMode = (mode) => {
    setViewModeState(mode)
    sessionStorage.setItem('adip.viewMode', mode)
  }

  return (
    <ViewModeContext.Provider value={{ viewMode, setViewMode }}>
      {children}
    </ViewModeContext.Provider>
  )
}

export function useViewMode() { return useContext(ViewModeContext) }
