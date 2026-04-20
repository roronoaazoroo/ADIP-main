/**
 * Azure Drift Intelligence Platform — API Service Layer
 * All backend communication is centralised here.
 */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api'


// ── apiRequest START ─────────────────────────────────────────────────────────
// Generic fetch wrapper used by all API calls — handles headers, error checking, and JSON parsing
async function apiRequest(endpoint, options = {}) {
  console.log('[apiRequest] starts — endpoint:', endpoint, 'method:', options.method || 'GET')
  const url = `${API_BASE_URL}${endpoint}`

  const defaultHeaders = {
    'Content-Type': 'application/json',
  }

  const config = {
    ...options,
    headers: {
      ...defaultHeaders,
      ...options.headers,
    },
  }

  try {
    const response = await fetch(url, config)

    if (!response.ok) {
      const errorBody = await response.text()
      console.log('[apiRequest] ends — HTTP error', response.status)
      throw new Error(`API Error ${response.status}: ${errorBody}`)
    }

    const data = await response.json()
    console.log('[apiRequest] ends — success')
    return data
  } catch (error) {
    console.error(`[API] ${options.method || 'GET'} ${endpoint} failed:`, error)
    console.log('[apiRequest] ends — caught error')
    throw error
  }
}
// ── apiRequest END ───────────────────────────────────────────────────────────


// ── fetchSubscriptions START ─────────────────────────────────────────────────
// Returns all Azure subscriptions accessible to the logged-in credential
export async function fetchSubscriptions() {
  console.log('[fetchSubscriptions] starts')
  const result = await apiRequest('/subscriptions')
  console.log('[fetchSubscriptions] ends')
  return result
}
// ── fetchSubscriptions END ───────────────────────────────────────────────────


// ── fetchResourceGroups START ────────────────────────────────────────────────
// Returns resource groups for a given subscription ID
export async function fetchResourceGroups(subscriptionId) {
  console.log('[fetchResourceGroups] starts — subscriptionId:', subscriptionId)
  const result = await apiRequest(`/subscriptions/${subscriptionId}/resource-groups`)
  console.log('[fetchResourceGroups] ends')
  return result
}
// ── fetchResourceGroups END ──────────────────────────────────────────────────


// ── fetchResources START ─────────────────────────────────────────────────────
// Returns resources in a given resource group
export async function fetchResources(subscriptionId, resourceGroupId) {
  console.log('[fetchResources] starts — subscriptionId:', subscriptionId, 'rg:', resourceGroupId)
  const result = await apiRequest(`/subscriptions/${subscriptionId}/resource-groups/${resourceGroupId}/resources`)
  console.log('[fetchResources] ends')
  return result
}
// ── fetchResources END ───────────────────────────────────────────────────────


// ── fetchResourceConfiguration START ────────────────────────────────────────
// Fetches the full live JSON configuration for a resource or resource group
export async function fetchResourceConfiguration(subscriptionId, resourceGroupId, resourceId = null) {
  console.log('[fetchResourceConfiguration] starts — subscriptionId:', subscriptionId, 'resourceId:', resourceId)
  const params = new URLSearchParams({
    subscriptionId,
    resourceGroupId,
    ...(resourceId && { resourceId }),
  })
  const result = await apiRequest(`/configuration?${params}`)
  console.log('[fetchResourceConfiguration] ends')
  return result
}
// ── fetchResourceConfiguration END ──────────────────────────────────────────








// ── fetchBaseline START ──────────────────────────────────────────────────────
// Fetches the active golden baseline for a resource
export async function fetchBaseline(subscriptionId, resourceId) {
  console.log('[fetchBaseline] starts — subscriptionId:', subscriptionId, 'resourceId:', resourceId)
  const params = new URLSearchParams({ subscriptionId, resourceId })
  const result = await apiRequest(`/baselines?${params}`)
  console.log('[fetchBaseline] ends')
  return result
}
// ── fetchBaseline END ────────────────────────────────────────────────────────






// ── remediateToBaseline START ────────────────────────────────────────────────
// Immediately reverts a resource to its golden baseline via ARM PUT
export async function remediateToBaseline(subscriptionId, resourceGroupId, resourceId) {
  console.log('[remediateToBaseline] starts — resourceId:', resourceId)
  const result = await apiRequest('/remediate', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId, resourceGroupId, resourceId }),
  })
  console.log('[remediateToBaseline] ends')
  return result
}
// ── remediateToBaseline END ──────────────────────────────────────────────────


