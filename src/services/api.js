
// FILE: src/services/api.js
// ROLE: All frontend-to-backend HTTP calls — single source of truth for API communication

// Every function here calls the Express API (VITE_API_BASE_URL, default port 3001)
// All calls go through apiRequest() which handles headers, error checking, and JSON parsing

// Functions grouped by feature:
//   - Azure scope:     fetchSubscriptions, fetchResourceGroups, fetchResources, fetchResourceConfiguration
//   - Baselines:       fetchBaseline, uploadBaseline
//   - Drift & stats:   fetchDriftEvents, fetchRecentChanges, fetchStatsToday, fetchChartStats
//   - Remediation:     remediateToBaseline, requestRemediation
//   - Monitoring:      cacheState, stopMonitoring
//   - Policy:          fetchPolicyCompliance
//   - AI:              fetchAiExplanation, fetchAiRecommendation, fetchAnomalies
//   - Genome:          fetchGenomeSnapshots, saveGenomeSnapshot, promoteGenomeSnapshot,
//                      rollbackToSnapshot, deleteGenomeSnapshot

// Base URL for all API calls — set in .env as VITE_API_BASE_URL (e.g. http://localhost:3001/api)
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api'


// ── apiRequest ───────────────────────────────────────────────────────────────
// Generic fetch wrapper used by every function below
// Builds the full URL, sets Content-Type header, checks for HTTP errors, parses JSON
async function apiRequest(endpoint, options = {}) {
  const fullUrl = `${API_BASE_URL}${endpoint}`
  const requestConfig = {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  }
  const httpResponse = await fetch(fullUrl, requestConfig)
  if (!httpResponse.ok) {
    const errorBody = await httpResponse.text()
    throw new Error(`API Error ${httpResponse.status}: ${errorBody}`)
  }
  return httpResponse.json()
}


// ── Azure Scope ───────────────────────────────────────────────────────────────

// Returns all Azure subscriptions the logged-in credential has access to
// Calls GET /api/subscriptions → uses SubscriptionClient from @azure/arm-subscriptions
export async function fetchSubscriptions() {
  return apiRequest('/subscriptions')
}

// Returns all resource groups in a subscription
// Calls GET /api/subscriptions/:id/resource-groups
export async function fetchResourceGroups(subscriptionId) {
  return apiRequest(`/subscriptions/${subscriptionId}/resource-groups`)
}

// Returns all resources in a resource group
// Calls GET /api/subscriptions/:id/resource-groups/:rg/resources
export async function fetchResources(subscriptionId, resourceGroupId) {
  return apiRequest(`/subscriptions/${subscriptionId}/resource-groups/${resourceGroupId}/resources`)
}

// Fetches the full live ARM JSON config for a resource or resource group
// If resourceId is null, returns the resource group config with all child resources
// Calls GET /api/configuration
export async function fetchResourceConfiguration(subscriptionId, resourceGroupId, resourceId = null) {
  const queryParams = new URLSearchParams({ subscriptionId, resourceGroupId })
  if (resourceId) queryParams.set('resourceId', resourceId)
  return apiRequest(`/configuration?${queryParams}`)
}


// ── Baselines ─────────────────────────────────────────────────────────────────

// Fetches the golden baseline blob for a resource from 'baselines' container
// Returns { subscriptionId, resourceId, resourceState, promotedAt } or null if not found
// Calls GET /api/baselines
export async function fetchBaseline(subscriptionId, resourceId) {
  const queryParams = new URLSearchParams({ subscriptionId, resourceId })
  return apiRequest(`/baselines?${queryParams}`)
}

// Uploads a JSON file as the new golden baseline for a resource
// Accepts raw ARM config JSON or an ARM template export (resources[0] is extracted)
// Calls POST /api/baselines/upload
export async function uploadBaseline(subscriptionId, resourceGroupId, resourceId, baselineData) {
  return apiRequest('/baselines/upload', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId, resourceGroupId, resourceId, baselineData }),
  })
}


