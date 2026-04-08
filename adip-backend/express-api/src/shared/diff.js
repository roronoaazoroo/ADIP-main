'use strict'
const { VOLATILE } = require('./constants')

function strip(obj) {
  if (Array.isArray(obj)) return obj.map(strip)
  if (obj && typeof obj === 'object')
    return Object.fromEntries(
      Object.entries(obj)
        .filter(([k]) => !VOLATILE.includes(k))
        .map(([k, v]) => [k, strip(v)])
    )
  return obj
}

// Flatten _childConfig into top-level so baselines saved before child-config
// was added still diff cleanly against current enriched state
function normalize(obj) {
  if (!obj || typeof obj !== 'object') return obj
  const { _childConfig, ...rest } = obj
  if (_childConfig) Object.entries(_childConfig).forEach(([k, v]) => { rest[k] = v })
  return rest
}

function safeStr(val) {
  if (val === null || val === undefined) return 'null'
  if (typeof val === 'object') return JSON.stringify(val)
  return String(val)
}

function computeDiff(prev, curr, path, results) {
  if (prev === null || prev === undefined) {
    if (curr !== null && curr !== undefined) {
      if (typeof curr === 'object' && !Array.isArray(curr)) {
        for (const k of Object.keys(curr)) computeDiff(undefined, curr[k], `${path} \u2192 ${k}`, results)
      } else {
        const field = path.split(' \u2192 ').pop()
        const isTag = path.includes('tags')
        results.push({ path, type: 'added', oldValue: null, newValue: curr,
          sentence: isTag ? `added tag '${field}' = "${curr}"` : `added "${field}" = ${safeStr(curr)}` })
      }
    }
    return
  }
  if (curr === null || curr === undefined) {
    const field = path.split(' \u2192 ').pop()
    const isTag = path.includes('tags')
    results.push({ path, type: 'removed', oldValue: prev, newValue: null,
      sentence: isTag ? `deleted tag '${field}'` : `removed "${field}" (was ${safeStr(prev)})` })
    return
  }
  if (Array.isArray(prev) && Array.isArray(curr)) {
    const stableStr = (v) => JSON.stringify(v, Object.keys(v || {}).sort())
    const normArr   = (a) => JSON.stringify(a.map(i => typeof i === 'object' && i ? stableStr(i) : i).sort())
    if (normArr(prev) !== normArr(curr)) {
      const added   = curr.filter(c => !prev.some(p => JSON.stringify(p) === JSON.stringify(c)))
      const removed = prev.filter(p => !curr.some(c => JSON.stringify(c) === JSON.stringify(p)))
      const field   = path.split(' \u2192 ').pop()
      if (added.length)   results.push({ path, type: 'array-added',   oldValue: prev, newValue: curr, sentence: `added ${added.length} item(s) to "${field}"` })
      if (removed.length) results.push({ path, type: 'array-removed', oldValue: prev, newValue: curr, sentence: `removed ${removed.length} item(s) from "${field}"` })
      if (!added.length && !removed.length) results.push({ path, type: 'array-reordered', oldValue: prev, newValue: curr, sentence: `reordered items in "${field}"` })
    }
    return
  }
  if (typeof prev === 'object' && typeof curr === 'object') {
    const allKeys = new Set([...Object.keys(prev), ...Object.keys(curr)])
    for (const k of allKeys) computeDiff(prev[k], curr[k], path ? `${path} \u2192 ${k}` : k, results)
    return
  }
  if (prev !== curr) {
    const field = path.split(' \u2192 ').pop()
    const isTag = path.includes('tags')
    results.push({ path, type: 'modified', oldValue: prev, newValue: curr,
      sentence: isTag
        ? `changed tag '${field}' from "${prev}" to "${curr}"`
        : `changed "${field}" from "${safeStr(prev)}" to "${safeStr(curr)}"` })
  }
}

function diffObjects(prev, curr) {
  const results = []
  computeDiff(normalize(strip(prev)), normalize(strip(curr)), '', results)
  return results.filter(r => r.path !== '')
}

module.exports = { strip, normalize, diffObjects }
