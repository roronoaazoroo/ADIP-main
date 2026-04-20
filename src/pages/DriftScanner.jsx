import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import JsonTree from '../components/JsonTree'
import { useAzureScope } from '../hooks/useAzureScope'
import { useDriftSocket } from '../hooks/useDriftSocket'
import { fetchResourceConfiguration, stopMonitoring, fetchPolicyCompliance, cacheState, fetchAnomalies } from '../services/api'
import './DriftScanner.css'
import { useDashboard } from '../context/DashboardContext'
import LiveActivityFeed from '../components/LiveActivityFeed'
import NavBar from "../components/NavBar";

const RESOURCE_CONFIGS = {
  'rg-1': {
    resourceGroup: { name: 'rg-prod-eastus', location: 'eastus', tags: { environment: 'production', team: 'platform' }, provisioningState: 'Succeeded' },
    resources: [
      { name: 'vm-prod-web-01', type: 'Microsoft.Compute/virtualMachines', location: 'eastus', properties: { vmSize: 'Standard_D4s_v3', osType: 'Linux' }, tags: { role: 'web-server' } },
      { name: 'kv-prod-secrets', type: 'Microsoft.KeyVault/vaults', location: 'eastus', properties: { sku: { name: 'standard' }, enableSoftDelete: true, networkAcls: { defaultAction: 'Deny' } } },
    ],
  },
}

const LIVE_EVENTS_TEMPLATE = [
  { type: 'scan',    message: 'Initiating configuration fetch...' },
  { type: 'connect', message: 'Connecting to Azure Resource Manager...' },
  { type: 'fetch',   message: 'Fetching resource configuration...' },
  { type: 'compare', message: 'Processing configuration data...' },
  { type: 'done',    message: 'Configuration loaded successfully.' },
]

