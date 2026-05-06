// FILE: adip-backend/express-api/src/routes/costEstimate.js
// ROLE: Estimates monthly cost delta between two resource configs
//       using Azure Retail Prices public API (no auth required).

// GET /api/cost-estimate?resourceType=&location=&fieldPath=&oldValue=&newValue=

// Handles storage account cost dimensions:
//   sku.name       — replication tier (LRS/GRS/ZRS/RA-GRS)
//   accessTier     — Hot/Cool/Cold/Archive
//   encryption     — Microsoft vs Customer-managed key

// Results cached 1 hour per query key.

'use strict'
const router = require('express').Router()
const fetch  = require('node-fetch')

const PRICES_API = 'https://prices.azure.com/api/retail/prices'
const CACHE_TTL  = 3600000
const _cache     = new Map()

// Storage replication tier → price API skuName fragment (Data Stored meter)
const STORAGE_SKU_MAP = {
  'standard_lrs':   'Standard LRS',
  'standard_grs':   'Standard GRS',
  'standard_ragrs': 'Standard RA-GRS',
  'standard_zrs':   'Standard ZRS',
  'standard_gzrs':  'Standard GZRS',
  'standard_ragzrs':'Standard RA-GZRS',
  'premium_lrs':    'Premium LRS',
  'premium_zrs':    'Premium ZRS',
}

// Storage access tier → price API skuName fragment (Data Stored meter)
const ACCESS_TIER_MAP = {
  'hot':     'Hot LRS',   // use LRS as baseline for tier comparison
  'cool':    'Cool LRS',
  'cold':    'Cold LRS',
  'archive': 'Archive LRS',
}

async function fetchStorageDataPrice(skuFragment, location) {
  const cacheKey = `storage|${skuFragment}|${location}`
  const cached   = _cache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.price

  const filter = `serviceName eq 'Storage' and armRegionName eq '${location}' and priceType eq 'Consumption'`
  const url    = `${PRICES_API}?api-version=2023-01-01-preview&$filter=${encodeURIComponent(filter)}`

  const resp  = await fetch(url, { timeout: 10000 })
  const data  = await resp.json()

  // Find the "Data Stored" meter for this SKU
  const item = (data.Items || []).find(i =>
    i.skuName?.toLowerCase() === skuFragment.toLowerCase() &&
    (i.meterName?.toLowerCase().includes('data stored') || i.meterName?.toLowerCase().includes('data write')) &&
    i.unitOfMeasure?.includes('GB') &&
    i.retailPrice > 0
  )

  const price = item?.retailPrice ?? null
  _cache.set(cacheKey, { price, expiresAt: Date.now() + CACHE_TTL })
  return price
}

