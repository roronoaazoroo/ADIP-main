// FILE: src/components/GenomeHistory.jsx
// ROLE: Genome history with category filter + click-to-view config

import React, { useState, useEffect, useMemo } from 'react'
import { fetchCategorizedGenomeHistory, fetchGenomeConfig, fetchResourceConfiguration } from '../services/api'
import GenomeBestConfigs from './GenomeBestConfigs'
import JsonTree from './JsonTree'

const EVENT_CONFIG = {
  created:    { icon: 'add_circle',     label: 'Snapshot created',          color: '#10b981' },
  promoted:   { icon: 'star',           label: 'Set as golden baseline',     color: '#f59e0b' },
  rolledBack: { icon: 'history',        label: 'Resource rolled back to',    color: '#1995ff' },
  deleted:    { icon: 'delete',         label: 'Snapshot deleted',           color: '#ef4444' },
}

// Static category map — maps raw ARM field fragments to friendly filter categories
const FIELD_CATEGORY_MAP = [
  { fragments: ['networkacls', 'defaultaction', 'virtualnetwork', 'subnet', 'publicip', 'loadbalancer', 'ipconfigurations', 'firewall', 'virtualnetworkrules', 'iprules', 'firewallrules'], category: 'Network' },
  { fragments: ['securityrules', 'accesspolicies', 'encryption', 'keysource', 'tls', 'https', 'httpsonly', 'keyvault', 'supportshttpstrafficonly', 'minimumtlsversion', 'allowblobpublicaccess', 'publicaccess'], category: 'Security' },
  { fragments: ['tags'], category: 'Tags' },
  { fragments: ['sku'], category: 'SKU' },
  { fragments: ['identity', 'managedidentity'], category: 'Identity' },
  { fragments: ['location'], category: 'Location' },
]

const DEFAULT_CATEGORIES = ['All', 'Network', 'Security', 'Tags', 'SKU', 'Identity', 'Configuration']

function categorizeFields(changedFields) {
  if (!changedFields || changedFields.trim() === '') return ['Configuration']
  const categories = changedFields.split(',').map(c => c.trim()).filter(c => DEFAULT_CATEGORIES.includes(c))
  return categories.length > 0 ? categories : ['Configuration']
}

