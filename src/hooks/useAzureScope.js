import { useState, useEffect, useCallback } from 'react'
import {
  fetchSubscriptions as apiFetchSubs,
  fetchResourceGroups as apiFetchRGs,
  fetchResources as apiFetchResources,
} from '../services/api'

const DEMO_SUBS = [
  { id: 'sub-1', name: 'Production - Enterprise (a1b2c3d4-...)' },
  { id: 'sub-2', name: 'Development - Team (e5f6g7h8-...)' },
  { id: 'sub-3', name: 'Staging - QA (i9j0k1l2-...)' },
]
const DEMO_RGS = {
  'sub-1': [{ id: 'rg-1', name: 'rg-prod-eastus' }, { id: 'rg-2', name: 'rg-prod-westeurope' }, { id: 'rg-3', name: 'rg-prod-networking' }],
  'sub-2': [{ id: 'rg-4', name: 'rg-dev-sandbox' }, { id: 'rg-5', name: 'rg-dev-testing' }],
  'sub-3': [{ id: 'rg-6', name: 'rg-staging-apps' }, { id: 'rg-7', name: 'rg-staging-data' }],
}
const DEMO_RESOURCES = {
  'rg-1': [{ id: 'r-1', name: 'vm-prod-web-01', type: 'Virtual Machine' }, { id: 'r-2', name: 'sql-prod-main', type: 'SQL Database' }, { id: 'r-3', name: 'kv-prod-secrets', type: 'Key Vault' }],
  'rg-2': [{ id: 'r-4', name: 'app-prod-api', type: 'App Service' }, { id: 'r-5', name: 'func-prod-worker', type: 'Function App' }],
  'rg-3': [{ id: 'r-6', name: 'vnet-prod-main', type: 'Virtual Network' }, { id: 'r-7', name: 'nsg-prod-frontend', type: 'Network Security Group' }],
}


// ── useAzureScope START ──────────────────────────────────────────────────────
// Accepts persisted resourceGroups/resources + their setters from context
// so dropdown options survive navigation and stop
export function useAzureScope({ resourceGroups, setResourceGroups, resources, setResources, savedSubscription, savedResourceGroup }) {
  const [subscriptions, setSubscriptions] = useState([])
  const [loading, setLoading] = useState(false)
  const [scopeError, setScopeError] = useState(null)
  const [isDemoMode, setIsDemoMode] = useState(false)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const data = await apiFetchSubs()
        setSubscriptions(
          Array.isArray(data)
            ? data.map(s => ({ id: s.id ?? s.subscriptionId, name: s.name ?? s.displayName }))
            : []
        )
        setIsDemoMode(false)
      } catch {
        setSubscriptions(DEMO_SUBS)
        setIsDemoMode(true)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  // Re-fetch RGs on mount if a subscription was already selected (restores after navigation)
  useEffect(() => {
    if (savedSubscription && resourceGroups.length === 0) {
      fetchRGs(savedSubscription)
    }
  }, [savedSubscription]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch resources on mount if a RG was already selected
  useEffect(() => {
    if (savedSubscription && savedResourceGroup && resources.length === 0) {
      fetchResources(savedSubscription, savedResourceGroup)
    }
  }, [savedSubscription, savedResourceGroup]) // eslint-disable-line react-hooks/exhaustive-deps

  const fetchRGs = useCallback(async (subscriptionId) => {
    if (!subscriptionId) { setResourceGroups([]); setResources([]); return }
    setLoading(true)
    setResourceGroups([])
    setResources([])
    setScopeError(null)
    try {
      if (isDemoMode) {
        await new Promise(r => setTimeout(r, 150))
        setResourceGroups(DEMO_RGS[subscriptionId] ?? [])
      } else {
        const data = await apiFetchRGs(subscriptionId)
        setResourceGroups(data.map(rg => ({ id: rg.name ?? rg.id, name: rg.name, location: rg.location })))
      }
    } catch (err) {
      setScopeError(err.message)
    } finally {
      setLoading(false)
    }
  }, [isDemoMode, setResourceGroups, setResources])

  const fetchResources = useCallback(async (subscriptionId, resourceGroupId) => {
    if (!resourceGroupId) { setResources([]); return }
    setLoading(true)
    setResources([])
    setScopeError(null)
    try {
      if (isDemoMode) {
        await new Promise(r => setTimeout(r, 100))
        setResources(DEMO_RESOURCES[resourceGroupId] ?? [])
      } else {
        const data = await apiFetchResources(subscriptionId, resourceGroupId)
        setResources(data.map(r => ({ id: r.id, name: r.name, type: r.type?.split('/').pop() ?? r.type })))
      }
    } catch (err) {
      setScopeError(err.message)
    } finally {
      setLoading(false)
    }
  }, [isDemoMode, setResources])

  return { subscriptions, resourceGroups, resources, loading, scopeError, isDemoMode, fetchRGs, fetchResources }
}
// ── useAzureScope END ────────────────────────────────────────────────────────