// ── Drift & Stats ─────────────────────────────────────────────────────────────

// Returns severity-classified drift records from 'drift-records' blob + driftIndex Table
// These are only created when detectDrift Function finds a deviation from baseline
// Calls GET /api/drift-events
// export async function fetchDriftEvents(subscriptionId, { resourceGroup, severity, since, caller, limit = 500 } = {}) {
//   const queryParams = new URLSearchParams({ subscriptionId, limit })
//   if (resourceGroup) queryParams.set('resourceGroup', resourceGroup)
//   if (severity)      queryParams.set('severity', severity)
//   if (since)         queryParams.set('since', since)
//   if (caller)        queryParams.set('caller', caller)
//   return apiRequest(`/drift-events?${queryParams}`)
// }

// Returns ALL ARM change events from 'all-changes' blob + changesIndex Table
// Includes every write/delete, not just baseline deviations — used by DashboardHome table
// Calls GET /api/changes/recent
export async function fetchRecentChanges(subscriptionId, { resourceGroup, caller, changeType, hours = 24, limit = 20 } = {}) {
  const queryParams = new URLSearchParams({ subscriptionId, hours, limit })
  if (resourceGroup) queryParams.set('resourceGroup', resourceGroup)
  if (caller)        queryParams.set('caller', caller)
  if (changeType)    queryParams.set('changeType', changeType)
  return apiRequest(`/changes/recent?${queryParams}`)
}

// Returns today's stats for KPI cards: { totalChanges, totalDrifted, allTimeTotal }
// Queries changesIndex Table for events since midnight today
// Calls GET /api/stats/today
export async function fetchStatsToday(subscriptionId) {
  return apiRequest(`/stats/today?subscriptionId=${encodeURIComponent(subscriptionId)}`)
}

// Returns bucketed change counts for the bar chart
// mode: '24h' = 24 hourly buckets, '7d' = 7 daily buckets, '30d' = 30 daily buckets
// Returns { mode, buckets: [{ label, count, key }] }
// Calls GET /api/stats/chart
export async function fetchChartStats(subscriptionId, mode = '24h') {
  return apiRequest(`/stats/chart?subscriptionId=${encodeURIComponent(subscriptionId)}&mode=${mode}`)
}


// ── Remediation ───────────────────────────────────────────────────────────────

// Immediately reverts a resource to its golden baseline via ARM PUT (low severity only)
// Calls POST /api/remediate → reads baseline blob → calls armClient.beginCreateOrUpdateAndWait()
export async function remediateToBaseline(subscriptionId, resourceGroupId, resourceId) {
  return apiRequest('/remediate', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId, resourceGroupId, resourceId }),
  })
}

// Sends an approval email for medium/high/critical drift
// Calls POST /api/remediate-request → Logic App → sendAlert Function → ACS email
// Email contains Approve/Reject links pointing back to /api/remediate-decision
export async function requestRemediation(payload) {
  return apiRequest('/remediate-request', { method: 'POST', body: JSON.stringify(payload) })
}


// ── Monitoring ────────────────────────────────────────────────────────────────

// Seeds the diff cache with the current resource state
// Called after Submit so the first Socket.IO event has a previous state to diff against
// Calls POST /api/cache-state → writes to liveStateCache (in-memory + Table Storage)
export async function cacheState(resourceId, state) {
  return apiRequest('/cache-state', {
    method: 'POST',
    body: JSON.stringify({ resourceId, state }),
  })
}

// Marks the monitoring session as inactive in monitorSessions Table Storage
// Called when the user clicks Stop on DriftScanner
// Calls POST /api/monitor/stop
export async function stopMonitoring(subscriptionId, resourceGroupId, resourceId = null) {
  return apiRequest('/monitor/stop', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId, resourceGroupId, resourceId }),
  })
}


