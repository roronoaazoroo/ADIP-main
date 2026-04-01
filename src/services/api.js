/**
 * Azure Drift Intelligence Platform — API Service Layer
 * 
 * This module provides a centralized service layer for all backend communication.
 * The workflow is:
 *   1. Button clicked in UI
 *   2. fetch() sends HTTPS request to Azure Function
 *   3. Azure Function receives it and acts as decision engine
 *   4. Azure Function triggers the appropriate Logic App
 *   5. Logic App processes data and returns results
 *   6. Response is sent back to the UI
 * 
 * CONFIGURATION:
 * Set VITE_API_BASE_URL in .env to your Azure Function App URL.
 * Example: VITE_API_BASE_URL=https://your-function-app.azurewebsites.net/api
 */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api'

/**
 * Generic fetch wrapper with error handling.
 * All API calls go through this – making it easy to add auth tokens,
 * logging, retries, etc. in one place.
 */
async function apiRequest(endpoint, options = {}) {
  const url = `${API_BASE_URL}${endpoint}`
  
  const defaultHeaders = {
    'Content-Type': 'application/json',
  }

  // When SSO is integrated, inject the bearer token here:
  // const token = await getAccessToken()
  // if (token) defaultHeaders['Authorization'] = `Bearer ${token}`

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
      throw new Error(`API Error ${response.status}: ${errorBody}`)
    }

    return await response.json()
  } catch (error) {
    console.error(`[API] ${options.method || 'GET'} ${endpoint} failed:`, error)
    throw error
  }
}

// ============================
// Subscription & Resource APIs
// ============================

/**
 * Fetch available Azure subscriptions.
 * Backend flow: Azure Function → Logic App → Azure Management API
 */
export async function fetchSubscriptions() {
  return apiRequest('/subscriptions')
}

/**
 * Fetch resource groups for a given subscription.
 */
export async function fetchResourceGroups(subscriptionId) {
  return apiRequest(`/subscriptions/${subscriptionId}/resource-groups`)
}

/**
 * Fetch resources within a resource group.
 */
export async function fetchResources(subscriptionId, resourceGroupId) {
  return apiRequest(`/subscriptions/${subscriptionId}/resource-groups/${resourceGroupId}/resources`)
}

// ============================
// Configuration & Drift APIs
// ============================

/**
 * Fetch the full JSON configuration of a resource or resource group.
 * This is displayed in the Configuration panel.
 */
export async function fetchResourceConfiguration(subscriptionId, resourceGroupId, resourceId = null) {
  const params = new URLSearchParams({
    subscriptionId,
    resourceGroupId,
    ...(resourceId && { resourceId }),
  })
  return apiRequest(`/configuration?${params}`)
}

/**
 * Start a drift scan. Returns a scan ID for polling.
 * Backend flow: Azure Function (decision engine) → triggers Logic App scan workflow
 */
export async function startDriftScan(subscriptionId, resourceGroupId, resourceId = null) {
  return apiRequest('/scan/start', {
    method: 'POST',
    body: JSON.stringify({
      subscriptionId,
      resourceGroupId,
      resourceId,
    }),
  })
}

/**
 * Stop an in-progress drift scan.
 */
export async function stopDriftScan(scanId) {
  return apiRequest(`/scan/${scanId}/stop`, {
    method: 'POST',
  })
}

/**
 * Poll for scan status and live events.
 * Returns { status, progress, events, results }
 */
export async function getScanStatus(scanId) {
  return apiRequest(`/scan/${scanId}/status`)
}
// ============================
// Baseline Management
// ============================

/**
 * Fetch the active golden baseline for a specific resource.
 * Returns { resourceState, version, approvedAt } or null if no baseline exists.
 */
export async function fetchBaseline(subscriptionId, resourceId) {
  const params = new URLSearchParams({ subscriptionId, resourceId })
  return apiRequest(`/baselines?${params}`)
}

/**
 * Promote the resource's current live state as the new golden baseline.
 * Deactivates any previous baseline for that resource in Cosmos DB.
 */
export async function promoteBaseline(subscriptionId, resourceGroupId, resourceId, resourceState) {
  return apiRequest('/baselines', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId, resourceGroupId, resourceId, resourceState }),
  })
}

