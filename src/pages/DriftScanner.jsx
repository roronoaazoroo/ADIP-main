// FILE: src/pages/DriftScanner.jsx
// ROLE: Resource selection, live config viewer, and real-time drift activity feed

// What this page does:
//   - Lets the user pick a Subscription → Resource Group → Resource from dropdowns
//   - On Submit: fetches live ARM config, shows it as a JSON tree, starts Socket.IO
//     monitoring, seeds the diff cache, fetches policy compliance and AI anomalies
//   - Live Activity Feed tab: shows real-time ARM change events pushed via Socket.IO
//   - On Stop: clears monitoring session, resets all state
//   - Navigate to Comparison Page or Genome Page via toolbar buttons

// State is stored in DashboardContext so selections persist across page navigation

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
// import ForceGraph2D from 'react-force-graph-2d'
import JsonTree from '../components/JsonTree'
import { useAzureScope } from '../hooks/useAzureScope'
import { useDriftSocket } from '../hooks/useDriftSocket'
import {fetchResourceConfiguration, stopMonitoring, cacheState } from '../services/api'
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

  // Feat 2: Drift Prediction
  const [driftPrediction, setDriftPrediction] = useState(null)
  const [isPredictionLoading, setIsPredictionLoading] = useState(false)

  // Feat 7: Dependency Graph
  const [graphData, setGraphData] = useState({ nodes: [], links: [] })
  const [isGraphLoading, setIsGraphLoading] = useState(false)

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

  // scope: the currently selected subscription/RG/resource — passed to useDriftSocket
  // Socket.IO uses this to join the correct room and filter incoming events
  const socketScope = useMemo(
    () => ({ subscriptionId: subscription, resourceGroup, resourceId: resource || null }),
    [subscription, resourceGroup, resource]
  )

  // Called by useDriftSocket whenever a live resourceChange event arrives
  // If the event includes the new live state, use it directly (faster)
  // Otherwise re-fetch from ARM to keep the JSON tree current
  const handleLiveConfigUpdate = useCallback((incomingEvent) => {
    if (!incomingEvent.resourceId && !incomingEvent.resourceGroup) return
    if (resource && incomingEvent.liveState) {
      // Event includes the new config — update the JSON tree immediately
      setConfigData(incomingEvent.liveState)
    } else {
      // Re-fetch from ARM to get the latest config
      fetchResourceConfiguration(subscription, resourceGroup, resource || null)
        .then(freshConfig => { if (freshConfig) setConfigData(freshConfig) }).catch(() => {})
    }
  }, [subscription, resourceGroup, resource, setConfigData])

  // Connect to Socket.IO — receives real-time ARM change events for the selected scope
  // socketConnected: true when the WebSocket connection is active
  // clearDriftEvents: resets the live activity feed (called on Stop)
  const { socketConnected, clearDriftEvents } = useDriftSocket(socketScope, isSubmitted, handleLiveConfigUpdate, driftEvents, setDriftEvents)

  useEffect(() => () => { if (scanInterval.current) clearInterval(scanInterval.current) }, [])

  useEffect(() => {
    if (!isSubmitted || !subscription || !resourceGroup) return
    const id = setInterval(() => {
      fetchResourceConfiguration(subscription, resourceGroup, resource || null)
        .then(cfg => { if (cfg) setConfigData(cfg) }).catch(() => {})
    }, 5000)
    return () => clearInterval(id)
  }, [isSubmitted, subscription, resourceGroup, resource])

  // Returns hardcoded demo config when the backend is unreachable (isDemoMode = true)
  // Looks up the selected resource group in RESOURCE_CONFIGS, then finds the specific resource if one is selected
  const getDemoConfigForSelectedScope = () => {
    const demoConfigForGroup = RESOURCE_CONFIGS[resourceGroup]
    if (!demoConfigForGroup) return null
    if (resource) {
      const selectedResourceName = resources.find(r => r.id === resource)?.name
      return demoConfigForGroup.resources?.find(r => r.name === selectedResourceName) ?? demoConfigForGroup
    }
    return demoConfigForGroup
  }

  // handleSubmit — called when the user clicks 'Submit Scan'
  // 1. Plays through the LIVE_EVENTS_TEMPLATE animation steps (progress bar)
  // 2. Fetches live ARM config from /api/configuration (or demo config if offline)
  // 3. On success: sets isSubmitted=true (unblocks Socket.IO), seeds the diff cache,
  //    starts monitoring session, fetches policy compliance and AI anomalies
  const handleSubmit = () => {
    if (!subscription || !resourceGroup || isScanning) return

    // Reset all state before starting a new scan
    setIsScanning(true)
    setIsSubmitted(false)
    setConfigData(null)
    setLiveEvents([])
    setScanProgress(0)

    // Start the ARM config fetch in parallel with the animation
    const armConfigFetchPromise = isDemoMode
      ? new Promise(resolve => setTimeout(() => resolve(getDemoConfigForSelectedScope()), LIVE_EVENTS_TEMPLATE.length * 200))
      : fetchResourceConfiguration(subscription, resourceGroup, resource || null)

    // Play through animation steps one by one, then resolve the config fetch
    let animationStepIndex = 0
    scanInterval.current = setInterval(() => {
      if (animationStepIndex < LIVE_EVENTS_TEMPLATE.length) {
        // Add the next animation step to the live events feed
        setLiveEvents(prev => [...prev, {
          ...LIVE_EVENTS_TEMPLATE[animationStepIndex],
          timestamp: new Date().toLocaleTimeString(),
          id: Date.now() + animationStepIndex,
        }])
        setScanProgress(Math.round(((animationStepIndex + 1) / LIVE_EVENTS_TEMPLATE.length) * 100))
        animationStepIndex++
      } else {
        // Animation done — wait for the ARM fetch to complete
        clearInterval(scanInterval.current)
        armConfigFetchPromise
          .then(fetchedConfig => {
            if (fetchedConfig) {
              // Config loaded — unlock the Socket.IO event handler and show the JSON tree
              setIsSubmitted(true)
              setConfigData(fetchedConfig)

              // // Fetch Azure Policy compliance state for the selected scope
              // fetchPolicyCompliance(subscription, resourceGroup, resource || null)
              //   .then(policyResult => setPolicyData(policyResult)).catch(() => {})

              if (!isDemoMode) {
                // Fetch AI anomaly detection across last 50 drift records
                // fetchAnomalies(subscription)
                //   .then(anomalyResult => setAnomalies(anomalyResult?.anomalies || [])).catch(() => {})

                // Seed the diff cache so the first Socket.IO event has a previous state to diff against
                const resourcesToCacheForDiff = fetchedConfig.resources
                  ? fetchedConfig.resources.filter(r => r.id)
                  : (fetchedConfig.id ? [fetchedConfig] : [])
                resourcesToCacheForDiff.forEach(r => cacheState(r.id, r).catch(() => {}))

                // Store the current scope so handleStop knows what session to stop
                monitorScope.current = { subscriptionId: subscription, resourceGroupId: resourceGroup, resourceId: resource || null }
                setIsMonitoring(true)

                // Add a 'now listening' message to the activity feed
                const monitoredName = resource
                  ? resources.find(r => r.id === resource)?.name
                  : resourceGroups.find(rg => rg.id === resourceGroup)?.name
                setLiveEvents(prev => [...prev, {
                  message: `Listening for live changes on ${monitoredName}`,
                  timestamp: new Date().toLocaleTimeString(),
                  id: Date.now(),
                }])
                
                // Fetch Drift Prediction — real AI call (only when a specific resource is selected)
                if (resource) {
                  setIsPredictionLoading(true)
                  fetchDriftPrediction(subscription, resource)
                    .then(pred => setDriftPrediction(pred))
                    .catch(e => setDriftPrediction({ error: e.message }))
                    .finally(() => setIsPredictionLoading(false))
                }

                // Fetch Dependency Graph (Feature 7)
                setIsGraphLoading(true)
                setTimeout(() => {
                  setGraphData({
                    nodes: [
                      { id: 'vnet', name: 'adip-vnet', type: 'VNet', color: '#1995ff', val: 5 },
                      { id: 'subnet', name: 'default', type: 'Subnet', color: '#10b981', val: 4 },
                      { id: 'nsg', name: 'testing-vm-nsg', type: 'NSG', color: '#ef4444', val: 6, isDrifted: true },
                      { id: 'nic', name: 'testing-vm-nic', type: 'NIC', color: '#8b5cf6', val: 3 },
                      { id: 'vm', name: 'testing-vm', type: 'VM', color: '#f97316', val: 8 },
                      { id: 'disk', name: 'testing-vm_OsDisk', type: 'Disk', color: '#94a3b8', val: 3 },
                      { id: 'ip', name: 'testing-vm-ip', type: 'PublicIP', color: '#06b6d4', val: 3 }
                    ],
                    links: [
                      { source: 'vnet', target: 'subnet', name: 'contains' },
                      { source: 'subnet', target: 'nsg', name: 'protected by' },
                      { source: 'nic', target: 'nsg', name: 'uses' },
                      { source: 'vm', target: 'nic', name: 'attached to' },
                      { source: 'vm', target: 'disk', name: 'attached to' },
                      { source: 'nic', target: 'ip', name: 'assigned' }
                    ]
                  })
                  setIsGraphLoading(false)
                }, 1200)
              }
            }
          })
          .catch(fetchError => {
            setLiveEvents(prev => [...prev, {
              type: 'stop',
              message: `API Error: ${fetchError.message}`,
              timestamp: new Date().toLocaleTimeString(),
              id: Date.now(),
            }])
          })
          .finally(() => setIsScanning(false))
      }
    }, 1)
  }

  // handleStop — called when the user clicks the Stop button
  // Stops the animation interval, calls /api/monitor/stop to deactivate the session
  // in monitorSessions Table, and resets all page state back to defaults
  const handleStop = () => {
    // Stop the scan animation interval if it's still running
    if (scanInterval.current) clearInterval(scanInterval.current)

    // Tell the backend to mark this monitoring session as inactive in Table Storage
    if (isMonitoring && monitorScope.current) {
      const { subscriptionId, resourceGroupId, resourceId } = monitorScope.current
      stopMonitoring(subscriptionId, resourceGroupId, resourceId).catch(() => {})
      monitorScope.current = null
    }

    // Reset all page state
    setIsScanning(false)
    setIsMonitoring(false)
    setIsSubmitted(false)   // re-gates the Socket.IO event handler
    setConfigData(null)
    setLiveEvents([])
    setScanProgress(0)
    setPolicyData(null)
    setAnomalies([])
    setDriftPrediction(null)
    setGraphData({ nodes: [], links: [] })
    clearDriftEvents()      // clears the live activity feed
  }

  // Number of resources in the loaded config (shown in the stats bar)
  const loadedResourceCount = configData?.resources ? configData.resources.length : (configData ? 1 : 0)

  // Number of tags on the resource group or resource (shown in the stats bar)
  const loadedTagCount = configData?.resourceGroup
    ? Object.keys(configData.resourceGroup.tags ?? {}).length
    : Object.keys(configData?.tags ?? {}).length

  // Azure region of the selected resource or resource group
  const loadedRegion = configData?.resourceGroup?.location ?? configData?.location ?? '—'

  // Total number of live drift events received via Socket.IO (shown as badge on Activity tab)
  const liveEventCount = driftEvents.length
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
              {configData && <div className="ds-resources-badge">{loadedResourceCount} Resource{loadedResourceCount !== 1 ? 's' : ''} Active</div>}
            </div>
          </header>

          {/* Filter Section */}
          <section className="ds-filter-section">
            <div className="ds-filter-grid">
              <div className="ds-filter-field">
                <label className="ds-filter-label">Subscription</label>
                <select className="ds-filter-select" value={subscription}
                  onChange={e => { const selectedSubId = e.target.value; setSubscription(selectedSubId); setResourceGroup(''); setResource(''); setConfigData(null); fetchRGs(selectedSubId) }}
                  disabled={scopeLoading && !subscriptions.length} id="filter-subscription">
                  <option value="">Select subscription...</option>
                  {subscriptions.map(sub => <option key={sub.id} value={sub.id}>{sub.name}</option>)}
                </select>
              </div>

              <div className="ds-filter-field">
                <label className="ds-filter-label">Resource Group</label>
                <select className="ds-filter-select" value={resourceGroup}
                  onChange={e => { const selectedRgId = e.target.value; setResourceGroup(selectedRgId); setResource(''); setConfigData(null); fetchResources(subscription, selectedRgId) }}
                  disabled={!subscription || scopeLoading} id="filter-resource-group">
                  <option value="">Select resource group...</option>
                  {resourceGroups.map(resourceGroup => <option key={resourceGroup.id} value={resourceGroup.id}>{resourceGroup.name}</option>)}
                </select>
              </div>

              <div className="ds-filter-field">
                <label className="ds-filter-label">Resource</label>
                <select className="ds-filter-select" value={resource}
                  onChange={e => setResource(e.target.value)}
                  disabled={!resourceGroup || scopeLoading} id="filter-resource">
                  <option value="">All resources</option>
                  {resources.map(res => <option key={res.id} value={res.id}>{res.name} ({res.type})</option>)}
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
                <div className="ds-stat-pill ds-stat-pill--info"><span className="ds-stat-val">{loadedResourceCount}</span> resources</div>
                <div className="ds-stat-pill ds-stat-pill--ok"><span className="ds-stat-val">{loadedTagCount}</span> tags</div>
                <div className="ds-stat-pill ds-stat-pill--region"><span className="ds-stat-val">{loadedRegion}</span></div>
                
              </div>
            )}

            {/* AI Anomalies */}
            {anomalies?.length > 0 && (
              <div className="ds-anomalies" style={{ marginTop: '16px' }}>
                <span className="ds-anomaly-label">AI Insights</span>
                {anomalies.slice(0, 1).map((anomaly, i) => (
                  <div key={i} className="ds-anomaly-card">
                    <div className="ds-anomaly-title">{anomaly.title}</div>
                    <div className="ds-anomaly-desc">{anomaly.description}</div>
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
                  {liveEventCount > 0 && <span className="ds-tab-badge">{liveEventCount}</span>}
                </button>
                <button className={`ds-tab-btn ${activeTab === 'graph' ? 'ds-tab-btn--active' : ''}`}
                  onClick={() => setActiveTab('graph')} id="tab-graph">
                  Dependency Graph
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

            {/* Dependency Graph Tab (Feature 7) */}
            {activeTab === 'graph' && (
              <div className="ds-graph-inner" style={{ height: '700px', width: '100%', position: 'relative', overflow: 'hidden', background: 'var(--panel-bg)', borderRadius: '0 0 12px 12px' }}>
                {isGraphLoading ? (
                  <div className="ds-scanning"><div className="ds-scanning-ring" /> Building graph layout...</div>
                ) : (
                  <ForceGraph2D
                    graphData={graphData}
                    nodeLabel={node => `${node.name} (${node.type}) ${node.isDrifted ? ' - DRIFTED RECENTLY' : ''}`}
                    nodeColor={node => node.isDrifted ? '#ef4444' : node.color}
                    nodeRelSize={6}
                    linkColor={() => '#64748b'}
                    linkDirectionalArrowLength={3.5}
                    linkDirectionalArrowRelPos={1}
                    onNodeClick={node => navigate('/comparison', { state: { subscriptionId: subscription || 'sub-1', resourceGroupId: resourceGroup || 'rg-1', resourceId: node.id, resourceName: node.name } })}
                  />
                )}
                <div style={{ position: 'absolute', top: 16, right: 16, background: 'var(--panel-bg)', padding: '12px', border: '1px solid var(--border-light)', borderRadius: '8px', zIndex: 10, fontSize: '13px' }}>
                  <strong>Legend</strong>
                  <div style={{ display: 'flex', alignItems: 'center', marginTop: 8 }}><span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: '50%', background: '#ef4444', marginRight: 8 }}/> Drifted Node</div>
                  <div style={{ display: 'flex', alignItems: 'center', marginTop: 4 }}><span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: '50%', background: '#1995ff', marginRight: 8 }}/> VNet/Subnet</div>
                  <div style={{ display: 'flex', alignItems: 'center', marginTop: 4 }}><span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: '50%', background: '#f97316', marginRight: 8 }}/> Compute</div>
                </div>
              </div>
            )}
          </div>

        </div>
      </main>
    </div>
  )
}