// ── requestRemediation START ─────────────────────────────────────────────────
// Sends an approval email for drift remediation (used for non-low severity)
export async function requestRemediation(payload) {
  console.log('[requestRemediation] starts')
  const result = await apiRequest('/remediate-request', { method: 'POST', body: JSON.stringify(payload) })
  console.log('[requestRemediation] ends')
  return result
}
// ── requestRemediation END ───────────────────────────────────────────────────


// ── uploadBaseline START ─────────────────────────────────────────────────────
// Uploads a custom JSON file as the golden baseline for a resource
export async function uploadBaseline(subscriptionId, resourceGroupId, resourceId, baselineData) {
  console.log('[uploadBaseline] starts — resourceId:', resourceId)
  const result = await apiRequest('/baselines/upload', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId, resourceGroupId, resourceId, baselineData }),
  })
  console.log('[uploadBaseline] ends')
  return result
}
// ── uploadBaseline END ───────────────────────────────────────────────────────




// ── cacheState START ─────────────────────────────────────────────────────────
// Sends the current resource config to the backend cache so first change has a diff
export async function fetchDriftEvents(subscriptionId, { resourceGroup, severity, since, caller, limit = 50 } = {}) {
  const params = new URLSearchParams({ subscriptionId, limit })
  if (resourceGroup) params.set('resourceGroup', resourceGroup)
  if (severity) params.set('severity', severity)
  if (since) params.set('since', since)
  if (caller) params.set('caller', caller)
  return apiRequest(`/drift-events?${params}`)
}

export async function fetchRecentChanges(subscriptionId, { resourceGroup, caller, changeType, hours = 24, limit = 200 } = {}) {
  const params = new URLSearchParams({ subscriptionId, hours, limit })
  if (resourceGroup) params.set('resourceGroup', resourceGroup)
  if (caller)        params.set('caller', caller)
  if (changeType)    params.set('changeType', changeType)
  return apiRequest(`/changes/recent?${params}`)
}

export async function fetchChartStats(subscriptionId, mode = '24h') {
  return apiRequest(`/stats/chart?subscriptionId=${encodeURIComponent(subscriptionId)}&mode=${mode}`)
}

export async function fetchStatsToday(subscriptionId) {
  return apiRequest(`/stats/today?subscriptionId=${encodeURIComponent(subscriptionId)}`)
}
// ── fetchDriftEvents END ──────────────────────────────────────────────────────



export async function cacheState(resourceId, state) {
  console.log('[cacheState] starts — resourceId:', resourceId)
  const result = await apiRequest('/cache-state', {
    method: 'POST',
    body: JSON.stringify({ resourceId, state }),
  })
  console.log('[cacheState] ends')
  return result
}
// ── cacheState END ───────────────────────────────────────────────────────────


// ── stopMonitoring START ─────────────────────────────────────────────────────
// Stops the server-side polling monitor for the selected scope
export async function stopMonitoring(subscriptionId, resourceGroupId, resourceId = null) {
  console.log('[stopMonitoring] starts — subscriptionId:', subscriptionId)
  const result = await apiRequest('/monitor/stop', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId, resourceGroupId, resourceId }),
  })
  console.log('[stopMonitoring] ends')
  return result
}
// ── stopMonitoring END ───────────────────────────────────────────────────────




// ── fetchPolicyCompliance START ──────────────────────────────────────────────
// Returns Azure Policy compliance state for a resource or resource group
export async function fetchPolicyCompliance(subscriptionId, resourceGroupId, resourceId = null) {
  console.log('[fetchPolicyCompliance] starts — subscriptionId:', subscriptionId)
  const params = new URLSearchParams({ subscriptionId, resourceGroupId })
  if (resourceId) params.set('resourceId', resourceId)
  const result = await apiRequest(`/policy/compliance?${params}`)
  console.log('[fetchPolicyCompliance] ends')
  return result
}
// ── fetchPolicyCompliance END ────────────────────────────────────────────────


