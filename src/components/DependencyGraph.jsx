// ============================================================
// FILE: src/components/DependencyGraph.jsx
// ROLE: Renders the resource dependency graph for a resource group.
//
// Uses React Flow for a clean flowchart-style layout with dagre
// for automatic hierarchical positioning. Nodes show Azure service
// type, name, location, and drift status with severity rings.
//
// FEATURE: Clicking a node opens a slide-out detail panel showing
// the resource configuration in a clean, human-readable card format.
// ============================================================
import React, { useState, useEffect, useCallback, useMemo } from 'react'
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  MarkerType,
  Handle,
  Position,
} from 'reactflow'
import dagre from 'dagre'
import { fetchDependencyGraph, fetchResourceConfiguration } from '../services/api'
import 'reactflow/dist/style.css'
import './DependencyGraph.css'

// ── Azure type → icon + color mapping ────────────────────────────────────────
const TYPE_META = {
  'microsoft.storage':     { icon: 'database',         color: '#10b981', label: 'Storage' },
  'microsoft.compute':     { icon: 'memory',           color: '#f97316', label: 'Compute' },
  'microsoft.network':     { icon: 'lan',              color: '#1995ff', label: 'Network' },
  'microsoft.web':         { icon: 'language',         color: '#f59e0b', label: 'Web' },
  'microsoft.logic':       { icon: 'account_tree',     color: '#a78bfa', label: 'Logic' },
  'microsoft.eventgrid':   { icon: 'bolt',             color: '#ec4899', label: 'Event Grid' },
  'microsoft.insights':    { icon: 'monitoring',       color: '#64748b', label: 'Insights' },
  'microsoft.keyvault':    { icon: 'vpn_key',          color: '#f59e0b', label: 'Key Vault' },
  'microsoft.cognitive':   { icon: 'psychology',       color: '#06b6d4', label: 'Cognitive' },
  'microsoft.sql':         { icon: 'storage',          color: '#4f46e5', label: 'SQL' },
  'microsoft.containerservice': { icon: 'view_in_ar',  color: '#8b5cf6', label: 'AKS' },
}

function getTypeMeta(type) {
  const t = (type || '').toLowerCase()
  for (const [prefix, meta] of Object.entries(TYPE_META)) {
    if (t.startsWith(prefix)) return meta
  }
  return { icon: 'cloud', color: '#64748b', label: 'Resource' }
}

// ── Severity styling ─────────────────────────────────────────────────────────
const SEVERITY_STYLE = {
  critical: { color: '#ef4444', bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.5)', glow: '0 0 20px rgba(239,68,68,0.25)' },
  high:     { color: '#f97316', bg: 'rgba(249,115,22,0.06)', border: 'rgba(249,115,22,0.4)', glow: '0 0 16px rgba(249,115,22,0.2)' },
  medium:   { color: '#f59e0b', bg: 'rgba(245,158,11,0.05)', border: 'rgba(245,158,11,0.35)', glow: 'none' },
  low:      { color: '#facc15', bg: 'rgba(250,204,21,0.04)', border: 'rgba(250,204,21,0.3)', glow: 'none' },
}

