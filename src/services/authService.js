// ============================================================
// FILE: src/services/authService.js
// ROLE: Frontend auth API calls + token management
// ============================================================

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api'

async function authRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Request failed')
  return data
}

export async function createOrganization({ organizationName, name, email, password, subscriptionId, retentionDays, requiredApprovals }) {
  const data = await authRequest('/auth/create-org', {
    method: 'POST',
    body: JSON.stringify({ organizationName, name, email, password, subscriptionId, retentionDays, requiredApprovals }),
  })
  sessionStorage.setItem('adip.token', data.token)
  sessionStorage.setItem('adip.user', JSON.stringify(data))
  return data
}

export async function joinOrganization({ orgId, name, email, password }) {
  const data = await authRequest('/auth/join-org', {
    method: 'POST',
    body: JSON.stringify({ orgId, name, email, password }),
  })
  sessionStorage.setItem('adip.token', data.token)
  sessionStorage.setItem('adip.user', JSON.stringify(data))
  return data
}

export async function loginUser({ email, password }) {
  const data = await authRequest('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
  sessionStorage.setItem('adip.token', data.token)
  sessionStorage.setItem('adip.user', JSON.stringify(data))
  return data
}

export function getAuthToken() {
  return sessionStorage.getItem('adip.token')
}

export function getCurrentUser() {
  try { return JSON.parse(sessionStorage.getItem('adip.user') || 'null') } catch { return null }
}

export function logoutUser() {
  sessionStorage.removeItem('adip.token')
  sessionStorage.removeItem('adip.user')
}

export function isAuthenticated() {
  return !!getAuthToken()
}


// ── Organization Management ───────────────────────────────────────────────────

export async function fetchOrgMembers() {
  const token = getAuthToken()
  const response = await fetch(`${API_BASE}/org/members`, { headers: { Authorization: `Bearer ${token}` } })
  if (!response.ok) throw new Error((await response.json()).error || 'Failed')
  return response.json()
}

export async function updateMemberRole(userId, role) {
  const token = getAuthToken()
  const response = await fetch(`${API_BASE}/org/members/${userId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ role }),
  })
  if (!response.ok) throw new Error((await response.json()).error || 'Failed')
  return response.json()
}

export async function fetchNotifications() {
  const token = getAuthToken()
  const response = await fetch(`${API_BASE}/org/notifications`, { headers: { Authorization: `Bearer ${token}` } })
  if (!response.ok) throw new Error((await response.json()).error || 'Failed')
  return response.json()
}

export async function markNotificationRead(rowKey) {
  const token = getAuthToken()
  const response = await fetch(`${API_BASE}/org/notifications/${rowKey}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw new Error((await response.json()).error || 'Failed')
  return response.json()
}

export async function fetchOrganizations() {
  const response = await fetch(`${API_BASE}/auth/organizations`)
  if (!response.ok) throw new Error('Failed to load organizations')
  return response.json()
}
