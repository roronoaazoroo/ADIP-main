// ============================================================
// FILE: src/components/DependencyGraph.jsx
// ROLE: Renders the resource dependency graph for a resource group.
//
// Uses react-force-graph-2d for force-directed layout.
// Nodes turn red when the resource has drifted recently.
// Clicking a node navigates to its ComparisonPage.
//
// Props:
//   subscriptionId   — Azure subscription ID
//   resourceGroupId  — Resource group name
//   onNodeClick      — (node) => void — called when a node is clicked
// ============================================================
import React, { useState, useEffect, useRef } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import { fetchDependencyGraph } from '../services/api'

export default function DependencyGraph({ subscriptionId, resourceGroupId, onNodeClick }) {
  const [graphData,  setGraphData]  = useState({ nodes: [], links: [] })
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState(null)
  const containerRef = useRef(null)
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })

  // Measure container size for the canvas
  useEffect(() => {
    if (!containerRef.current) return
    const { offsetWidth, offsetHeight } = containerRef.current
    setDimensions({ width: offsetWidth || 800, height: offsetHeight || 600 })
  }, [containerRef.current])

  useEffect(() => {
    if (!subscriptionId || !resourceGroupId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchDependencyGraph(subscriptionId, resourceGroupId)
      .then(data => {
        if (cancelled) return
        // react-force-graph-2d expects 'links' not 'edges'
        setGraphData({ nodes: data.nodes || [], links: data.links || [] })
      })
      .catch(err => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [subscriptionId, resourceGroupId])

  if (loading) return (
    <div role="status" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#6b7280', fontSize: 14 }}>
      <div className="skeleton" style={{ width: 18, height: 18, borderRadius: '50%', marginRight: 10 }} />
      Building dependency graph...
    </div>
  )

  if (error) return (
    <div role="alert" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#ef4444', fontSize: 14 }}>
      {error}
    </div>
  )

  if (!graphData.nodes.length) return (
    <div role="status" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#64748b', fontSize: 14 }}>
      No resources found in this resource group.
    </div>
  )

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }} role="img" aria-label="Resource dependency graph visualization">
      <ForceGraph2D
        graphData={graphData}
        width={dimensions.width}
        height={dimensions.height}
        nodeLabel={node => `${node.name}\n${node.type}${node.isDrifted ? '\n⚠ Drifted recently' : ''}`}
        nodeColor={node => node.isDrifted ? '#ef4444' : node.color}
        nodeRelSize={6}
        nodeVal={node => node.val || 4}
        linkLabel={link => link.label || ''}
        linkColor={() => 'rgba(100,116,139,0.6)'}
        linkDirectionalArrowLength={4}
        linkDirectionalArrowRelPos={1}
        linkCurvature={0.1}
        onNodeClick={node => onNodeClick && onNodeClick(node)}
        backgroundColor="transparent"
      />

      {/* Legend */}
      <div style={{ position: 'absolute', top: 12, right: 12, background: 'rgba(15,23,42,0.85)', padding: '10px 14px', borderRadius: 8, fontSize: 12, color: '#e2e8f0', border: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Legend</div>
        {[
          { color: '#ef4444', label: 'Drifted' },
          { color: '#1995ff', label: 'Network' },
          { color: '#f97316', label: 'Compute' },
          { color: '#10b981', label: 'Storage' },
          { color: '#f59e0b', label: 'App Service' },
          { color: '#64748b', label: 'Other' },
        ].map(({ color, label }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block' }} />
            {label}
          </div>
        ))}
      </div>
    </div>
  )
}