// ============================
// Drift Event History
// ============================

/**
 * Fetch paginated drift event history from Cosmos DB.
 */
export async function fetchDriftEvents(subscriptionId, { resourceGroup, severity, limit = 50 } = {}) {
  const params = new URLSearchParams({ subscriptionId, limit })
  if (resourceGroup) params.set('resourceGroup', resourceGroup)
  if (severity) params.set('severity', severity)
  return apiRequest(`/drift-events?${params}`)
}
// ============================
// Authentication (SSO-ready)
// ============================

/**
 * Placeholder for SSO integration.
 * When implementing, use @azure/msal-browser:
 * 
 * import { PublicClientApplication } from '@azure/msal-browser'
 * 
 * const msalConfig = {
 *   auth: {
 *     clientId: import.meta.env.VITE_AZURE_CLIENT_ID,
 *     authority: `https://login.microsoftonline.com/${import.meta.env.VITE_AZURE_TENANT_ID}`,
 *     redirectUri: window.location.origin,
 *   }
 * }
 * 
 * export const msalInstance = new PublicClientApplication(msalConfig)
 * 
 * export async function loginWithMicrosoft() {
 *   const result = await msalInstance.loginPopup({
 *     scopes: ['user.read', 'https://management.azure.com/.default']
 *   })
 *   return result
 * }
 * 
 * export async function getAccessToken() {
 *   const accounts = msalInstance.getAllAccounts()
 *   if (accounts.length === 0) return null
 *   const result = await msalInstance.acquireTokenSilent({
 *     scopes: ['https://management.azure.com/.default'],
 *     account: accounts[0]
 *   })
 *   return result.accessToken
 * }
 */

export default {
  fetchSubscriptions,
  fetchResourceGroups,
  fetchResources,
  fetchResourceConfiguration,
  startDriftScan,
  stopDriftScan,
  getScanStatus,
}

export async function remediateToBaseline(subscriptionId, resourceGroupId, resourceId) {
  return apiRequest('/remediate', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId, resourceGroupId, resourceId }),
  })
}

export async function requestRemediation(payload) {
  return apiRequest('/remediate-request', { method: 'POST', body: JSON.stringify(payload) })
}

export async function uploadBaseline(subscriptionId, resourceGroupId, resourceId, baselineData) {
  return apiRequest('/baselines/upload', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId, resourceGroupId, resourceId, baselineData }),
  })
}

// ============================
// Real-time Monitoring
// ============================

export async function startMonitoring(subscriptionId, resourceGroupId, resourceId = null) {
  return apiRequest('/monitor/start', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId, resourceGroupId, resourceId, intervalMs: 30000 }),
  })
}

export async function cacheState(resourceId, state) {
  return apiRequest('/cache-state', {
    method: 'POST',
    body: JSON.stringify({ resourceId, state }),
  })
}

export async function stopMonitoring(subscriptionId, resourceGroupId, resourceId = null) {
  return apiRequest('/monitor/stop', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId, resourceGroupId, resourceId }),
  })
}

// ============================
// Seed dummy golden baseline
// ============================

export async function seedBaseline(subscriptionId, resourceGroupId, resourceId) {
  return apiRequest('/seed-baseline', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId, resourceGroupId, resourceId }),
  })
}

// ============================
// Policy Compliance
// ============================

export async function fetchPolicyCompliance(subscriptionId, resourceGroupId, resourceId = null) {
  const params = new URLSearchParams({ subscriptionId, resourceGroupId })
  if (resourceId) params.set('resourceId', resourceId)
  return apiRequest(`/policy/compliance?${params}`)
}

// ============================
// AI Features
// ============================

export async function fetchAiExplanation(record) {
  return apiRequest('/ai/explain', { method: 'POST', body: JSON.stringify(record) })
}

export async function fetchAiSeverity(record) {
  return apiRequest('/ai/severity', { method: 'POST', body: JSON.stringify(record) })
}

export async function fetchAiRecommendation(record) {
  return apiRequest('/ai/recommend', { method: 'POST', body: JSON.stringify(record) })
}

export async function fetchAnomalies(subscriptionId) {
  return apiRequest(`/ai/anomalies?subscriptionId=${subscriptionId}`)
}
