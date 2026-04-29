// ============================================================
// FILE: src/components/DependencyGraph.jsx
// ROLE: Renders the resource dependency graph for a resource group.
//
// Uses react-force-graph-2d for force-directed layout.
// Nodes render with Azure service icons (official Microsoft icon CDN).
// Drifted nodes get a red ring overlay.
// Clicking a node navigates to its ComparisonPage.
// ============================================================
import React, { useState, useEffect, useRef } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import { fetchDependencyGraph } from '../services/api'

// Azure service icons — GitHub CDN (CORS allowed, no auth required)
const ICON_MAP = {
  'microsoft.storage/storageaccounts':          'https://raw.githubusercontent.com/Azure/azure-icons/main/icons/Storage/Storage-Accounts.svg',
  'microsoft.compute/virtualmachines':          'https://raw.githubusercontent.com/Azure/azure-icons/main/icons/Compute/Virtual-Machine.svg',
  'microsoft.compute/disks':                    'https://raw.githubusercontent.com/Azure/azure-icons/main/icons/Compute/Disk.svg',
  'microsoft.network/virtualnetworks':          'https://raw.githubusercontent.com/Azure/azure-icons/main/icons/Networking/Virtual-Networks.svg',
  'microsoft.network/networksecuritygroups':    'https://raw.githubusercontent.com/Azure/azure-icons/main/icons/Networking/Network-Security-Groups.svg',
  'microsoft.network/networkinterfaces':        'https://raw.githubusercontent.com/Azure/azure-icons/main/icons/Networking/Network-Interfaces.svg',
  'microsoft.network/publicipaddresses':        'https://raw.githubusercontent.com/Azure/azure-icons/main/icons/Networking/Public-IP-Addresses.svg',
  'microsoft.web/sites':                        'https://raw.githubusercontent.com/Azure/azure-icons/main/icons/App-Services/App-Services.svg',
  'microsoft.web/serverfarms':                  'https://raw.githubusercontent.com/Azure/azure-icons/main/icons/App-Services/App-Service-Plans.svg',
  'microsoft.logic/workflows':                  'https://raw.githubusercontent.com/Azure/azure-icons/main/icons/Integration/Logic-Apps.svg',
  'microsoft.eventgrid/topics':                 'https://raw.githubusercontent.com/Azure/azure-icons/main/icons/Integration/Event-Grid-Topics.svg',
  'microsoft.insights/components':              'https://raw.githubusercontent.com/Azure/azure-icons/main/icons/Management-Governance/Application-Insights.svg',
  'microsoft.keyvault/vaults':                  'https://raw.githubusercontent.com/Azure/azure-icons/main/icons/Security/Key-Vaults.svg',
  'microsoft.cognitiveservices/accounts':       'https://raw.githubusercontent.com/Azure/azure-icons/main/icons/AI-Machine-Learning/Cognitive-Services.svg',
  'microsoft.communication/communicationservices': 'https://raw.githubusercontent.com/Azure/azure-icons/main/icons/Web/Communication-Services.svg',
}

// Fallback color per type family (used when icon fails to load)
const TYPE_COLOR = {
  'microsoft.storage':     '#10b981',
  'microsoft.compute':     '#f97316',
  'microsoft.network':     '#1995ff',
  'microsoft.web':         '#f59e0b',
  'microsoft.logic':       '#a78bfa',
  'microsoft.eventgrid':   '#ec4899',
  'microsoft.insights':    '#64748b',
  'microsoft.keyvault':    '#f59e0b',
  'microsoft.cognitive':   '#06b6d4',
}

function nodeColor(type) {
  const t = (type || '').toLowerCase()
  for (const [prefix, color] of Object.entries(TYPE_COLOR)) {
    if (t.startsWith(prefix)) return color
  }
  return '#64748b'
}

// Preloads an Image and returns it (cached)
const _imgCache = {}
function loadIcon(type) {
  const key = (type || '').toLowerCase()
  if (_imgCache[key]) return _imgCache[key]
  const url = ICON_MAP[key]
  if (!url) return null
  const img = new Image()
  img.src = url
  img.crossOrigin = 'anonymous'
  _imgCache[key] = img
  return img
}

