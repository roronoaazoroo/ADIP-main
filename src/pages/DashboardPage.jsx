import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import Sidebar from '../components/Sidebar'
import JsonTree from '../components/JsonTree'
import { useAzureScope } from '../hooks/useAzureScope'
import { useDriftSocket } from '../hooks/useDriftSocket'
import { fetchResourceConfiguration, stopMonitoring } from '../services/api'
import './DashboardPage.css'
import { useDashboard } from '../context/DashboardContext'

// ── Demo config data — used as fallback when backend is not yet connected ──
const RESOURCE_CONFIGS = {
  'rg-1': {
    resourceGroup: {
      name: 'rg-prod-eastus', location: 'eastus',
      tags: { environment: 'production', team: 'platform', costCenter: 'CC-1001' },
      provisioningState: 'Succeeded',
    },
    resources: [
      {
        name: 'vm-prod-web-01', type: 'Microsoft.Compute/virtualMachines', location: 'eastus',
        properties: {
          vmSize: 'Standard_D4s_v3', osType: 'Linux',
          osProfile: { computerName: 'vm-prod-web-01', adminUsername: 'azureuser', linuxConfiguration: { disablePasswordAuthentication: true } },
          storageProfile: { osDisk: { osType: 'Linux', diskSizeGB: 128, managedDisk: { storageAccountType: 'Premium_LRS' } }, dataDisks: [{ lun: 0, diskSizeGB: 256, managedDisk: { storageAccountType: 'Premium_LRS' } }] },
          networkProfile: { networkInterfaces: [{ id: '/subscriptions/a1b2c3d4/resourceGroups/rg-prod-eastus/providers/Microsoft.Network/networkInterfaces/nic-web-01' }] },
          diagnosticsProfile: { bootDiagnostics: { enabled: true } },
        },
        tags: { role: 'web-server', tier: 'frontend' },
      },
      {
        name: 'sql-prod-main', type: 'Microsoft.Sql/servers/databases', location: 'eastus',
        properties: { collation: 'SQL_Latin1_General_CP1_CI_AS', maxSizeBytes: 268435456000, status: 'Online', currentServiceObjectiveName: 'S3', backup: { retentionDays: 30, geoRedundantBackup: 'Enabled' }, encryption: { status: 'Enabled', type: 'TDE' } },
        tags: { dataClassification: 'confidential' },
      },
      {
        name: 'kv-prod-secrets', type: 'Microsoft.KeyVault/vaults', location: 'eastus',
        properties: {
          sku: { family: 'A', name: 'standard' }, tenantId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          accessPolicies: [{ tenantId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', objectId: 'user-object-id-001', permissions: { keys: ['get', 'list'], secrets: ['get', 'list', 'set'] } }],
          enableSoftDelete: true, softDeleteRetentionInDays: 90, enablePurgeProtection: true,
          networkAcls: { defaultAction: 'Deny', bypass: 'AzureServices', ipRules: [{ value: '203.0.113.0/24' }], virtualNetworkRules: [{ id: '/subscriptions/a1b2c3d4/resourceGroups/rg-prod-networking/providers/Microsoft.Network/virtualNetworks/vnet-prod-main/subnets/subnet-app' }] },
        },
        tags: { compliance: 'SOC2' },
      },
    ],
  },
  'rg-2': {
    resourceGroup: { name: 'rg-prod-westeurope', location: 'westeurope', tags: { environment: 'production', team: 'api', costCenter: 'CC-1002' }, provisioningState: 'Succeeded' },
    resources: [
      { name: 'app-prod-api', type: 'Microsoft.Web/sites', location: 'westeurope', properties: { state: 'Running', hostNames: ['app-prod-api.azurewebsites.net'], httpsOnly: true, siteConfig: { linuxFxVersion: 'NODE|18-lts', alwaysOn: true, minTlsVersion: '1.2', ftpsState: 'Disabled' } }, tags: { service: 'api-gateway' } },
      { name: 'func-prod-worker', type: 'Microsoft.Web/sites', kind: 'functionapp', location: 'westeurope', properties: { state: 'Running', siteConfig: { linuxFxVersion: 'PYTHON|3.11', functionAppScaleLimit: 200, minimumElasticInstanceCount: 1 } }, tags: { service: 'background-worker' } },
    ],
  },
  'rg-3': {
    resourceGroup: { name: 'rg-prod-networking', location: 'eastus', tags: { environment: 'production', team: 'network', costCenter: 'CC-1003' }, provisioningState: 'Succeeded' },
    resources: [
      { name: 'vnet-prod-main', type: 'Microsoft.Network/virtualNetworks', location: 'eastus', properties: { addressSpace: { addressPrefixes: ['10.0.0.0/16'] }, subnets: [{ name: 'subnet-app', addressPrefix: '10.0.1.0/24' }, { name: 'subnet-data', addressPrefix: '10.0.2.0/24', serviceEndpoints: ['Microsoft.Sql', 'Microsoft.KeyVault'] }], enableDdosProtection: true } },
      { name: 'nsg-prod-frontend', type: 'Microsoft.Network/networkSecurityGroups', location: 'eastus', properties: { securityRules: [{ name: 'AllowHTTPS', priority: 100, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', destinationPortRange: '443', sourceAddressPrefix: '*' }, { name: 'AllowSSH', priority: 200, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', destinationPortRange: '22', sourceAddressPrefix: '203.0.113.0/24' }, { name: 'DenyAllInbound', priority: 4096, direction: 'Inbound', access: 'Deny', protocol: '*', destinationPortRange: '*', sourceAddressPrefix: '*' }] } },
    ],
  },
}

const LIVE_EVENTS_TEMPLATE = [
  { type: 'scan',    message: 'Initiating configuration fetch...',             icon: 'scan' },
  { type: 'connect', message: 'Connecting to Azure Resource Manager API...',  icon: 'connect' },
  { type: 'fetch',   message: 'Fetching resource group configuration...',      icon: 'fetch' },
  { type: 'fetch',   message: 'Enumerating resources in resource group...',   icon: 'fetch' },
  { type: 'compare', message: 'Loading resource configurations...',            icon: 'compare' },
  { type: 'fetch',   message: 'Fetching detailed properties for each resource...', icon: 'fetch' },
  { type: 'compare', message: 'Processing network security rules...',          icon: 'compare' },
  { type: 'fetch',   message: 'Fetching tags and metadata...',                 icon: 'fetch' },
  { type: 'compare', message: 'Building configuration JSON...',                icon: 'compare' },
  { type: 'complete', message: 'Configuration loaded successfully. Displaying results.', icon: 'done' },
]

export default function DashboardPage() {
  const navigate = useNavigate()

  // ── All persistent state lives in context (survives navigation) ─────────
  const {
    subscription,  setSubscription,
    resourceGroup, setResourceGroup,
    resource,      setResource,
    isScanning,    setIsScanning,
    isMonitoring,  setIsMonitoring,
    isSubmitted,   setIsSubmitted,
    configData,    setConfigData,
    liveEvents,    setLiveEvents,
    scanProgress,  setScanProgress,
    scanInterval,  monitorScope,  jsonTreeRef,
  } = useDashboard()

  // ── Azure scope data from hook (real API with demo fallback) ───────────
  const {
    subscriptions, resourceGroups, resources,
    loading: scopeLoading, isDemoMode,
    fetchRGs, fetchResources,
  } = useAzureScope()

  // ── Real-time drift feed via Socket.IO ────────────────────────────────
  const scope = useMemo(
    () => ({ subscriptionId: subscription, resourceGroup, resourceId: resource || null }),
    [subscription, resourceGroup, resource]
  )


  // Task 4: re-fetch live config from ARM when a resource change event arrives
  const handleConfigUpdate = useCallback((event) => {
    if (!event.resourceId && !event.resourceGroup) return
    // Re-fetch the full live configuration for the currently displayed scope
    fetchResourceConfiguration(subscription, resourceGroup, resource || null)
      .then(cfg => { if (cfg) setConfigData(cfg) })
      .catch(() => {})
  }, [subscription, resourceGroup, resource, setConfigData])

  const { driftEvents, socketConnected, clearDriftEvents } = useDriftSocket(scope, isSubmitted, handleConfigUpdate)
  const liveLogRef = useRef(null)  // local UI ref only

  // ── Auto-scroll live log ───────────────────────────────────────────────
  useEffect(() => {
    if (liveLogRef.current) liveLogRef.current.scrollTop = liveLogRef.current.scrollHeight
  }, [liveEvents])

  useEffect(() => () => { if (scanInterval.current) clearInterval(scanInterval.current) }, [])

  // ── Helpers ─────────────────────────────────────────────────────────
  const getDemoConfig = () => {
    const cfg = RESOURCE_CONFIGS[resourceGroup]
    if (!cfg) return null
    if (resource) {
      const resName = resources.find(r => r.id === resource)?.name
      return cfg.resources?.find(r => r.name === resName) ?? cfg
    }
    return cfg
  }

  // ── Submit handler ────────────────────────────────────────────────────
  const handleSubmit = () => {
    if (!subscription || !resourceGroup || isScanning) return
    setIsScanning(true)
    setIsSubmitted(false)
    setConfigData(null)
    setLiveEvents([])
    setScanProgress(0)

    const configPromise = isDemoMode
      ? new Promise(resolve => setTimeout(() => resolve(getDemoConfig()), LIVE_EVENTS_TEMPLATE.length * 600))
      : fetchResourceConfiguration(subscription, resourceGroup, resource || null)

    let idx = 0
    scanInterval.current = setInterval(() => {
      if (idx < LIVE_EVENTS_TEMPLATE.length) {
        setLiveEvents(prev => [...prev, {
          ...LIVE_EVENTS_TEMPLATE[idx],
          timestamp: new Date().toLocaleTimeString(),
          id: Date.now() + idx,
        }])
        setScanProgress(Math.round(((idx + 1) / LIVE_EVENTS_TEMPLATE.length) * 100))
        idx++
      } else {
        clearInterval(scanInterval.current)
        configPromise
          .then(cfg => {
            if (cfg) {
              setIsSubmitted(true)
              setConfigData(cfg)
              // Start real-time monitoring after config loads
              if (!isDemoMode) {
                monitorScope.current = { subscriptionId: subscription, resourceGroupId: resourceGroup, resourceId: resource || null }
                setIsMonitoring(true)
                setLiveEvents(prev => [...prev, {
                  type: 'connect', icon: 'connect',
                  message: `Listening for live changes on ${resource ? resources.find(r => r.id === resource)?.name : resourceGroups.find(rg => rg.id === resourceGroup)?.name}`,
                  timestamp: new Date().toLocaleTimeString(),
                  id: Date.now(),
                }])
              }
            }
          })
          .catch(err => {
            setLiveEvents(prev => [...prev, {
              type: 'stop', icon: 'stop',
              message: `API Error: ${err.message}`,
              timestamp: new Date().toLocaleTimeString(),
              id: Date.now(),
            }])
          })
          .finally(() => setIsScanning(false))
      }
    }, 600)
  }

  const handleStop = () => {
    // Stop animation interval
    if (scanInterval.current) clearInterval(scanInterval.current)

    // Stop backend monitoring session
    if (isMonitoring && monitorScope.current) {
      const { subscriptionId, resourceGroupId, resourceId } = monitorScope.current
      stopMonitoring(subscriptionId, resourceGroupId, resourceId).catch(() => {})
      monitorScope.current = null
    }

    // Task 5: Full state reset
    setIsScanning(false)
    setIsMonitoring(false)
    setIsSubmitted(false)
    setConfigData(null)
    setLiveEvents([])
    setScanProgress(0)
    clearDriftEvents()
  }

  // ── Navigate to comparison page with current live state ───────────────
  const handleCompare = () => {
    navigate('/comparison', {
      state: {
        subscriptionId: subscription,
        resourceGroupId: resourceGroup,
        resourceId: resource || null,
        resourceName: resource
          ? resources.find(r => r.id === resource)?.name
          : resourceGroups.find(rg => rg.id === resourceGroup)?.name,
        liveState: configData,
      },
    })
  }

  // ── Icon renderer (unchanged) ─────────────────────────────────────────
  const getEventIcon = (icon) => {
    switch (icon) {
      case 'scan':    return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
      case 'connect': return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
      case 'fetch':   return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      case 'compare': return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 3h5v5M8 3H3v5M3 16v5h5M21 16v5h-5"/></svg>
      case 'done':    return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      case 'stop':    return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>
      default: return null
    }
  }

  // ── Stats helpers ─────────────────────────────────────────────────────
  const statsResources = configData?.resources ? configData.resources.length : (configData ? 1 : 0)
  const statsTags      = configData?.resourceGroup
    ? Object.keys(configData.resourceGroup.tags ?? {}).length
    : Object.keys(configData?.tags ?? {}).length
  const statsRegion    = configData?.resourceGroup?.location ?? configData?.location ?? '—'

  return (
    <div className="dashboard">
      <Sidebar />

      <div className="dashboard-main-wrapper">
        {/* Top Navbar */}
        <nav className="dashboard-nav">
          <div className="dashboard-nav-left">
            <div className="dashboard-nav-title">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--ct-coral-blue)" strokeWidth="2">
                <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                <path d="M2 17l10 5 10-5"/>
                <path d="M2 12l10 5 10-5"/>
              </svg>
              <span>Drift Scanner</span>
            </div>
            {isDemoMode && (
              <span className="demo-mode-badge">Demo mode — connect backend to use live data</span>
            )}
          </div>
          <div className="dashboard-nav-right">
            <div className="dashboard-nav-status">
              <div className={`dashboard-status-dot ${isScanning ? 'scanning' : ''}`} />
              <span>{isScanning ? 'Scanning...' : 'Ready'}</span>
            </div>
            <button className="dashboard-nav-avatar" onClick={() => navigate('/')} title="Sign Out">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                <circle cx="12" cy="7" r="4"/>
              </svg>
            </button>
          </div>
        </nav>

        {/* Body */}
        <div className="dashboard-body">
          {/* Left Panel — Resource Selection */}
          <aside className="dashboard-sidebar">
            <div className="sidebar-header">
              <h2 className="sidebar-title">Resource Selection</h2>
              <p className="sidebar-desc">Select Azure resources to fetch configuration</p>
            </div>

            <div className="sidebar-form">
              {/* Subscription */}
              <div className="form-group">
                <label className="form-label">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                  Subscription <span className="form-required">*</span>
                </label>
                <select
                  className="form-select"
                  value={subscription}
                  onChange={(e) => {
                    const val = e.target.value
                    setSubscription(val)
                    setResourceGroup('')
                    setResource('')
                    setConfigData(null)
                    fetchRGs(val)
                  }}
                  disabled={scopeLoading && !subscriptions.length}
                >
                  <option value="">Select a subscription...</option>
                  {subscriptions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>

              {/* Resource Group */}
              <div className="form-group">
                <label className="form-label">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                  Resource Group <span className="form-required">*</span>
                </label>
                <select
                  className="form-select"
                  value={resourceGroup}
                  onChange={(e) => {
                    const val = e.target.value
                    setResourceGroup(val)
                    setResource('')
                    setConfigData(null)
                    fetchResources(subscription, val)
                  }}
                  disabled={!subscription || scopeLoading}
                >
                  <option value="">Select a resource group...</option>
                  {resourceGroups.map(rg => <option key={rg.id} value={rg.id}>{rg.name}</option>)}
                </select>
              </div>

              {/* Resource (optional) */}
              <div className="form-group">
                <label className="form-label">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
                  Resource <span className="form-optional">(optional)</span>
                </label>
                <select
                  className="form-select"
                  value={resource}
                  onChange={(e) => setResource(e.target.value)}
                  disabled={!resourceGroup || scopeLoading}
                >
                  <option value="">All resources</option>
                  {resources.map(r => <option key={r.id} value={r.id}>{r.name} ({r.type})</option>)}
                </select>
              </div>
            </div>

            {/* Actions */}
            <div className="sidebar-actions">
              <button
                className="btn btn-primary"
                onClick={handleSubmit}
                disabled={!subscription || !resourceGroup || isScanning || scopeLoading}
              >
                {isScanning ? (
                  <><div className="btn-spinner" /><span>Fetching...</span></>
                ) : (
                  <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg><span>Submit</span></>
                )}
              </button>
              <button className="btn btn-danger" onClick={handleStop} disabled={!isScanning && !isMonitoring}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
                <span>{isMonitoring ? 'Stop Monitoring' : 'Stop'}</span>
              </button>
            </div>

            {/* Progress */}
            {isScanning && (
              <div className="sidebar-progress">
                <div className="progress-header">
                  <span className="progress-label">Progress</span>
                  <span className="progress-value">{scanProgress}%</span>
                </div>
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${scanProgress}%` }} />
                </div>
              </div>
            )}

            {/* Stats */}
            {configData && !isScanning && (
              <div className="sidebar-stats">
                <div className="stat-card stat-info">
                  <div className="stat-number">{statsResources}</div>
                  <div className="stat-label">Resources</div>
                </div>
                <div className="stat-card stat-success">
                  <div className="stat-number">{statsTags}</div>
                  <div className="stat-label">Tags</div>
                </div>
                <div className="stat-card stat-medium">
                  <div className="stat-number" style={{ fontSize: 12 }}>{statsRegion}</div>
                  <div className="stat-label">Region</div>
                </div>
              </div>
            )}
          </aside>

          {/* Right Panel */}
          <main className="dashboard-main">
            {/* Configuration JSON Panel */}
            <section className="panel panel-config">
              <div className="panel-header">
                <div className="panel-header-left">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--ct-coral-blue)" strokeWidth="2">
                    <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
                  </svg>
                  <h3>Resource Configuration</h3>
                </div>
                <div className="panel-header-actions">
                  {configData && (
                    <>
                      <button className="panel-action-btn" onClick={() => jsonTreeRef.current?.expandAll()} title="Expand All">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
                        <span>Expand</span>
                      </button>
                      <button className="panel-action-btn" onClick={() => jsonTreeRef.current?.collapseAll()} title="Collapse All">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
                        <span>Collapse</span>
                      </button>
                      <button className="panel-action-btn panel-action-btn--compare" onClick={handleCompare} title="Compare with Baseline">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 3h5v5M8 3H3v5M3 16v5h5M21 16v5h-5"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
                        <span>Compare</span>
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="panel-body panel-body-json">
                {!configData && !isScanning && (
                  <div className="panel-empty">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--ct-grey-300)" strokeWidth="1.5"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                    <p>Select resources and submit to view detailed JSON configuration</p>
                  </div>
                )}
                {isScanning && !configData && (
                  <div className="panel-scanning">
                    <div className="scanning-indicator">
                      <div className="scanning-ring" />
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--ct-coral-blue)" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                    </div>
                    <p>Fetching resource configuration...</p>
                  </div>
                )}
                {configData && <JsonTree ref={jsonTreeRef} data={configData} />}
              </div>
            </section>

            {/* Live Activity Panel */}
            <section className="panel panel-live">
              <div className="panel-header">
                <div className="panel-header-left">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--ct-coral-blue)" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                  <h3>Live Activity</h3>
                  {isScanning && <div className="live-indicator" />}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {isMonitoring && (
                    <span className="socket-connected-badge" title="Polling every 30s">
                      <span className="socket-dot" />Monitoring
                    </span>
                  )}
                  {socketConnected && !isMonitoring && (
                    <span className="socket-connected-badge">
                      <span className="socket-dot" />Live
                    </span>
                  )}
                  <span className="panel-badge">{liveEvents.length + driftEvents.length} events</span>
                </div>
              </div>

              <div className="panel-body panel-body-log" ref={liveLogRef}>
                {liveEvents.length === 0 && driftEvents.length === 0 && (
                  <div className="panel-empty">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--ct-grey-300)" strokeWidth="1.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                    <p>Activity log will appear here during operations</p>
                  </div>
                )}

                {/* Scan operation log */}
                {liveEvents.map(ev => (
                  <div key={ev.id} className={`log-entry log-entry-${ev.type}`}>
                    <span className="log-time">{ev.timestamp}</span>
                    <span className="log-icon">{getEventIcon(ev.icon)}</span>
                    <span className="log-message">{ev.message}</span>
                  </div>
                ))}

                {/* Real-time resource change feed (Event Grid → Queue → Socket.IO) */}
                {driftEvents.length > 0 && (
                  <div className="drift-feed-divider">
                    <span>Live resource changes</span>
                  </div>
                )}
                {driftEvents.map(ev => (
                  <div key={ev._clientId} className="log-entry log-entry-connect">
                    <span className="log-time">{ev._receivedAt}</span>
                    <span className="log-icon">
                      {ev.eventType?.includes('Delete')
                        ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                        : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                      }
                    </span>
                    <span className="log-message">
                      <strong style={{ color: ev.eventType?.includes('Delete') ? '#ef4444' : '#f59e0b' }}>
                        {ev.eventType?.includes('Delete') ? 'DELETED' : 'MODIFIED'}
                      </strong>
                      {' — '}
                      <span style={{ fontFamily: 'monospace', fontSize: 12 }}>
                        {ev.resourceId?.split('/').pop() ?? ev.subject}
                      </span>
                      {ev.caller && ev.caller !== 'unknown' && (
                        <span style={{ color: 'var(--ct-grey-400)', marginLeft: 6 }}>by {ev.caller}</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </main>
        </div>
      </div>
    </div>
  )
}