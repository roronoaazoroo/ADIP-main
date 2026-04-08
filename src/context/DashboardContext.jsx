import { createContext, useContext, useState, useRef } from 'react'

const DashboardContext = createContext(null)

function usePersisted(key, defaultVal) {
  const init = (() => { try { const v = sessionStorage.getItem(key); return v !== null ? JSON.parse(v) : defaultVal } catch { return defaultVal } })()
  const [val, setVal] = useState(init)
  const set = (v) => { setVal(v); try { sessionStorage.setItem(key, JSON.stringify(v)) } catch {} }
  return [val, set]
}

export function DashboardProvider({ children }) {
  const [subscription,  setSubscription]  = usePersisted('adip.sub', '')
  const [resourceGroup, setResourceGroup] = usePersisted('adip.rg', '')
  const [resource,      setResource]      = usePersisted('adip.resource', '')
  const [isScanning,    setIsScanning]    = useState(false)
  const [isMonitoring,  setIsMonitoring]  = useState(false)
  const [isSubmitted,   setIsSubmitted]   = useState(false)
  const [configData,    setConfigData]    = useState(null)
  const [liveEvents,    setLiveEvents]    = useState([])
  const [scanProgress,  setScanProgress]  = useState(0)
  const [policyData,    setPolicyData]    = useState(null)
  const [anomalies,     setAnomalies]     = useState([])
  const scanInterval = useRef(null)
  const monitorScope = useRef(null)
  const jsonTreeRef  = useRef(null)

  return (
    <DashboardContext.Provider value={{
      subscription,  setSubscription,
      resourceGroup, setResourceGroup,
      resource,      setResource,
      isScanning,    setIsScanning,
      isMonitoring,  setIsMonitoring,
      isSubmitted,   setIsSubmitted,
      configData,    setConfigData,
      liveEvents,    setLiveEvents,
      scanProgress,  setScanProgress,
      policyData,    setPolicyData,
      anomalies,     setAnomalies,
      scanInterval,  monitorScope, jsonTreeRef,
    }}>
      {children}
    </DashboardContext.Provider>
  )
}

export function useDashboard() { return useContext(DashboardContext) }