export default function DependencyGraph({ subscriptionId, resourceGroupId, onNodeClick }) {
  const [graphData,  setGraphData]  = useState({ nodes: [], links: [] })
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState(null)
  const containerRef = useRef(null)
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })

  useEffect(() => {
    if (!containerRef.current) return
    const { offsetWidth, offsetHeight } = containerRef.current
    setDimensions({ width: offsetWidth || 800, height: offsetHeight || 600 })
  }, [containerRef.current])

  useEffect(() => {
    if (!subscriptionId || !resourceGroupId) return
    let cancelled = false
    setLoading(true)
    fetchDependencyGraph(subscriptionId, resourceGroupId)
      .then(data => {
        if (cancelled) return
        const nodes = (data.nodes || [])
        // Preload all icons
        nodes.forEach(n => loadIcon(n.type))
        setGraphData({ nodes, links: data.links || [] })
      })
      .catch(err => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [subscriptionId, resourceGroupId])

  // Custom canvas node renderer — draws Azure icon + red ring for drifted nodes
  const paintNode = (node, ctx, globalScale) => {
    const r    = 18
    const x    = node.x
    const y    = node.y
    const img  = loadIcon(node.type)
    const color = nodeColor(node.type)

    // Background circle
    ctx.beginPath()
    ctx.arc(x, y, r, 0, 2 * Math.PI)
    ctx.fillStyle = node.isDrifted ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.08)'
    ctx.fill()

    // Border
    ctx.beginPath()
    ctx.arc(x, y, r, 0, 2 * Math.PI)
    ctx.strokeStyle = node.isDrifted ? '#ef4444' : color
    ctx.lineWidth   = node.isDrifted ? 2.5 : 1.5
    ctx.stroke()

    // Azure icon (if loaded)
    if (img?.complete && img.naturalWidth > 0) {
      const iconSize = r * 1.4
      try {
        ctx.drawImage(img, x - iconSize / 2, y - iconSize / 2, iconSize, iconSize)
      } catch { /* cross-origin fallback */ }
    } else {
      // Fallback: colored dot
      ctx.beginPath()
      ctx.arc(x, y, r * 0.5, 0, 2 * Math.PI)
      ctx.fillStyle = color
      ctx.fill()
    }

    // Label below node
    const label     = node.name || ''
    const fontSize  = Math.max(8, 11 / globalScale)
    ctx.font        = `${fontSize}px Inter, sans-serif`
    ctx.textAlign   = 'center'
    ctx.textBaseline = 'top'
    ctx.fillStyle   = node.isDrifted ? '#ef4444' : '#e2e8f0'
    ctx.fillText(label.length > 18 ? label.slice(0, 16) + '…' : label, x, y + r + 3)
  }

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#94a3b8', fontSize: 14 }}>
      Building dependency graph...
    </div>
  )
  if (error) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#ef4444', fontSize: 14 }}>
      {error}
    </div>
  )
  if (!graphData.nodes.length) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#64748b', fontSize: 14 }}>
      No resources found in this resource group.
    </div>
  )

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <ForceGraph2D
        graphData={graphData}
        width={dimensions.width}
        height={dimensions.height}
        nodeLabel={node => `${node.name}\n${node.type}${node.isDrifted ? '\n⚠ Drifted recently' : ''}`}
        nodeCanvasObject={paintNode}
        nodeCanvasObjectMode={() => 'replace'}
        nodeRelSize={18}
        linkLabel={link => link.label || ''}
        linkColor={() => 'rgba(100,116,139,0.5)'}
        linkDirectionalArrowLength={4}
        linkDirectionalArrowRelPos={1}
        linkCurvature={0.1}
        onNodeClick={node => onNodeClick && onNodeClick(node)}
        backgroundColor="transparent"
      />

      {/* Legend */}
      <div style={{ position: 'absolute', top: 12, right: 12, background: 'rgba(15,23,42,0.85)', padding: '10px 14px', borderRadius: 8, fontSize: 12, color: '#e2e8f0', border: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Legend</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid #ef4444', background: 'rgba(239,68,68,0.15)', display: 'inline-block' }} />
          Drifted recently
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 12, height: 12, borderRadius: '50%', border: '1.5px solid #64748b', background: 'rgba(255,255,255,0.08)', display: 'inline-block' }} />
          No drift
        </div>
      </div>
    </div>
  )
}
