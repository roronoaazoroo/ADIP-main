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

// Azure service icons — colored dots used as fallback
const ICON_MAP = {}


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

  // Custom canvas node renderer — severity-differentiated drift ring + drift count badge
  const paintNode = (node, ctx, globalScale) => {
    const r    = 18
    const x    = node.x
    const y    = node.y
    const img  = loadIcon(node.type)

    // Severity → ring style
    const severityStyle = {
      critical: { color: '#ef4444', width: 4,   glow: 'rgba(239,68,68,0.3)',   bg: 'rgba(239,68,68,0.2)' },
      high:     { color: '#f97316', width: 3,   glow: 'rgba(249,115,22,0.25)', bg: 'rgba(249,115,22,0.15)' },
      medium:   { color: '#f59e0b', width: 2.5, glow: null,                    bg: 'rgba(245,158,11,0.12)' },
      low:      { color: '#facc15', width: 2,   glow: null,                    bg: 'rgba(250,204,21,0.1)' },
    }
    const sev   = node.isDrifted ? (severityStyle[node.severity] || severityStyle.low) : null
    const color = nodeColor(node.type)

    // Background circle
    ctx.beginPath()
    ctx.arc(x, y, r, 0, 2 * Math.PI)
    ctx.fillStyle = sev ? sev.bg : 'rgba(255,255,255,0.08)'
    ctx.fill()

    // Glow for critical
    if (sev?.glow) {
      ctx.beginPath()
      ctx.arc(x, y, r + 3, 0, 2 * Math.PI)
      ctx.strokeStyle = sev.glow
      ctx.lineWidth   = 6
      ctx.stroke()
    }

    // Border ring
    ctx.beginPath()
    ctx.arc(x, y, r, 0, 2 * Math.PI)
    ctx.strokeStyle = sev ? sev.color : color
    ctx.lineWidth   = sev ? sev.width : 1.5
    ctx.stroke()

    // Azure icon
    if (img?.complete && img.naturalWidth > 0) {
      const iconSize = r * 1.4
      try { ctx.drawImage(img, x - iconSize / 2, y - iconSize / 2, iconSize, iconSize) } catch {}
    } else {
      ctx.beginPath()
      ctx.arc(x, y, r * 0.5, 0, 2 * Math.PI)
      ctx.fillStyle = color
      ctx.fill()
    }

    // Drift count badge (top-right corner)
    if (node.isDrifted && node.driftCount > 0) {
      const bx = x + r * 0.7
      const by = y - r * 0.7
      ctx.beginPath()
      ctx.arc(bx, by, 7, 0, 2 * Math.PI)
      ctx.fillStyle = sev ? sev.color : '#ef4444'
      ctx.fill()
      ctx.font        = `bold ${Math.max(7, 9 / globalScale)}px Inter, sans-serif`
      ctx.textAlign   = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle   = '#fff'
      ctx.fillText(node.driftCount > 9 ? '9+' : String(node.driftCount), bx, by)
    }

    // Label
    const label    = node.name || ''
    const fontSize = Math.max(8, 11 / globalScale)
    ctx.font        = `${fontSize}px Inter, sans-serif`
    ctx.textAlign   = 'center'
    ctx.textBaseline = 'top'
    ctx.fillStyle   = sev ? sev.color : '#e2e8f0'
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
        nodeLabel={node => {
          let label = `${node.name}\n${node.type}`
          if (node.isDrifted) {
            label += `\n⚠ ${node.driftCount || 1} drift event${(node.driftCount || 1) !== 1 ? 's' : ''} (${node.severity})`
            if (node.lastDriftAt) {
              const ago = Math.round((Date.now() - new Date(node.lastDriftAt)) / 3600000)
              label += `\nLast: ${ago < 24 ? ago + 'h ago' : Math.round(ago/24) + 'd ago'}`
            }
          }
          return label
        }}
        nodeCanvasObject={paintNode}
        nodeCanvasObjectMode={() => 'replace'}
        nodeRelSize={18}
        linkLabel={link => link.label || ''}
        linkColor={() => 'rgba(100,116,139,0.5)'}
        linkDirectionalArrowLength={4}
        linkDirectionalArrowRelPos={1}
        linkCurvature={0.1}
        onNodeClick={undefined}
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