export default function GenomeHistory({ subscriptionId, resourceId }) {
  const [historyEvents, setHistoryEvents] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState(null)
  const [selectedConfig, setSelectedConfig] = useState(null)
  const [configLoading, setConfigLoading] = useState(false)
  const [selectedBlobKey, setSelectedBlobKey] = useState(null)
  const [filterCategory, setFilterCategory] = useState('All')

  const loadHistory = (showLoading = false) => {
    if (!subscriptionId || !resourceId) return
    if (showLoading) setIsLoading(true)
    fetchCategorizedGenomeHistory(subscriptionId, resourceId)
      .then(events => { if (events?.length) setHistoryEvents(events) })
      .catch(() => {})
      .finally(() => setIsLoading(false))
  }

  useEffect(() => { loadHistory(true) }, [subscriptionId, resourceId])

  // Silent auto-refresh every 10 seconds — no loading spinner, no flicker
  useEffect(() => {
    if (!subscriptionId || !resourceId) return
    const interval = setInterval(() => loadHistory(false), 10000)
    return () => clearInterval(interval)
  }, [subscriptionId, resourceId])

  // Enrich events with categories
  const enrichedEvents = useMemo(() => {
    return historyEvents.map(e => ({
      ...e,
      categories: categorizeFields(e.changedFields || e.snapshotLabel || ''),
    }))
  }, [historyEvents])

  // Filter events by selected category
  const filteredEvents = useMemo(() => {
    if (filterCategory === 'All') return enrichedEvents
    return enrichedEvents.filter(e => e.categories.includes(filterCategory))
  }, [enrichedEvents, filterCategory])

  // Click handler — fetch config
  const handleEventClick = async (event) => {
    if (!event.blobKey) return
    if (selectedBlobKey === event.blobKey) { setSelectedConfig(null); setSelectedBlobKey(null); return }
    setSelectedBlobKey(event.blobKey)
    setConfigLoading(true)
    setSelectedConfig(null)
    try {
      const result = await fetchGenomeConfig(event.blobKey, subscriptionId, resourceId)
      const config = result?.resourceState || (typeof result === 'object' && result && !result.error ? result : null)
      setSelectedConfig(config)
    } catch (err) {
      console.error('[GenomeHistory] config fetch failed:', err.message)
      // If blob fetch failed, try fetching live config directly as last resort
      try {
        const { fetchResourceConfiguration } = await import('../services/api')
        const parts = (resourceId || '').split('/')
        const rgName = parts[4] || ''
        if (subscriptionId && rgName && resourceId) {
          const liveConfig = await fetchResourceConfiguration(subscriptionId, rgName, resourceId)
          setSelectedConfig(liveConfig || null)
        } else { setSelectedConfig(null) }
      } catch { setSelectedConfig(null) }
    }
    finally { setConfigLoading(false) }
  }

  if (isLoading) return <div className="gp-loading"><div className="gp-loading-ring" /><span>Loading genome history...</span></div>
  if (errorMessage) return <div className="gp-alert gp-alert--error">{errorMessage}</div>
  if (historyEvents.length === 0) return (
    <div className="gp-timeline-empty">
      <span className="material-symbols-outlined" style={{ fontSize: 36, color: '#c2c7d0' }}>manage_history</span>
      <p>No genome activity recorded for this resource yet.</p>
    </div>
  )

  return (
    <div style={{ display: 'flex', gap: 16, minHeight: 400 }}>
      {/* Left: filter + event list */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* AI Best Configs */}
        <GenomeBestConfigs
          subscriptionId={subscriptionId}
          resourceId={resourceId}
          onViewConfig={(blobKey) => handleEventClick({ blobKey })}
          onRollback={(blobKey) => handleEventClick({ blobKey })}
        />

        {/* Category filter */}
        <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {DEFAULT_CATEGORIES.map(cat => (
            <button key={cat} onClick={() => setFilterCategory(cat)}
              style={{
                fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 16, border: '1px solid',
                cursor: 'pointer', transition: 'all 0.2s',
                background: filterCategory === cat ? '#1995ff' : '#f8fafc',
                color: filterCategory === cat ? '#fff' : '#475569',
                borderColor: filterCategory === cat ? '#1995ff' : '#e2e8f0',
              }}>
              {cat}
            </button>
          ))}
          <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 4 }}>{filteredEvents.length} event{filteredEvents.length !== 1 ? 's' : ''}</span>
        </div>

        <div className="gp-rollback-history" style={{ maxHeight: 450, overflowY: 'auto' }}>
          {filteredEvents.map((historyEvent, index) => {
            const config = EVENT_CONFIG[historyEvent.eventType] || EVENT_CONFIG.created
            const isSelected = selectedBlobKey === historyEvent.blobKey
            return (
              <div key={`${historyEvent.blobKey}-${historyEvent.eventType}-${index}`}
                className="gp-rollback-event"
                onClick={() => handleEventClick(historyEvent)}
                style={{ cursor: 'pointer', background: isSelected ? '#f0f9ff' : undefined, borderRadius: 6, padding: '8px 4px' }}>
                <div className="gp-rollback-dot" style={{ background: config.color }} />
                <div className="gp-rollback-event-content">
                  <div className="gp-rollback-event-header">
                    <span className="material-symbols-outlined" style={{ fontSize: 14, color: config.color }}>{config.icon}</span>
                    <span className="gp-rollback-event-time">{new Date(historyEvent.eventAt).toLocaleString()}</span>
                    {historyEvent.isCurrentBaseline && historyEvent.eventType !== 'deleted' && (
                      <span className="gp-rollback-badge gp-rollback-badge--active">Current Baseline</span>
                    )}
                  </div>
                  <div className="gp-rollback-event-detail">
                    {config.label}:&nbsp;<strong>{historyEvent.snapshotLabel}</strong>
                    {historyEvent.caller && (
                      <span style={{ marginLeft: 8, fontSize: 11, color: '#64748b' }}>by <strong>{historyEvent.caller}</strong></span>
                    )}
                    {historyEvent.snapshotType && historyEvent.snapshotType !== 'manual' && (
                      <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
                        background: historyEvent.snapshotType === 'pre-deletion' ? '#fef2f2' : historyEvent.snapshotType === 'stable' ? '#f0fdf4' : historyEvent.snapshotType === 'daily' ? '#eff6ff' : '#f8fafc',
                        color: historyEvent.snapshotType === 'pre-deletion' ? '#dc2626' : historyEvent.snapshotType === 'stable' ? '#16a34a' : historyEvent.snapshotType === 'daily' ? '#2563eb' : '#64748b',
                      }}>{historyEvent.snapshotType.toUpperCase()}</span>
                    )}
                  </div>
                  {/* Category pills */}
                  <div style={{ marginTop: 4, display: 'flex', gap: 4 }}>
                    {historyEvent.categories?.map(cat => (
                      <span key={cat} style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: '#f1f5f9', color: '#475569' }}>{cat}</span>
                    ))}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Right: config viewer */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {configLoading && <div className="gp-loading"><div className="gp-loading-ring" /><span>Loading configuration...</span></div>}
        {!configLoading && selectedConfig && (
          <div style={{ background: '#1e293b', borderRadius: 8, padding: 16, maxHeight: 500, overflow: 'auto' }}>
            <JsonTree data={selectedConfig} />
          </div>
        )}
        {!configLoading && !selectedConfig && selectedBlobKey && (
          <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>Configuration not available for this snapshot</div>
        )}
        {!selectedBlobKey && (
          <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8', fontSize: 13 }}>
            <span className="material-symbols-outlined" style={{ fontSize: 36, display: 'block', marginBottom: 8 }}>arrow_back</span>
            Click an event to view its stored configuration
          </div>
        )}
      </div>
    </div>
  )
}
