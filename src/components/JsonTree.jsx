import React, { useState, useCallback, useImperativeHandle, forwardRef } from 'react'
import './JsonTree.css'

const JsonTree = forwardRef(function JsonTree({ data }, ref) {
  const [expandedNodes, setExpandedNodes] = useState(new Set())

  const toggleNode = useCallback((path) => {
    setExpandedNodes(prev => {
      const next = new Set(prev)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })
  }, [])

  useImperativeHandle(ref, () => ({
    expandAll() {
      const paths = new Set()
      const collect = (obj, prefix = '') => {
        if (obj && typeof obj === 'object') {
          paths.add(prefix)
          if (Array.isArray(obj)) {
            obj.forEach((v, i) => collect(v, `${prefix}[${i}]`))
          } else {
            Object.entries(obj).forEach(([k, v]) => collect(v, prefix ? `${prefix}.${k}` : k))
          }
        }
      }
      collect(data)
      setExpandedNodes(paths)
    },
    collapseAll() {
      setExpandedNodes(new Set())
    },
  }), [data])

  const renderNode = (val, path = '', depth = 0) => {
    if (val === null || val === undefined) return <span className="json-null">null</span>
    if (typeof val === 'boolean') return <span className="json-bool">{String(val)}</span>
    if (typeof val === 'number') return <span className="json-number">{val}</span>
    if (typeof val === 'string') return <span className="json-string">"{val}"</span>

    if (Array.isArray(val)) {
      if (val.length === 0) return <span className="json-bracket">[]</span>
      const isExpanded = expandedNodes.has(path)
      return (
        <span className="json-array">
          <button className="json-toggle" onClick={() => toggleNode(path)}>
            <span className={`json-arrow ${isExpanded ? 'expanded' : ''}`}>▶</span>
          </button>
          <span className="json-bracket">[</span>
          <span className="json-count">{val.length} items</span>
          {isExpanded && (
            <div className="json-children">
              {val.map((item, i) => (
                <div key={i} className="json-entry" style={{ paddingLeft: `${(depth + 1) * 16}px` }}>
                  <span className="json-index">{i}: </span>
                  {renderNode(item, `${path}[${i}]`, depth + 1)}
                </div>
              ))}
            </div>
          )}
          {isExpanded && <span className="json-bracket" style={{ paddingLeft: `${depth * 16}px` }}>]</span>}
        </span>
      )
    }

    if (typeof val === 'object') {
      const entries = Object.entries(val)
      if (entries.length === 0) return <span className="json-bracket">{'{}'}</span>
      const isExpanded = expandedNodes.has(path)
      return (
        <span className="json-object">
          <button className="json-toggle" onClick={() => toggleNode(path)}>
            <span className={`json-arrow ${isExpanded ? 'expanded' : ''}`}>▶</span>
          </button>
          <span className="json-bracket">{'{'}</span>
          <span className="json-count">{entries.length} properties</span>
          {isExpanded && (
            <div className="json-children">
              {entries.map(([k, v]) => (
                <div key={k} className="json-entry" style={{ paddingLeft: `${(depth + 1) * 16}px` }}>
                  <span className="json-key">"{k}"</span>
                  <span className="json-colon">: </span>
                  {renderNode(v, path ? `${path}.${k}` : k, depth + 1)}
                </div>
              ))}
            </div>
          )}
          {isExpanded && <span className="json-bracket" style={{ paddingLeft: `${depth * 16}px` }}>{'}'}</span>}
        </span>
      )
    }

    return <span>{String(val)}</span>
  }

  return <div className="json-tree">{renderNode(data)}</div>
})

export default JsonTree