// GET /api/cost-estimate?resourceType=&location=&fieldPath=&oldValue=&newValue=
router.get('/cost-estimate', async (req, res) => {
  console.log('[GET /cost-estimate] starts')
  const { resourceType, location = 'westus2', fieldPath, oldValue, newValue } = req.query

  if (!resourceType || !fieldPath || oldValue === undefined || newValue === undefined) {
    return res.status(400).json({ error: 'resourceType, fieldPath, oldValue, newValue required' })
  }

  const type      = resourceType.toLowerCase()
  const pathLower = fieldPath.toLowerCase()

  try {
    //  Storage Account 
    if (type === 'microsoft.storage/storageaccounts') {

      // SKU change (replication tier)
      if (pathLower.includes('sku') || pathLower.includes('name')) {
        const oldSku = STORAGE_SKU_MAP[(typeof oldValue === 'object' ? oldValue?.name : oldValue)?.toLowerCase()]
        const newSku = STORAGE_SKU_MAP[(typeof newValue === 'object' ? newValue?.name : newValue)?.toLowerCase()]
        if (!oldSku || !newSku || oldSku === newSku) return res.json({ deltaPerMonth: null, reason: 'same or unknown SKU' })

        const [priceFrom, priceTo] = await Promise.all([
          fetchStorageDataPrice(oldSku, location),
          fetchStorageDataPrice(newSku, location),
        ])
        if (priceFrom === null || priceTo === null) return res.json({ deltaPerMonth: null, reason: 'price not found' })

        const REFERENCE_GB  = 1024
        const deltaPerGB    = Math.round((priceTo - priceFrom) * 10000) / 10000
        const deltaPerMonth = Math.round((priceTo - priceFrom) * REFERENCE_GB * 100) / 100
        return res.json({ fieldPath, oldValue, newValue, priceFrom, priceTo, deltaPerGB, deltaPerMonth, referenceGB: REFERENCE_GB, unit: 'GB/month' })
      }

      // Access tier change (Hot/Cool/Cold/Archive)
      if (pathLower.includes('accesstier')) {
        const oldTier = ACCESS_TIER_MAP[String(oldValue).toLowerCase()]
        const newTier = ACCESS_TIER_MAP[String(newValue).toLowerCase()]
        if (!oldTier || !newTier || oldTier === newTier) return res.json({ deltaPerMonth: null, reason: 'same or unknown tier' })

        const [priceFrom, priceTo] = await Promise.all([
          fetchStorageDataPrice(oldTier, location),
          fetchStorageDataPrice(newTier, location),
        ])
        if (priceFrom === null || priceTo === null) return res.json({ deltaPerMonth: null, reason: 'price not found' })

        const REFERENCE_GB  = 1024
        const deltaPerGB    = Math.round((priceTo - priceFrom) * 10000) / 10000
        const deltaPerMonth = Math.round((priceTo - priceFrom) * REFERENCE_GB * 100) / 100
        return res.json({ fieldPath, oldValue, newValue, priceFrom, priceTo, deltaPerGB, deltaPerMonth, referenceGB: REFERENCE_GB, unit: 'GB/month' })
      }

      // Encryption key source (Microsoft → Customer-managed adds ~$0.03/10K ops)
      if (pathLower.includes('keysource') || pathLower.includes('encryption')) {
        const isNowCMK = String(newValue).toLowerCase().includes('keyvault')
        if (!isNowCMK) return res.json({ deltaPerMonth: null, reason: 'no cost change' })
        // CMK adds Key Vault operations cost — approximate $5-15/month for typical workload
        return res.json({ fieldPath, oldValue, newValue, deltaPerMonth: 5.00, note: 'Approximate Key Vault operations cost for CMK encryption', unit: 'estimated/month' })
      }
    }

    res.json({ deltaPerMonth: null, reason: 'no cost mapping for this field' })
    console.log('[GET /cost-estimate] ends — no mapping')
  } catch (err) {
    console.log('[GET /cost-estimate] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})


//  Savings tracking (Feature B) 
const { TableClient } = require('@azure/data-tables')

function savingsTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'remediationSavings')
}

// Calculates cost delta for all cost-relevant diffs and records in Table Storage
async function recordRemediationSavings(subscriptionId, resourceGroupId, resourceId, differences, location, resourceType) {
  if (!resourceType) return 0
  let totalSavings = 0
  const changedFields = []
  const COST_PATHS = /sku|tier|accesstier|replication|capacity|keysource|encryption/i

  for (const diff of differences) {
    if (!COST_PATHS.test(diff.path || '')) continue
    try {
      const params = new URLSearchParams({
        resourceType, fieldPath: diff.path,
        oldValue: typeof diff.oldValue === 'object' ? JSON.stringify(diff.oldValue) : String(diff.oldValue ?? ''),
        newValue: typeof diff.newValue === 'object' ? JSON.stringify(diff.newValue) : String(diff.newValue ?? ''),
        location: location || 'westus2',
      })
      const apiUrl = (process.env.EXPRESS_API_URL || 'http://localhost:3001').replace(/\/api$/, '')
      const resp   = await fetch(`${apiUrl}/api/cost-estimate?${params}`, { timeout: 8000 })
      const result = await resp.json()
      if (result?.deltaPerMonth) {
        totalSavings += -result.deltaPerMonth
        changedFields.push({
          field:    diff.path,
          from:     String(diff.oldValue ?? ''),
          to:       String(diff.newValue ?? ''),
          delta:    Math.round(-result.deltaPerMonth * 100) / 100,
        })
      }
    } catch { /* non-fatal */ }
  }

  if (totalSavings !== 0) {
    const rowKey = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    await savingsTable().upsertEntity({
      partitionKey:    subscriptionId,
      rowKey,
      resourceId,
      resourceGroupId,
      monthlySavings:  Math.round(totalSavings * 100) / 100,
      changedFields:   JSON.stringify(changedFields),
      remediatedAt:    new Date().toISOString(),
    }, 'Replace').catch(() => {})
  }

  return Math.round(totalSavings * 100) / 100
}

// GET /api/cost-savings?subscriptionId=&days=30
// Returns total monthly savings from remediations in the period
router.get('/cost-savings', async (req, res) => {
  console.log('[GET /cost-savings] starts')
  const { subscriptionId, days = '30' } = req.query
  if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' })

  try {
    const since  = new Date(Date.now() - Number(days) * 86400000).toISOString()
    const filter = `PartitionKey eq '${subscriptionId}' and Timestamp ge datetime'${since}'`
    let totalSavings = 0
    const records = []
    for await (const entity of savingsTable().listEntities({ queryOptions: { filter } })) {
      totalSavings += entity.monthlySavings || 0
      records.push({ resourceId: entity.resourceId, monthlySavings: entity.monthlySavings, remediatedAt: entity.remediatedAt, changedFields: entity.changedFields ? JSON.parse(entity.changedFields) : [] })
    }
    res.json({ totalMonthlySavings: Math.round(totalSavings * 100) / 100, records, period: Number(days) })
    console.log('[GET /cost-savings] ends — total:', totalSavings)
  } catch (err) {
    console.log('[GET /cost-savings] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
module.exports.recordRemediationSavings = recordRemediationSavings
