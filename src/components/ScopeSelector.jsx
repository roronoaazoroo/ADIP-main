// FILE: src/components/ScopeSelector.jsx
// ROLE: Searchable multi-scope selector for DriftScanner

// Single subscription → searchable multi-select RGs (with name + location filter)
// → optional specific resource when exactly 1 RG selected

// Output: scopes[] = [{ id, subscriptionId, resourceGroupId, resourceId }]
// Props:
//   scopes        — current scopes array
//   subscriptions — available subscriptions
//   onChange(scopes) — called when selection changes

import React, { useState, useEffect, useMemo } from 'react'
import { fetchResourceGroups, fetchResources } from '../services/api'
import MultiSelectDropdown from './MultiSelectDropdown'

export default function ScopeSelector({ scopes, subscriptions, onChange, children }) {
  const subscriptionId = scopes[0]?.subscriptionId || ''
  const selectedRGs    = [...new Set(scopes.map(s => s.resourceGroupId).filter(Boolean))]
  const resourceId     = scopes[0]?.resourceId || ''

  const [rgs,       setRgs]       = useState([])
  const [resources, setResources] = useState([])
  const selectedResources = [...new Set(scopes.map(s => s.resourceId).filter(Boolean))]

  // Load RGs when subscription changes
  useEffect(() => {
    if (!subscriptionId) { setRgs([]); return }
    fetchResourceGroups(subscriptionId).then(setRgs).catch(() => {})
  }, [subscriptionId])

  // Load resources from ALL selected RGs in parallel — append as each loads, no flicker
  useEffect(() => {
    if (!subscriptionId || !selectedRGs.length) { setResources([]); return }
    let cancelled = false
    // Fetch all in parallel, update state as each resolves
    selectedRGs.forEach(rg => {
      fetchResources(subscriptionId, rg)
        .then(res => {
          if (cancelled) return
          setResources(prev => {
            // Remove old entries for this RG, add new ones
            const others = prev.filter(r => r.id.split('/')[4]?.toLowerCase() !== rg.toLowerCase())
            return [...others, ...(res || [])]
          })
        })
        .catch(() => {})
    })
    return () => { cancelled = true }
  }, [subscriptionId, selectedRGs.join(',')])

  const rgOptions = useMemo(() =>
    rgs.map(rg => ({ value: rg.name || rg.id, label: rg.name || rg.id })),
    [rgs]
  )

  const updateSubscription = (subId) => {
    onChange([{ id: Date.now(), subscriptionId: subId, resourceGroupId: '', resourceId: '' }])
  }

  const updateRGs = (selectedValues) => {
    if (!selectedValues.length) {
      onChange([{ id: Date.now(), subscriptionId, resourceGroupId: '', resourceId: '' }])
      return
    }
    // Preserve existing resource selections per RG where possible
    onChange(selectedValues.map(rg => {
      const existing = scopes.find(s => s.resourceGroupId === rg)
      return existing || { id: rg, subscriptionId, resourceGroupId: rg, resourceId: '' }
    }))
  }

  const updateResources = (selectedResourceIds) => {
    // Always keep all selected RGs as base scopes, then overlay specific resources
    const rgScopes = selectedRGs.map(rg => ({ id: rg, subscriptionId, resourceGroupId: rg, resourceId: '' }))
    if (!selectedResourceIds.length) { onChange(rgScopes); return }
    // Add resource-specific scopes on top of RG scopes
    const resourceScopes = selectedResourceIds.map(resId => {
      const res = resources.find(r => r.id === resId)
      const rgName = res?.id?.split('/')[4] || selectedRGs[0]
      return { id: resId, subscriptionId, resourceGroupId: rgName, resourceId: resId }
    })
    // Merge: RG scopes for RGs with no specific resource selected, resource scopes for the rest
    const rgWithResources = new Set(resourceScopes.map(s => s.resourceGroupId))
    const baseScopes = rgScopes.filter(s => !rgWithResources.has(s.resourceGroupId))
    onChange([...baseScopes, ...resourceScopes])
  }

  const resourceOptions = useMemo(() =>
    resources.map(r => ({ value: r.id, label: `${r.name || r.id.split('/').pop()} (${r.id.split('/')[4]})` })),
    [resources]
  )

  return (
    <div className="ds-filter-grid">
      {/* Subscription */}
      <div className="ds-filter-field">
        <label className="ds-filter-label">Subscription</label>
        <MultiSelectDropdown
          options={subscriptions.map(s => ({ value: s.id, label: s.name || s.id }))}
          selected={subscriptionId ? [subscriptionId] : []}
          onChange={val => updateSubscription(val[0] || '')}
          placeholder="Select Subscription"
          singleSelect={true}
        />
      </div>

      {/* RG multi-select */}
      <div className="ds-filter-field">
        <label className="ds-filter-label">Resource Group</label>
        <MultiSelectDropdown
          options={rgOptions}
          selected={selectedRGs}
          onChange={updateRGs}
          placeholder={subscriptionId ? 'Select resource groups...' : 'Select subscription first'}
        />
      </div>

      {/* Resource multi-select — always show field placeholder to maintain layout */}
      <div className="ds-filter-field">
        <label className="ds-filter-label">Resource</label>
        <MultiSelectDropdown
          options={resourceOptions}
          selected={selectedResources}
          onChange={updateResources}
          placeholder={selectedRGs.length ? "All resources (optional)" : "Select resource group first"}
        />
      </div>
      
      {children}
    </div>
  )
}
