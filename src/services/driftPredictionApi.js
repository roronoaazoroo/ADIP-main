// FILE: src/services/driftPredictionApi.js
// ROLE: Frontend API calls for Drift Prediction & Forecasting feature

const BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api'

/**
 * Fetches AI drift prediction for a specific resource.
 * @returns {{ likelihood, predictedDays, fieldsAtRisk, reasoning, basedOn }}
 */
export async function fetchDriftPrediction(subscriptionId, resourceId) {
  const params = new URLSearchParams({ subscriptionId, resourceId })
  const res = await fetch(`${BASE}/ai/predict?${params}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

/**
 * Fetches AI-generated recommendations based on drift history for a resource.
 * @returns {Array<{ title, description, priority, action }>}
 */
export async function fetchDriftRecommendations(subscriptionId, resourceId) {
  const params = new URLSearchParams({ subscriptionId, resourceId })
  const res = await fetch(`${BASE}/ai/recommendations?${params}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

/**
 * Fetches AI recommendations scoped to all drifted resources in a resource group.
 * @returns {Array<{ title, description, priority, action, affectedResources }>}
 */
export async function fetchRgRecommendations(subscriptionId, resourceGroup) {
  const params = new URLSearchParams({ subscriptionId, resourceGroup })
  const res = await fetch(`${BASE}/ai/rg-recommendations?${params}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

/**
 * Fetches drift event history for a resource (used for the frequency chart).
 * @returns {Array<driftRecord>}
 */
export async function fetchDriftHistory(subscriptionId, resourceId) {
  const params = new URLSearchParams({ subscriptionId, resourceId, limit: 30 })
  const res = await fetch(`${BASE}/drift-events?${params}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
