// FILE: src/services/rgPredictionApi.js
const BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api'

export async function fetchRgPrediction(subscriptionId, resourceGroup) {
  const params = new URLSearchParams({ subscriptionId, resourceGroup })
  const res = await fetch(`${BASE}/rg-prediction?${params}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