// ── fetchAiExplanation START ─────────────────────────────────────────────────
// Requests an AI-generated plain-English drift explanation from Azure OpenAI
export async function fetchAiExplanation(record) {
  console.log('[fetchAiExplanation] starts')
  const result = await apiRequest('/ai/explain', { method: 'POST', body: JSON.stringify(record) })
  console.log('[fetchAiExplanation] ends')
  return result
}
// ── fetchAiExplanation END ───────────────────────────────────────────────────




// ── fetchAiRecommendation START ──────────────────────────────────────────────
// Requests an AI remediation recommendation explaining what revert will do
export async function fetchAiRecommendation(record) {
  console.log('[fetchAiRecommendation] starts')
  const result = await apiRequest('/ai/recommend', { method: 'POST', body: JSON.stringify(record) })
  console.log('[fetchAiRecommendation] ends')
  return result
}
// ── fetchAiRecommendation END ────────────────────────────────────────────────


// ── fetchAnomalies START ─────────────────────────────────────────────────────
// Requests AI anomaly detection analysis over recent drift history
export async function fetchAnomalies(subscriptionId) {
  console.log('[fetchAnomalies] starts — subscriptionId:', subscriptionId)
  const result = await apiRequest(`/ai/anomalies?subscriptionId=${subscriptionId}`)
  console.log('[fetchAnomalies] ends')
  return result
}
// ── fetchAnomalies END ───────────────────────────────────────────────────────


// ── fetchGenomeSnapshots START ───────────────────────────────────────────────
// Returns the versioned snapshot history for a resource from the genome container
export async function fetchGenomeSnapshots(subscriptionId, resourceId, limit = 50) {
  console.log('[fetchGenomeSnapshots] starts — resourceId:', resourceId)
  const params = new URLSearchParams({ subscriptionId, limit })
  if (resourceId) params.set('resourceId', resourceId)
  const result = await apiRequest(`/genome?${params}`)
  console.log('[fetchGenomeSnapshots] ends')
  return result
}
// ── fetchGenomeSnapshots END ─────────────────────────────────────────────────


// ── saveGenomeSnapshot START ─────────────────────────────────────────────────
// Saves the current live config as a labelled genome snapshot
export async function saveGenomeSnapshot(subscriptionId, resourceGroupId, resourceId, label = '') {
  console.log('[saveGenomeSnapshot] starts — resourceId:', resourceId, 'label:', label)
  const result = await apiRequest('/genome/save', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId, resourceGroupId, resourceId, label }),
  })
  console.log('[saveGenomeSnapshot] ends')
  return result
}
// ── saveGenomeSnapshot END ───────────────────────────────────────────────────


// ── promoteGenomeSnapshot START ──────────────────────────────────────────────
// Promotes a genome snapshot to the golden baseline
export async function promoteGenomeSnapshot(subscriptionId, resourceGroupId, resourceId, blobKey) {
  console.log('[promoteGenomeSnapshot] starts — blobKey:', blobKey)
  const result = await apiRequest('/genome/promote', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId, resourceGroupId, resourceId, blobKey }),
  })
  console.log('[promoteGenomeSnapshot] ends')
  return result
}
// ── promoteGenomeSnapshot END ────────────────────────────────────────────────


// ── rollbackToSnapshot START ─────────────────────────────────────────────────
// Rolls back an Azure resource to a specific genome snapshot via ARM PUT
export async function rollbackToSnapshot(subscriptionId, resourceGroupId, resourceId, blobKey) {
  console.log('[rollbackToSnapshot] starts — blobKey:', blobKey)
  const result = await apiRequest('/genome/rollback', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId, resourceGroupId, resourceId, blobKey }),
  })
  console.log('[rollbackToSnapshot] ends')
  return result
}
// ── rollbackToSnapshot END ───────────────────────────────────────────────────

// ── deleteGenomeSnapshot START ────────────────────────────────────────────────
// Deletes a genome snapshot from blob storage and its index entry
export async function deleteGenomeSnapshot(subscriptionId, blobKey) {
  console.log('[deleteGenomeSnapshot] starts — blobKey:', blobKey)
  const result = await apiRequest('/genome/delete', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId, blobKey }),
  })
  console.log('[deleteGenomeSnapshot] ends')
  return result
}
// ── deleteGenomeSnapshot END ──────────────────────────────────────────────────





export default {
  fetchSubscriptions,
  fetchResourceGroups,
  fetchResources,
  fetchResourceConfiguration,
}