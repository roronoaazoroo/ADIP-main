// ============================================================
// FILE: adip-backend/express-api/src/services/featureBuilder.js
// ROLE: Builds 13-feature vector per resource (mirrors training/feature_engineering.py)
// ============================================================
'use strict'

function callerEntropy(callers) {
  if (!callers.length) return 0
  const counts = {}
  callers.forEach(c => { counts[c] = (counts[c] || 0) + 1 })
  const total = callers.length
  let entropy = 0
  Object.values(counts).forEach(count => {
    const p = count / total
    if (p > 0) entropy -= p * Math.log2(p)
  })
  return entropy
}

/**
 * Builds a 13-element feature vector for one resource.
 * @param {object} params
 * @returns {number[]} 13-element array
 */
function buildFeatureVector({ resourceId, changes, drifts, baselineDate, callerDriftCounts, rgDriftCount, rgResourceCount }) {
  const now = Date.now()
  const total = changes.length
  if (total === 0) return new Array(13).fill(0)

  const changeTimes = changes.map(c => new Date(c.detectedAt).getTime()).filter(t => !isNaN(t)).sort((a, b) => a - b)
  const driftTimes = drifts.map(d => new Date(d.detectedAt).getTime()).filter(t => !isNaN(t)).sort((a, b) => a - b)

  // 1. change_frequency_7d
  const sevenDaysAgo = now - 7 * 86400000
  const changes7d = changeTimes.filter(t => t >= sevenDaysAgo).length
  const changeFrequency7d = changes7d / 7

  // 2. min_inter_arrival_hours
  let minInterArrival = 720
  for (let i = 1; i < changeTimes.length; i++) {
    const delta = (changeTimes[i] - changeTimes[i - 1]) / 3600000
    if (delta < minInterArrival) minInterArrival = delta
  }

  // 3. drift_ratio
  const driftRatio = drifts.length / total

  // 4. max_severity_score
  const sevMap = { low: 0, medium: 1, high: 2, critical: 3 }
  let maxSeverity = 0
  drifts.forEach(d => { maxSeverity = Math.max(maxSeverity, sevMap[d.severity] || 0) })

  // 5. current_drift_streak
  let streak = 0
  if (driftTimes.length) {
    streak = 1
    for (let i = driftTimes.length - 1; i > 0; i--) {
      if ((driftTimes[i] - driftTimes[i - 1]) / 3600000 < 24) streak++
      else break
    }
  }

  // 6. days_since_last_drift
  const daysSinceLastDrift = driftTimes.length ? (now - driftTimes[driftTimes.length - 1]) / 86400000 : 30

  // 7. recency_hours
  const recencyHours = changeTimes.length ? (now - changeTimes[changeTimes.length - 1]) / 3600000 : 720

  // 8. caller_entropy
  const callers = changes.map(c => c.caller).filter(Boolean)
  const entropy = callerEntropy(callers)

  // 9. caller_drift_rate
  let callerDriftRate = 0
  if (callers.length && callerDriftCounts) {
    const counts = {}
    callers.forEach(c => { counts[c] = (counts[c] || 0) + 1 })
    const primary = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]
    if (primary) callerDriftRate = Math.min((callerDriftCounts[primary] || 0) / 50, 1)
  }

  // 10. resource_type_encoded
  const typeMap = { storageaccounts: 0, virtualmachines: 1, vaults: 2, networksecuritygroups: 3, sites: 4, workflows: 5 }
  const parts = resourceId.toLowerCase().split('/')
  const rtype = parts[7] || ''
  const resourceTypeEncoded = typeMap[rtype] ?? 6

  // 11. rg_drift_density
  const rgDriftDensity = (rgDriftCount || 0) / Math.max(rgResourceCount || 1, 1)

  // 12. days_since_baseline_set
  let daysSinceBaseline = 30
  if (baselineDate) {
    const blTime = new Date(baselineDate).getTime()
    if (!isNaN(blTime)) daysSinceBaseline = (now - blTime) / 86400000
  }

  // 13. delete_event_ratio
  const deleteCount = changes.filter(c => c.changeType === 'deleted').length
  const deleteRatio = deleteCount / total

  return [
    changeFrequency7d, minInterArrival, driftRatio, maxSeverity,
    streak, daysSinceLastDrift, recencyHours, entropy,
    callerDriftRate, resourceTypeEncoded, rgDriftDensity,
    daysSinceBaseline, deleteRatio,
  ]
}

module.exports = { buildFeatureVector }