// ── Friendly property label mapping ──────────────────────────────────────────
const FRIENDLY_LABELS = {
  provisioningState: 'Status',
  vmSize: 'VM Size',
  osType: 'OS',
  osDisk: 'OS Disk',
  managedDisk: 'Managed Disk',
  storageAccountType: 'Disk Type',
  diskSizeGB: 'Disk Size (GB)',
  adminUsername: 'Admin User',
  computerName: 'Computer Name',
  sku: 'SKU / Tier',
  enableSoftDelete: 'Soft Delete',
  enablePurgeProtection: 'Purge Protection',
  enableRbacAuthorization: 'RBAC Auth',
  defaultAction: 'Default Action',
  bypass: 'Bypass',
  networkAcls: 'Network Rules',
  ipRules: 'IP Rules',
  virtualNetworkRules: 'VNet Rules',
  supportsHttpsTrafficOnly: 'HTTPS Only',
  minimumTlsVersion: 'Min TLS Version',
  allowBlobPublicAccess: 'Public Blob Access',
  accessTier: 'Access Tier',
  kind: 'Account Kind',
  httpsOnly: 'HTTPS Only',
  serverFarmId: 'App Service Plan',
  state: 'State',
  hostNames: 'Host Names',
  enabledHostNames: 'Enabled Hosts',
  siteConfig: 'Site Config',
  linuxFxVersion: 'Runtime Stack',
  ftpsState: 'FTPS State',
  http20Enabled: 'HTTP/2',
  alwaysOn: 'Always On',
  addressSpace: 'Address Space',
  addressPrefixes: 'Address Prefixes',
  subnets: 'Subnets',
  securityRules: 'Security Rules',
  direction: 'Direction',
  access: 'Access',
  protocol: 'Protocol',
  sourceAddressPrefix: 'Source',
  destinationAddressPrefix: 'Destination',
  destinationPortRange: 'Port Range',
  priority: 'Priority',
  ipConfigurations: 'IP Configs',
  privateIPAddress: 'Private IP',
  publicIPAddress: 'Public IP',
  publicIPAllocationMethod: 'IP Allocation',
  networkSecurityGroup: 'NSG',
  dnsSettings: 'DNS Settings',
  location: 'Region',
  tags: 'Tags',
  id: 'Resource ID',
  name: 'Name',
  type: 'Type',
}

function friendlyLabel(key) {
  return FRIENDLY_LABELS[key] || key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, s => s.toUpperCase())
    .replace(/_/g, ' ')
    .trim()
}

// ── Value formatter for human-readable display ───────────────────────────────
function formatValue(val) {
  if (val === null || val === undefined) return '—'
  if (typeof val === 'boolean') return val ? '✅ Yes' : '❌ No'
  if (typeof val === 'number') return val.toLocaleString()
  if (typeof val === 'string') {
    if (val.length > 120) return val.slice(0, 117) + '…'
    return val
  }
  if (Array.isArray(val)) {
    if (val.length === 0) return 'None'
    // Array of strings
    if (typeof val[0] === 'string') return val.join(', ')
    return `${val.length} item${val.length !== 1 ? 's' : ''}`
  }
  if (typeof val === 'object') {
    const keys = Object.keys(val)
    if (keys.length === 0) return '{}'
    // Special: if object has id and name, show name
    if (val.name) return val.name
    if (val.id) return val.id.split('/').pop()
    return `${keys.length} properties`
  }
  return String(val)
}

// Keys to skip in detail panel (too noisy / internal)
const SKIP_KEYS = new Set(['id', 'etag', 'resourceGuid', 'uniqueId', 'tenantId', 'objectId'])

