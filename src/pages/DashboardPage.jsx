import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import Sidebar from '../components/Sidebar'
import JsonTree from '../components/JsonTree'
import { useAzureScope } from '../hooks/useAzureScope'
import { useDriftSocket } from '../hooks/useDriftSocket'
import { fetchResourceConfiguration, stopMonitoring, fetchPolicyCompliance, cacheState, fetchAnomalies } from '../services/api'
import './DashboardPage.css'
import { useDashboard } from '../context/DashboardContext'
import { useTheme } from '../context/ThemeContext'
import LiveActivityFeed from '../components/LiveActivityFeed'

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
  { type: 'scan',    message: 'Initiating configuration fetch...',             icon: 'scan' }
]

export default function DashboardPage() {
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState('config')
  const { theme, toggleTheme } = useTheme()

  // ── All persistent state lives in context (survives navigation) ─────────
  const {
    subscription,  setSubscription,
    resourceGroup, setResourceGroup,
    resource,      setResource,
    resourceGroups, setResourceGroups,
    resources,      setResources,
    isScanning,    setIsScanning,
    isMonitoring,  setIsMonitoring,
    isSubmitted,   setIsSubmitted,
    configData,    setConfigData,
    liveEvents,    setLiveEvents,
    driftEvents,    setDriftEvents,
    scanProgress,  setScanProgress,
    policyData,    setPolicyData,
    anomalies,     setAnomalies,
    scanInterval,  monitorScope,  jsonTreeRef,
  } = useDashboard()

  // ── Azure scope data from hook (real API with demo fallback) ───────────
  const {
    subscriptions,
    loading: scopeLoading, isDemoMode,
    fetchRGs, fetchResources,
  } = useAzureScope({ resourceGroups, setResourceGroups, resources, setResources, savedSubscription: subscription, savedResourceGroup: resourceGroup })

  // ── Real-time drift feed via Socket.IO ────────────────────────────────
  const scope = useMemo(
    () => ({ subscriptionId: subscription, resourceGroup, resourceId: resource || null }),
    [subscription, resourceGroup, resource]
  )


  // Task 4: re-fetch live config from ARM when a resource change event arrives
  const handleConfigUpdate = useCallback((event) => {
    if (!event.resourceId && !event.resourceGroup) return
    // If a specific resource is selected and the event is for that resource, use liveState directly
    // If resource group level is selected, always re-fetch the full group config
    if (resource && event.liveState) {
      setConfigData(event.liveState)
    } else {
      fetchResourceConfiguration(subscription, resourceGroup, resource || null)
        .then(cfg => { if (cfg) setConfigData(cfg) })
        .catch(() => {})
    }
  }, [subscription, resourceGroup, resource, setConfigData])

  const { socketConnected, clearDriftEvents } = useDriftSocket(scope, isSubmitted, handleConfigUpdate, driftEvents, setDriftEvents)

  useEffect(() => () => { if (scanInterval.current) clearInterval(scanInterval.current) }, [])

  // Poll live ARM config every 5 seconds when submitted
  useEffect(() => {
    if (!isSubmitted || !subscription || !resourceGroup) return
    const id = setInterval(() => {
      fetchResourceConfiguration(subscription, resourceGroup, resource || null)
        .then(cfg => { if (cfg) setConfigData(cfg) })
        .catch(() => {})
    }, 5000)
    return () => clearInterval(id)
  }, [isSubmitted, subscription, resourceGroup, resource])

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
      ? new Promise(resolve => setTimeout(() => resolve(getDemoConfig()), LIVE_EVENTS_TEMPLATE.length * 100))
      : fetchResourceConfiguration(subscription, resourceGroup, resource || null)

    let idx = 0
    scanInterval.current = setInterval(() => {
      if (idx < LIVE_EVENTS_TEMPLATE.length) {
        setLiveEvents(prev => [...prev, {
          ...LIVE_EVENTS_TEMPLATE[idx],
          timestamp: new Date().toLocaleTimeString(),
          id: Date.now() + idx,
        }])
        setScanProgress(Math.round(((idx + 1) / LIVE_EVENTS_TEMPLATE.length) * 10))
        idx++
      } else {
        clearInterval(scanInterval.current)
        configPromise
          .then(cfg => {
            if (cfg) {
              setIsSubmitted(true)
              setConfigData(cfg)
              // Fetch policy compliance in parallel
              fetchPolicyCompliance(subscription, resourceGroup, resource || null)
                .then(p => setPolicyData(p)).catch(() => setPolicyData(null))
              // Feature 5: AI anomaly detection on drift history
              if (!isDemoMode) {
                fetchAnomalies(subscription)
                  .then(r => setAnomalies(r?.anomalies || []))
                  .catch(() => {})
              }
              // Task 1: seed backend live state cache so first change shows a diff
              if (!isDemoMode && cfg) {
                const toCache = cfg.resources
                  ? cfg.resources.filter(r => r.id)
                  : (cfg.id ? [cfg] : [])
                toCache.forEach(r => cacheState(r.id, r).catch(() => {}))
              }
              // Start real-time monitoring after config loads
              if (!isDemoMode) {
                monitorScope.current = { subscriptionId: subscription, resourceGroupId: resourceGroup, resourceId: resource || null }
                setIsMonitoring(true)
                setLiveEvents(prev => [...prev, {
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
    })
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
    setPolicyData(null)
    setAnomalies([])
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

  const handleGenome = () => {
    if (!resourceGroup) return
    navigate('/genome', {
      state: {
        subscriptionId: subscription,
        resourceGroupId: resourceGroup,
        resourceId: resource || resourceGroup,
        resourceName: resource
          ? resources.find(r => r.id === resource)?.name
          : resourceGroups.find(rg => rg.id === resourceGroup)?.name,
      },
    })
  }

  // ── Stats helpers ─────────────────────────────────────────────────────
  const statsResources = configData?.resources ? configData.resources.length : (configData ? 1 : 0)
  const statsTags      = configData?.resourceGroup
    ? Object.keys(configData.resourceGroup.tags ?? {}).length
    : Object.keys(configData?.tags ?? {}).length
  const statsRegion    = configData?.resourceGroup?.location ?? configData?.location ?? '—'

  const totalEvents = liveEvents.length + driftEvents.length

  return (
    <div className="dashboard">
      <Sidebar />

      <div className="dashboard-main-wrapper">
        {/* ── Top Navbar ──────────────────────────────────── */}
        <nav className="dashboard-nav">
          <div className="dashboard-nav-left">
            <div className="dashboard-nav-title">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2">
                <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                <path d="M2 17l10 5 10-5"/>
                <path d="M2 12l10 5 10-5"/>
              </svg>
              <span>Drift Scanner</span>
            </div>
            {isDemoMode && (
              <span className="demo-mode-badge">Demo mode — connect backend for live data</span>
            )}
          </div>
          <div className="dashboard-nav-right">
            <div className="dashboard-nav-status">
              <div className={`dashboard-status-dot ${isScanning ? 'scanning' : ''}`} />
              <span>{isScanning ? 'Scanning...' : isMonitoring ? 'Monitoring' : 'Ready'}</span>
            </div>
            <button className="theme-toggle" onClick={toggleTheme} title={theme === 'dark' ? 'Switch to Light' : 'Switch to Dark'} id="theme-toggle">
              {theme === 'dark' ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="5"/>
                  <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                  <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                </svg>
              )}
            </button>
            <button className="dashboard-nav-avatar" onClick={() => navigate('/')} title="Sign Out">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                <circle cx="12" cy="7" r="4"/>
              </svg>
            </button>
          </div>
        </nav>

        {/* ── Global Filter Bar ───────────────────────────── */}
        <div className="filter-bar">
          {/* Subscription */}
          <div className="filter-group">
            <label className="filter-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
              Sub
            </label>
            <select
              className="filter-select"
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
              id="filter-subscription"
            >
              <option value="">Select subscription...</option>
              {subscriptions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>

          {/* Resource Group */}
          <div className="filter-group">
            <label className="filter-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              RG
            </label>
            <select
              className="filter-select"
              value={resourceGroup}
              onChange={(e) => {
                const val = e.target.value
                setResourceGroup(val)
                setResource('')
                setConfigData(null)
                fetchResources(subscription, val)
              }}
              disabled={!subscription || scopeLoading}
              id="filter-resource-group"
            >
              <option value="">Select resource group...</option>
              {resourceGroups.map(rg => <option key={rg.id} value={rg.id}>{rg.name}</option>)}
            </select>
          </div>

          {/* Resource */}
          <div className="filter-group">
            <label className="filter-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
              Res
            </label>
            <select
              className="filter-select"
              value={resource}
              onChange={(e) => setResource(e.target.value)}
              disabled={!resourceGroup || scopeLoading}
              id="filter-resource"
            >
              <option value="">All resources</option>
              {resources.map(r => <option key={r.id} value={r.id}>{r.name} ({r.type})</option>)}
            </select>
          </div>

          <div className="filter-divider" />

          {/* Actions */}
          <div className="filter-actions">
            <button
              className="btn btn-primary"
              onClick={handleSubmit}
              disabled={!subscription || !resourceGroup || isScanning || scopeLoading}
              id="btn-submit"
            >
              {isScanning ? (
                <><div className="btn-spinner" /><span>Fetching...</span></>
              ) : (
                <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg><span>Submit</span></>
              )}
            </button>
            <button className="btn btn-danger" onClick={handleStop} disabled={!isScanning && !isMonitoring} id="btn-stop">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
              <span>{isMonitoring ? 'Stop' : 'Stop'}</span>
            </button>
          </div>

          {/* Inline Stats */}
          {configData && !isScanning && (
            <div className="filter-stats">
              <div className="stat-pill stat-pill--info">
                <span className="stat-pill-value">{statsResources}</span> resources
              </div>
              <div className="stat-pill stat-pill--success">
                <span className="stat-pill-value">{statsTags}</span> tags
              </div>
              <div className="stat-pill stat-pill--region">
                <span className="stat-pill-value">{statsRegion}</span>
              </div>
            </div>
          )}

          {/* AI Anomalies inline */}
          {anomalies?.length > 0 && (
            <div className="anomaly-section">
              <span className="anomaly-label">🤖 AI Anomalies</span>
              {anomalies.slice(0, 2).map((a, i) => (
                <div key={i} className="anomaly-card">
                  <div className="anomaly-title">{a.title}</div>
                  <div className="anomaly-desc">{a.description}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Scan Progress ───────────────────────────────── */}
        {isScanning && (
          <div className="scan-progress-bar">
            <div className="scan-progress-fill" style={{ width: `${scanProgress}%` }} />
          </div>
        )}

        {/* ── Tab Bar ─────────────────────────────────────── */}
        <div className="tab-bar">
          <button
            className={`tab-btn ${activeTab === 'config' ? 'active' : ''}`}
            onClick={() => setActiveTab('config')}
            id="tab-config"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
            </svg>
            Live Current Config
          </button>
          <button
            className={`tab-btn ${activeTab === 'activity' ? 'active' : ''}`}
            onClick={() => setActiveTab('activity')}
            id="tab-activity"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            Live Activity Feed
            {totalEvents > 0 && <span className="tab-badge">{totalEvents}</span>}
          </button>

          {/* Tab-contextual actions */}
          <div className="tab-actions">
            {activeTab === 'config' && configData && (
              <>
                <button className="panel-action-btn" onClick={() => jsonTreeRef.current?.expandAll()} title="Expand All">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
                  <span>Expand</span>
                </button>
                <button className="panel-action-btn" onClick={() => jsonTreeRef.current?.collapseAll()} title="Collapse All">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
                  <span>Collapse</span>
                </button>
                
              </>
            )}
            {activeTab === 'activity' && (
              <>
                {isMonitoring && <span className="socket-connected-badge" title="Polling every 30s"><span className="socket-dot"/>Monitoring</span>}
                {socketConnected && !isMonitoring && <span className="socket-connected-badge"><span className="socket-dot"/>Live</span>}
              </>
            )}
          </div>
        </div>

        {/* ── Tab Content ─────────────────────────────────── */}
        {activeTab === 'config' && (
          <div className="tab-content" key="config">
            <section className="panel panel-config">
              <div className="panel-body panel-body-json">
                {!configData && !isScanning && (
                  <div className="panel-empty">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
                    </svg>
                    <p>Select resources above and submit to view detailed JSON configuration</p>
                  </div>
                )}
                {isScanning && !configData && (
                  <div className="panel-scanning">
                    <div className="scanning-indicator">
                      <div className="scanning-ring" />
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                    </div>
                    <p>Fetching resource configuration...</p>
                  </div>
                )}
                {configData && <JsonTree ref={jsonTreeRef} data={configData} />}
              </div>
            </section>
          </div>
        )}

        {activeTab === 'activity' && (
          <div className="tab-content" key="activity">
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
  )
}