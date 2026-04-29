// FILE: src/context/DashboardContext.jsx
// ROLE: Shared state store for the entire dashboard — persists selections across page navigation

// Why this exists:
//   When the user navigates from DriftScanner → ComparisonPage → back to DriftScanner,
//   all their selections (subscription, resource group, resource, config data) must be preserved.
//   React state is lost on unmount, so this context stores everything in sessionStorage.

// usePersisted(key, default):
//   A custom hook that works like useState but also reads/writes to sessionStorage.
//   On first render it loads the saved value. On every set() call it saves the new value.
//   This means selections survive page navigation but are cleared when the browser tab closes.

// What is stored in sessionStorage (survives navigation):
//   - adip.sub        → selected subscription ID
//   - adip.rg         → selected resource group ID
//   - adip.resource   → selected resource ID
//   - adip.rgs        → loaded resource group list (avoids re-fetching on back-navigation)
//   - adip.resources  → loaded resource list
//   - adip.liveEvents → scan animation log entries shown in the activity feed
//   - adip.driftEvents → live Socket.IO drift events received during this session

// What is NOT persisted (resets on navigation):
//   - isScanning, isMonitoring, isSubmitted → scan state flags
//   - configData → the live ARM config JSON (re-fetched on submit)
//   - scanProgress → progress bar percentage

// Refs (not state — changes don't trigger re-renders):
//   - scanInterval → holds the setInterval ID for the scan animation (so it can be cleared on Stop)
//   - monitorScope → holds the { subscriptionId, resourceGroupId, resourceId } of the active
//                    monitoring session (so handleStop knows what to pass to /api/monitor/stop)
//   - jsonTreeRef  → imperative ref to the JsonTree component (for expandAll/collapseAll)

// Used by: DriftScanner.jsx, DashboardHome.jsx, ComparisonPage.jsx, GenomePage.jsx, NavBar.jsx

import { createContext, useContext, useState, useRef } from 'react'

const DashboardContext = createContext(null)

// usePersisted — like useState but backed by sessionStorage
// key: the sessionStorage key (e.g. 'adip.sub')
// defaultValue: the value to use if nothing is stored yet
function usePersisted(storageKey, defaultValue) {
  // Read the stored value once on first render
  const initialValue = (() => {
    try {
      const storedJson = sessionStorage.getItem(storageKey)
      return storedJson !== null ? JSON.parse(storedJson) : defaultValue
    } catch {
      return defaultValue
    }
  })()

  const [currentValue, setCurrentValue] = useState(initialValue)

  // Wrap the setter to also write to sessionStorage on every change
  const setAndPersist = (newValue) => {
    setCurrentValue(newValue)
    try { sessionStorage.setItem(storageKey, JSON.stringify(newValue)) } catch {}
  }

  return [currentValue, setAndPersist]
}

export function DashboardProvider({ children }) {
  // ── Persisted selections (survive page navigation) ────────────────────────
  const [subscription,   setSubscription]   = usePersisted('adip.sub', '')
  const [resourceGroup,  setResourceGroup]  = usePersisted('adip.rg', '')
  const [resource,       setResource]       = usePersisted('adip.resource', '')

  // Dropdown lists — persisted so they don't need to be re-fetched on back-navigation
  const [resourceGroups, setResourceGroups] = usePersisted('adip.rgs', [])
  const [resources,      setResources]      = usePersisted('adip.resources', [])

  // Activity feed entries — persisted so the log survives navigation
  const [liveEvents,     setLiveEvents]     = usePersisted('adip.liveEvents', [])

  // Live Socket.IO drift events received during this session
  const [driftEvents,    setDriftEvents]    = usePersisted('adip.driftEvents', [])

  // ── Non-persisted scan state (resets on navigation) ───────────────────────

  // True while the scan animation is playing (Submit clicked, config not yet loaded)
  const [isScanning,     setIsScanning]     = useState(false)

  // True while the monitoring session is active (after config loads, until Stop is clicked)
  const [isMonitoring,   setIsMonitoring]   = useState(false)

  // True after config loads — gates the Socket.IO event handler in useDriftSocket
  const [isSubmitted,    setIsSubmitted]    = useState(false)

  // The live ARM config JSON shown in the JSON tree viewer
  const [configData,     setConfigData]     = useState(null)

  // Progress bar percentage (0–100) during the scan animation
  const [scanProgress,   setScanProgress]   = useState(0)

  // ── Refs (not state — changes don't trigger re-renders) ───────────────────

  // Holds the setInterval ID for the scan animation so handleStop can clear it
  const scanInterval = useRef(null)

  // Holds the active monitoring session scope so handleStop knows what to stop
  // Set to { subscriptionId, resourceGroupId, resourceId } on Submit, null on Stop
  const monitorScope = useRef(null)

  // Ref to the JsonTree component — used to call expandAll()/collapseAll() imperatively
  const jsonTreeRef = useRef(null)

  return (
    <DashboardContext.Provider value={{
      subscription,   setSubscription,
      resourceGroup,  setResourceGroup,
      resource,       setResource,
      resourceGroups, setResourceGroups,
      resources,      setResources,
      isScanning,     setIsScanning,
      isMonitoring,   setIsMonitoring,
      isSubmitted,    setIsSubmitted,
      configData,     setConfigData,
      liveEvents,     setLiveEvents,
      driftEvents,    setDriftEvents,
      scanProgress,   setScanProgress,
      scanInterval,   monitorScope,   jsonTreeRef,
    }}>
      {children}
    </DashboardContext.Provider>
  )
}

// useDashboard — the hook used by every page to access shared state
export function useDashboard() { return useContext(DashboardContext) }