// ── Resource Detail Panel Component ──────────────────────────────────────────
function ResourceDetailPanel({ nodeData, configData, configLoading, configError, onClose, onCompare }) {
  const meta = getTypeMeta(nodeData.type)
  const sev = nodeData.isDrifted ? (SEVERITY_STYLE[nodeData.severity] || SEVERITY_STYLE.low) : null

  // Flatten top-level and properties into display sections
  const sections = useMemo(() => {
    if (!configData) return []
    const result = []

    // 1. Overview section
    const overview = {}
    if (configData.name)     overview['Name'] = configData.name
    if (configData.type)     overview['Type'] = configData.type
    if (configData.location) overview['Region'] = configData.location
    if (configData.kind)     overview['Kind'] = configData.kind
    if (configData.sku) {
      overview['SKU'] = typeof configData.sku === 'object'
        ? [configData.sku.name, configData.sku.tier].filter(Boolean).join(' / ')
        : configData.sku
    }
    if (Object.keys(overview).length) {
      result.push({ title: 'Overview', icon: 'info', entries: Object.entries(overview) })
    }

    // 2. Properties section — the main config
    const props = configData.properties || {}
    const propEntries = []
    const nestedSections = []

    for (const [key, val] of Object.entries(props)) {
      if (SKIP_KEYS.has(key)) continue
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        // Nested objects become sub-sections
        const subEntries = Object.entries(val)
          .filter(([k]) => !SKIP_KEYS.has(k))
          .map(([k, v]) => [friendlyLabel(k), formatValue(v)])
        if (subEntries.length > 0) {
          nestedSections.push({ title: friendlyLabel(key), icon: 'settings', entries: subEntries })
        }
      } else if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
        // Array of objects — show count + first item summary
        const items = val.slice(0, 3).map((item, i) => {
          const label = item.name || item.id?.split('/').pop() || `Item ${i + 1}`
          const summary = Object.entries(item)
            .filter(([k]) => !SKIP_KEYS.has(k) && k !== 'name' && k !== 'id')
            .slice(0, 3)
            .map(([k, v]) => `${friendlyLabel(k)}: ${formatValue(v)}`)
            .join(' · ')
          return [label, summary || '—']
        })
        if (val.length > 3) items.push([`+${val.length - 3} more`, ''])
        nestedSections.push({ title: `${friendlyLabel(key)} (${val.length})`, icon: 'list', entries: items })
      } else {
        propEntries.push([friendlyLabel(key), formatValue(val)])
      }
    }

    if (propEntries.length > 0) {
      result.push({ title: 'Configuration', icon: 'tune', entries: propEntries })
    }
    result.push(...nestedSections)

    // 3. Tags section
    const tags = configData.tags || {}
    const tagEntries = Object.entries(tags)
    if (tagEntries.length > 0) {
      result.push({ title: 'Tags', icon: 'sell', entries: tagEntries })
    }

    return result
  }, [configData])

  return (
    <div className="dg-detail-overlay" onClick={onClose}>
      <div className="dg-detail-panel" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="dg-detail-header">
          <div className="dg-detail-header-top">
            <div className="dg-detail-icon" style={{ background: `${meta.color}15`, color: meta.color }}>
              <span className="material-symbols-outlined">{meta.icon}</span>
            </div>
            <button className="dg-detail-close" onClick={onClose} title="Close">
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>
          <h3 className="dg-detail-name">{nodeData.fullName}</h3>
          <span className="dg-detail-type">{nodeData.type}</span>
          {nodeData.location && (
            <span className="dg-detail-location">
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>location_on</span>
              {nodeData.location}
            </span>
          )}
          {nodeData.isDrifted && (
            <div className="dg-detail-drift-alert" style={{ borderColor: sev?.border, background: sev?.bg }}>
              <span className="material-symbols-outlined" style={{ fontSize: 16, color: sev?.color }}>warning</span>
              <span style={{ color: sev?.color, fontWeight: 600 }}>
                {nodeData.driftCount} drift event{nodeData.driftCount !== 1 ? 's' : ''} — {nodeData.severity} severity
              </span>
            </div>
          )}
        </div>

        {/* Body */}
        <div className="dg-detail-body">
          {configLoading && (
            <div className="dg-detail-loading">
              <div className="dg-loading-ring" style={{ width: 28, height: 28 }} />
              <span>Loading configuration…</span>
            </div>
          )}

          {configError && (
            <div className="dg-detail-error">
              <span className="material-symbols-outlined">error_outline</span>
              <span>{configError}</span>
            </div>
          )}

          {!configLoading && !configError && sections.length === 0 && (
            <div className="dg-detail-empty">
              <span className="material-symbols-outlined" style={{ fontSize: 28, color: '#94a3b8' }}>description</span>
              <span>No configuration data available</span>
            </div>
          )}

          {sections.map((section, si) => (
            <div className="dg-detail-section" key={si}>
              <div className="dg-detail-section-title">
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>{section.icon}</span>
                {section.title}
              </div>
              <div className="dg-detail-grid">
                {section.entries.map(([label, value], ei) => (
                  <div className="dg-detail-row" key={ei}>
                    <span className="dg-detail-key">{label}</span>
                    <span className="dg-detail-val" title={typeof value === 'string' && value.length > 50 ? value : undefined}>
                      {value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer actions */}
        <div className="dg-detail-footer">
          {onCompare && (
            <button className="dg-detail-btn dg-detail-btn--primary" onClick={() => onCompare(nodeData)}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>compare_arrows</span>
              Compare Drift
            </button>
          )}
          <button className="dg-detail-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Custom Node Component ────────────────────────────────────────────────────
function ResourceNode({ data }) {
  const meta = getTypeMeta(data.type)
  const sev = data.isDrifted ? (SEVERITY_STYLE[data.severity] || SEVERITY_STYLE.low) : null

  return (
    <div
      className={`dg-node ${data.isDrifted ? 'dg-node--drifted' : ''}`}
      style={{
        borderColor: sev ? sev.border : 'rgba(0,0,0,0.08)',
        background: sev ? sev.bg : '#ffffff',
        boxShadow: sev ? sev.glow + ', 0 2px 12px rgba(0,0,0,0.06)' : '0 2px 12px rgba(0,0,0,0.06)',
      }}
    >
      <Handle type="target" position={Position.Top} className="dg-handle" />

      {/* Drift badge */}
      {data.isDrifted && data.driftCount > 0 && (
        <div className="dg-drift-badge" style={{ background: sev?.color || '#ef4444' }}>
          {data.driftCount > 9 ? '9+' : data.driftCount}
        </div>
      )}

      {/* Icon */}
      <div className="dg-node-icon" style={{ background: `${meta.color}15`, color: meta.color }}>
        <span className="material-symbols-outlined">{meta.icon}</span>
      </div>

      {/* Info */}
      <div className="dg-node-info">
        <span className="dg-node-name" title={data.fullName}>{data.label}</span>
        <span className="dg-node-type">{meta.label}</span>
      </div>

      {/* Drift severity indicator */}
      {data.isDrifted && (
        <div className="dg-node-severity" style={{ color: sev?.color }}>
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>warning</span>
          <span>{data.severity}</span>
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="dg-handle" />
    </div>
  )
}

const nodeTypes = { resource: ResourceNode }

// ── Dagre layout ─────────────────────────────────────────────────────────────
const NODE_WIDTH = 200
const NODE_HEIGHT = 90

function layoutGraph(nodes, edges) {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'TB', ranksep: 100, nodesep: 60, marginx: 40, marginy: 40 })

  nodes.forEach(node => {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  })
  edges.forEach(edge => {
    g.setEdge(edge.source, edge.target)
  })

  dagre.layout(g)

  return nodes.map(node => {
    const pos = g.node(node.id)
    return {
      ...node,
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
    }
  })
}

// ── Main Component ───────────────────────────────────────────────────────────
export default function DependencyGraph({ subscriptionId, resourceGroupId, onNodeClick }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [isEmpty, setIsEmpty] = useState(false)

  // Detail panel state
  const [selectedNode, setSelectedNode] = useState(null)
  const [detailConfig, setDetailConfig] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState(null)

  // Build unique legend from loaded nodes
  const legend = useMemo(() => {
    const seen = new Map()
    nodes.forEach(n => {
      const meta = getTypeMeta(n.data?.type)
      if (!seen.has(meta.label)) seen.set(meta.label, meta)
    })
    return [...seen.entries()]
  }, [nodes])

  useEffect(() => {
    if (!subscriptionId || !resourceGroupId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setIsEmpty(false)

    fetchDependencyGraph(subscriptionId, resourceGroupId)
      .then(data => {
        if (cancelled) return
        const rawNodes = data.nodes || []
        const rawLinks = data.links || []

        if (!rawNodes.length) {
          setIsEmpty(true)
          setLoading(false)
          return
        }

        // Build React Flow nodes
        const flowNodes = rawNodes.map(n => ({
          id: n.id,
          type: 'resource',
          position: { x: 0, y: 0 },
          data: {
            label: (n.name || '').length > 20 ? n.name.slice(0, 18) + '…' : n.name,
            fullName: n.name,
            type: n.type,
            isDrifted: n.isDrifted,
            severity: n.severity || 'none',
            driftCount: n.driftCount || 0,
            lastDriftAt: n.lastDriftAt,
            location: n.location,
            id: n.id,
          },
        }))

        // Build React Flow edges
        const flowEdges = rawLinks.map((link, i) => ({
          id: `e-${i}`,
          source: link.source,
          target: link.target,
          label: link.label || '',
          type: 'smoothstep',
          animated: false,
          style: { stroke: '#94a3b8', strokeWidth: 1.5 },
          labelStyle: { fontSize: 10, fill: '#64748b', fontWeight: 500 },
          labelBgStyle: { fill: '#ffffff', fillOpacity: 0.9 },
          labelBgPadding: [6, 3],
          labelBgBorderRadius: 4,
          markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8', width: 16, height: 16 },
        }))

        // Apply dagre layout
        const layoutedNodes = layoutGraph(flowNodes, flowEdges)
        setNodes(layoutedNodes)
        setEdges(flowEdges)
      })
      .catch(err => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [subscriptionId, resourceGroupId])

  // Handle node click — open detail panel and fetch config
  const onNodeClickHandler = useCallback((event, node) => {
    const data = node.data
    setSelectedNode(data)
    setDetailConfig(null)
    setDetailError(null)
    setDetailLoading(true)

    fetchResourceConfiguration(subscriptionId, resourceGroupId, data.id)
      .then(config => {
        setDetailConfig(config)
      })
      .catch(err => {
        setDetailError(err.message || 'Failed to load configuration')
      })
      .finally(() => {
        setDetailLoading(false)
      })
  }, [subscriptionId, resourceGroupId])

  // Close detail panel
  const closeDetail = useCallback(() => {
    setSelectedNode(null)
    setDetailConfig(null)
    setDetailError(null)
  }, [])

  // Navigate to comparison page from detail panel
  const handleCompare = useCallback((nodeData) => {
    if (onNodeClick) {
      onNodeClick({ id: nodeData.id, name: nodeData.fullName })
    }
  }, [onNodeClick])

  // Minimap node color
  const minimapColor = useCallback((node) => {
    const meta = getTypeMeta(node.data?.type)
    return node.data?.isDrifted ? '#ef4444' : meta.color
  }, [])

  if (loading) return (
    <div className="dg-status">
      <div className="dg-loading-ring" />
      <p>Building resource topology…</p>
    </div>
  )
  if (error) return (
    <div className="dg-status dg-status--error">
      <span className="material-symbols-outlined" style={{ fontSize: 32 }}>error_outline</span>
      <p>{error}</p>
    </div>
  )
  if (isEmpty) return (
    <div className="dg-status">
      <span className="material-symbols-outlined" style={{ fontSize: 32, color: '#94a3b8' }}>device_hub</span>
      <p>No resources found in this resource group.</p>
    </div>
  )

  return (
    <div className="dg-container">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClickHandler}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#e2e8f0" gap={20} size={1} />
        <Controls
          showInteractive={false}
          className="dg-controls"
        />
        <MiniMap
          nodeColor={minimapColor}
          maskColor="rgba(243,243,246,0.7)"
          className="dg-minimap"
          pannable
          zoomable
        />
      </ReactFlow>

      {/* Legend */}
      <div className="dg-legend">
        <div className="dg-legend-title">Resource Types</div>
        {legend.map(([label, meta]) => (
          <div key={label} className="dg-legend-item">
            <span className="dg-legend-dot" style={{ background: meta.color }} />
            {label}
          </div>
        ))}
        <div className="dg-legend-divider" />
        <div className="dg-legend-item">
          <span className="dg-legend-dot dg-legend-dot--drift" />
          Drifted
        </div>
        <div className="dg-legend-item">
          <span className="dg-legend-dot dg-legend-dot--ok" />
          No drift
        </div>
      </div>

      {/* Click hint */}
      <div className="dg-click-hint">
        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>touch_app</span>
        Click a resource to view its configuration
      </div>

      {/* Detail panel — slides in when a node is clicked */}
      {selectedNode && (
        <ResourceDetailPanel
          nodeData={selectedNode}
          configData={detailConfig}
          configLoading={detailLoading}
          configError={detailError}
          onClose={closeDetail}
          onCompare={onNodeClick ? handleCompare : null}
        />
      )}
    </div>
  )
}