// ── Policy ────────────────────────────────────────────────────────────────────

// Returns Azure Policy compliance state for a resource or resource group
// Returns { total, nonCompliant, compliant, violations[] }
// Calls GET /api/policy/compliance → PolicyInsightsClient
// export async function fetchPolicyCompliance(subscriptionId, resourceGroupId, resourceId = null) {
//   const queryParams = new URLSearchParams({ subscriptionId, resourceGroupId })
//   if (resourceId) queryParams.set('resourceId', resourceId)
//   return apiRequest(`/policy/compliance?${queryParams}`)
// }


// ── AI Features ───────────────────────────────────────────────────────────────

// Requests a plain-English explanation of the drift from Azure OpenAI
// Returns { explanation: string }
// Calls POST /api/ai/explain → Express proxy → aiOperations Azure Function → GPT-4o
export async function fetchAiExplanation(driftRecord) {
  return apiRequest('/ai/explain', { method: 'POST', body: JSON.stringify(driftRecord) })
}

// Requests a remediation recommendation explaining what reverting to baseline will do
// Returns { recommendation: string }
// Calls POST /api/ai/recommend → Express proxy → aiOperations Azure Function → GPT-4o
export async function fetchAiRecommendation(driftRecord) {
  return apiRequest('/ai/recommend', { method: 'POST', body: JSON.stringify(driftRecord) })
}

// Requests AI anomaly detection across the last 50 drift records
// Returns { anomalies: [{ title, description, severity, affectedResource }] }
// Calls GET /api/ai/anomalies → Express proxy → aiOperations Azure Function → GPT-4o
// export async function fetchAnomalies(subscriptionId) {
//   return apiRequest(`/ai/anomalies?subscriptionId=${subscriptionId}`)
// }


// ── Configuration Genome ──────────────────────────────────────────────────────

// Returns all versioned snapshots for a resource, sorted newest-first
// Each snapshot: { _blobKey, savedAt, label, resourceState, rolledBackAt }
// Calls GET /api/genome → reads genomeIndex Table + baseline-genome blobs
export async function fetchGenomeSnapshots(subscriptionId, resourceId, limit = 50) {
  const queryParams = new URLSearchParams({ subscriptionId, limit })
  if (resourceId) queryParams.set('resourceId', resourceId)
  return apiRequest(`/genome?${queryParams}`)
}

// Saves the current live ARM config as a new labelled snapshot
// Calls POST /api/genome/save → fetches live config → writes to baseline-genome blob + genomeIndex Table
export async function saveGenomeSnapshot(subscriptionId, resourceGroupId, resourceId, label = '') {
  return apiRequest('/genome/save', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId, resourceGroupId, resourceId, label }),
  })
}

// Promotes a snapshot to the golden baseline
// Calls POST /api/genome/promote → copies snapshot resourceState to baselines blob
export async function promoteGenomeSnapshot(subscriptionId, resourceGroupId, resourceId, blobKey) {
  return apiRequest('/genome/promote', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId, resourceGroupId, resourceId, blobKey }),
  })
}

// Reverts a resource to a snapshot state via ARM PUT
// Calls POST /api/genome/rollback → reads snapshot → armClient.beginCreateOrUpdateAndWait()
// Also sets rolledBackAt on this snapshot and clears it on all others for the resource
export async function rollbackToSnapshot(subscriptionId, resourceGroupId, resourceId, blobKey) {
  return apiRequest('/genome/rollback', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId, resourceGroupId, resourceId, blobKey }),
  })
}

// Permanently deletes a snapshot blob and its genomeIndex Table row
// Calls POST /api/genome/delete
export async function deleteGenomeSnapshot(subscriptionId, blobKey) {
  return apiRequest('/genome/delete', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId, blobKey }),
  })
}


export default {
  fetchSubscriptions,
  fetchResourceGroups,
  fetchResources,
  fetchResourceConfiguration,
}