export default function DriftScanner() {
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState('config')

  const {
    subscription, setSubscription,
    resourceGroup, setResourceGroup,
    resource, setResource,
    resourceGroups, setResourceGroups,
    resources, setResources,
    isScanning, setIsScanning,
    isMonitoring, setIsMonitoring,
    isSubmitted, setIsSubmitted,
    configData, setConfigData,
    liveEvents, setLiveEvents,
    driftEvents, setDriftEvents,
    scanProgress, setScanProgress,
    policyData, setPolicyData,
    anomalies, setAnomalies,
    scanInterval, monitorScope, jsonTreeRef,
  } = useDashboard()

  const { subscriptions, loading: scopeLoading, isDemoMode, fetchRGs, fetchResources } = useAzureScope({
    resourceGroups, setResourceGroups, resources, setResources,
    savedSubscription: subscription, savedResourceGroup: resourceGroup,
  })

  const scope = useMemo(
    () => ({ subscriptionId: subscription, resourceGroup, resourceId: resource || null }),
    [subscription, resourceGroup, resource]
  )

  const handleConfigUpdate = useCallback((event) => {
    if (!event.resourceId && !event.resourceGroup) return
    if (resource && event.liveState) {
      setConfigData(event.liveState)
    } else {
      fetchResourceConfiguration(subscription, resourceGroup, resource || null)
        .then(cfg => { if (cfg) setConfigData(cfg) }).catch(() => {})
    }
  }, [subscription, resourceGroup, resource, setConfigData])

  const { socketConnected, clearDriftEvents } = useDriftSocket(scope, isSubmitted, handleConfigUpdate, driftEvents, setDriftEvents)

  useEffect(() => () => { if (scanInterval.current) clearInterval(scanInterval.current) }, [])

  useEffect(() => {
    if (!isSubmitted || !subscription || !resourceGroup) return
    const id = setInterval(() => {
      fetchResourceConfiguration(subscription, resourceGroup, resource || null)
        .then(cfg => { if (cfg) setConfigData(cfg) }).catch(() => {})
    }, 5000)
    return () => clearInterval(id)
  }, [isSubmitted, subscription, resourceGroup, resource])

  const getDemoConfig = () => {
    const cfg = RESOURCE_CONFIGS[resourceGroup]
    if (!cfg) return null
    if (resource) {
      const resName = resources.find(r => r.id === resource)?.name
      return cfg.resources?.find(r => r.name === resName) ?? cfg
    }
    return cfg
  }

  const handleSubmit = () => {
    if (!subscription || !resourceGroup || isScanning) return
    setIsScanning(true)
    setIsSubmitted(false)
    setConfigData(null)
    setLiveEvents([])
    setScanProgress(0)

    const configPromise = isDemoMode
      ? new Promise(resolve => setTimeout(() => resolve(getDemoConfig()), LIVE_EVENTS_TEMPLATE.length * 200))
      : fetchResourceConfiguration(subscription, resourceGroup, resource || null)

    let idx = 0
    scanInterval.current = setInterval(() => {
      if (idx < LIVE_EVENTS_TEMPLATE.length) {
        setLiveEvents(prev => [...prev, { ...LIVE_EVENTS_TEMPLATE[idx], timestamp: new Date().toLocaleTimeString(), id: Date.now() + idx }])
        setScanProgress(Math.round(((idx + 1) / LIVE_EVENTS_TEMPLATE.length) * 100))
        idx++
      } else {
        clearInterval(scanInterval.current)
        configPromise
          .then(cfg => {
            if (cfg) {
              setIsSubmitted(true)
              setConfigData(cfg)
              fetchPolicyCompliance(subscription, resourceGroup, resource || null).then(p => setPolicyData(p)).catch(() => {})
              if (!isDemoMode) {
                fetchAnomalies(subscription).then(r => setAnomalies(r?.anomalies || [])).catch(() => {})
                const toCache = cfg.resources ? cfg.resources.filter(r => r.id) : (cfg.id ? [cfg] : [])
                toCache.forEach(r => cacheState(r.id, r).catch(() => {}))
                monitorScope.current = { subscriptionId: subscription, resourceGroupId: resourceGroup, resourceId: resource || null }
                setIsMonitoring(true)
                setLiveEvents(prev => [...prev, {
                  message: `Listening for live changes on ${resource ? resources.find(r => r.id === resource)?.name : resourceGroups.find(rg => rg.id === resourceGroup)?.name}`,
                  timestamp: new Date().toLocaleTimeString(), id: Date.now(),
                }])
              }
            }
          })
          .catch(err => {
            setLiveEvents(prev => [...prev, { type: 'stop', message: `API Error: ${err.message}`, timestamp: new Date().toLocaleTimeString(), id: Date.now() }])
          })
          .finally(() => setIsScanning(false))
      }
    }, 10)
  }

  const handleStop = () => {
    if (scanInterval.current) clearInterval(scanInterval.current)
    if (isMonitoring && monitorScope.current) {
      const { subscriptionId, resourceGroupId, resourceId } = monitorScope.current
      stopMonitoring(subscriptionId, resourceGroupId, resourceId).catch(() => {})
      monitorScope.current = null
    }
    setIsScanning(false); setIsMonitoring(false); setIsSubmitted(false)
    setConfigData(null); setLiveEvents([]); setScanProgress(0)
    setPolicyData(null); setAnomalies([]); clearDriftEvents()
  }

  const statsResources = configData?.resources ? configData.resources.length : (configData ? 1 : 0)
  const statsTags = configData?.resourceGroup ? Object.keys(configData.resourceGroup.tags ?? {}).length : Object.keys(configData?.tags ?? {}).length
  const statsRegion = configData?.resourceGroup?.location ?? configData?.location ?? '—'
  const totalEvents = driftEvents.length
  const user = (() => { try { return JSON.parse(sessionStorage.getItem('user') || '{}') } catch { return {} } })()
  return (
    <div className="ds-root">
      <NavBar
        user={user}
        subscription={subscription}
        resourceGroup={resourceGroup}
        resource={resource}
        configData={configData}
        navigateToDriftScanner={() => {}}
      />
      {/* ── Main ── */}
      <main className="ds-main">
        <div className="ds-content">

          {/* Header */}
          <header className="ds-header">
            <div>
              <h1 className="ds-headline">Drift Scanner</h1>
              <p className="ds-subline">Real-time configuration analysis and integrity monitoring across your distributed ecosystem.</p>
            </div>
            <div className="ds-header-badges">
              {isMonitoring && (
                <div className="ds-monitoring-badge">
                  <span className="ds-monitoring-dot" />
                  Monitoring
                </div>
              )}
              {isDemoMode && <span className="ds-demo-badge">Demo Mode</span>}
              {configData && <div className="ds-resources-badge">{statsResources} Resource{statsResources !== 1 ? 's' : ''} Active</div>}
            </div>
          </header>

          {/* Filter Section */}
          <section className="ds-filter-section">
            <div className="ds-filter-grid">
              <div className="ds-filter-field">
                <label className="ds-filter-label">Subscription</label>
                <select className="ds-filter-select" value={subscription}
                  onChange={e => { const v = e.target.value; setSubscription(v); setResourceGroup(''); setResource(''); setConfigData(null); fetchRGs(v) }}
                  disabled={scopeLoading && !subscriptions.length} id="filter-subscription">
                  <option value="">Select subscription...</option>
                  {subscriptions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>

              <div className="ds-filter-field">
                <label className="ds-filter-label">Resource Group</label>
                <select className="ds-filter-select" value={resourceGroup}
                  onChange={e => { const v = e.target.value; setResourceGroup(v); setResource(''); setConfigData(null); fetchResources(subscription, v) }}
                  disabled={!subscription || scopeLoading} id="filter-resource-group">
                  <option value="">Select resource group...</option>
                  {resourceGroups.map(rg => <option key={rg.id} value={rg.id}>{rg.name}</option>)}
                </select>
              </div>

              <div className="ds-filter-field">
                <label className="ds-filter-label">Resource</label>
                <select className="ds-filter-select" value={resource}
                  onChange={e => setResource(e.target.value)}
                  disabled={!resourceGroup || scopeLoading} id="filter-resource">
                  <option value="">All resources</option>
                  {resources.map(r => <option key={r.id} value={r.id}>{r.name} ({r.type})</option>)}
                </select>
              </div>

              <div className="ds-filter-actions">
                <button className="ds-submit-btn" onClick={handleSubmit}
                  disabled={!subscription || !resourceGroup || isScanning || scopeLoading} id="btn-submit">
                  {isScanning ? <><div className="ds-btn-spinner" /> Fetching...</> : 'Submit Scan'}
                </button>
                <button className="ds-stop-btn" onClick={handleStop}
                  disabled={!isScanning && !isMonitoring} id="btn-stop">
                  <span className="material-symbols-outlined">stop_circle</span>
                </button>
              </div>
            </div>

            {/* Stats */}
            {configData && !isScanning && (
              <div className="ds-stats-row">
                <div className="ds-stat-pill ds-stat-pill--info"><span className="ds-stat-val">{statsResources}</span> resources</div>
                <div className="ds-stat-pill ds-stat-pill--ok"><span className="ds-stat-val">{statsTags}</span> tags</div>
                <div className="ds-stat-pill ds-stat-pill--region"><span className="ds-stat-val">{statsRegion}</span></div>
                {policyData?.nonCompliant > 0 && (
                  <div className="ds-stat-pill" style={{ color: '#dc2626' }}>
                    <span className="ds-stat-val" style={{ color: '#dc2626' }}>{policyData.nonCompliant}</span> policy violations
                  </div>
                )}
              </div>
            )}

            {/* AI Anomalies */}
            {anomalies?.length > 0 && (
              <div className="ds-anomalies">
                <span className="ds-anomaly-label">AI Anomalies</span>
                {anomalies.slice(0, 2).map((a, i) => (
                  <div key={i} className="ds-anomaly-card">
                    <div className="ds-anomaly-title">{a.title}</div>
                    <div className="ds-anomaly-desc">{a.description}</div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Progress */}
          {isScanning && (
            <div className="ds-progress">
              <div className="ds-progress-fill" style={{ width: `${scanProgress}%` }} />
            </div>
          )}

          {/* Viewer Card */}
          <div className="ds-viewer-card">
            <div className="ds-viewer-toolbar">
              <div className="ds-tab-group">
                <button className={`ds-tab-btn ${activeTab === 'config' ? 'ds-tab-btn--active' : ''}`}
                  onClick={() => setActiveTab('config')} id="tab-config">
                  Live Current Config
                </button>
                <button className={`ds-tab-btn ${activeTab === 'activity' ? 'ds-tab-btn--active' : ''}`}
                  onClick={() => setActiveTab('activity')} id="tab-activity">
                  Live Activity Feed
                  {totalEvents > 0 && <span className="ds-tab-badge">{totalEvents}</span>}
                </button>
              </div>

              <div className="ds-toolbar-actions">
                {activeTab === 'config' && configData && (
                  <>
                    <button className="ds-toolbar-btn" onClick={() => jsonTreeRef.current?.expandAll()}>
                      <span className="material-symbols-outlined">unfold_more</span> Expand
                    </button>
                    <button className="ds-toolbar-btn" onClick={() => jsonTreeRef.current?.collapseAll()}>
                      <span className="material-symbols-outlined">unfold_less</span> Collapse
                    </button>
                  </>
                )}
                {activeTab === 'activity' && (isMonitoring || socketConnected) && (
                  <div className="ds-monitoring-live">
                    <span className="ds-monitoring-live-dot" />
                    {isMonitoring ? 'Monitoring' : 'Live'}
                  </div>
                )}
              </div>
            </div>

            {/* Config Tab */}
            {activeTab === 'config' && (
              <div className="ds-code-viewer">
                <span className="ds-code-readonly">Read Only Mode</span>
                <div className="ds-code-inner">
                  {!configData && !isScanning && (
                    <div className="ds-empty">
                      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                        <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
                      </svg>
                      <p>Select a subscription and resource group, then click Submit Scan to view configuration</p>
                    </div>
                  )}
                  {isScanning && !configData && (
                    <div className="ds-scanning">
                      <div className="ds-scanning-ring" />
                      <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13 }}>Fetching resource configuration...</p>
                    </div>
                  )}
                  {configData && <JsonTree ref={jsonTreeRef} data={configData} />}
                </div>
              </div>
            )}

            {/* Activity Tab */}
            {activeTab === 'activity' && (
              <div className="ds-feed-inner">
                <LiveActivityFeed
                  liveEvents={liveEvents}
                  driftEvents={driftEvents}
                  isScanning={isScanning}
                  isMonitoring={isMonitoring}
                  socketConnected={socketConnected}
                />
              </div>
            )}
          </div>

        </div>
      </main>
    </div>
  )
}
