// ============================================================
// FILE: adip-backend/express-api/src/routes/costEstimate.js
// ROLE: Estimates monthly cost delta between two resource configs
//       using Azure Retail Prices public API (no auth required).
//
// GET /api/cost-estimate?resourceType=&location=&fieldPath=&oldValue=&newValue=
// GET /api/cost-savings?subscriptionId=&days=30
//
// Supports: Storage Accounts, Virtual Machines, Key Vaults, App Services
// Results cached 1 hour per query key.
// ============================================================
'use strict'
const router = require('express').Router()
const fetch  = require('node-fetch')
const { TableClient } = require('@azure/data-tables')

const PRICES_API = 'https://prices.azure.com/api/retail/prices'
const CACHE_TTL  = 3600000
const _cache     = new Map()

// ── Price lookup helpers ─────────────────────────────────────────────────────

async function fetchPrice(filter, matchFn) {
  const cacheKey = filter
  const cached   = _cache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.price

  const url  = `${PRICES_API}?api-version=2023-01-01-preview&$filter=${encodeURIComponent(filter)}`
  const resp = await fetch(url, { timeout: 10000 })
  const data = await resp.json()
  const item = (data.Items || []).find(matchFn)
  const price = item?.retailPrice ?? null
  _cache.set(cacheKey, { price, expiresAt: Date.now() + CACHE_TTL })
  return price
}

async function fetchStorageDataPrice(skuFragment, location) {
  const filter = `serviceName eq 'Storage' and armRegionName eq '${location}' and priceType eq 'Consumption'`
  return fetchPrice(filter, i =>
    i.skuName?.toLowerCase() === skuFragment.toLowerCase() &&
    (i.meterName?.toLowerCase().includes('data stored') || i.meterName?.toLowerCase().includes('data write')) &&
    i.unitOfMeasure?.includes('GB') &&
    i.retailPrice > 0
  )
}

async function fetchVmPrice(vmSize, location) {
  const filter = `serviceName eq 'Virtual Machines' and armRegionName eq '${location}' and priceType eq 'Consumption' and armSkuName eq '${vmSize}'`
  return fetchPrice(filter, i =>
    i.meterName?.toLowerCase().includes('spot') === false &&
    !i.skuName?.toLowerCase().includes('spot') &&
    !i.skuName?.toLowerCase().includes('low priority') &&
    i.unitOfMeasure?.includes('Hour') &&
    i.retailPrice > 0
  )
}

async function fetchAppServicePrice(skuName, location) {
  const filter = `serviceName eq 'Azure App Service' and armRegionName eq '${location}' and priceType eq 'Consumption'`
  return fetchPrice(filter, i =>
    i.skuName?.toLowerCase() === skuName.toLowerCase() &&
    i.unitOfMeasure?.includes('Hour') &&
    i.retailPrice > 0
  )
}

async function fetchKeyVaultPrice(skuName, location) {
  const filter = `serviceName eq 'Key Vault' and armRegionName eq '${location}' and priceType eq 'Consumption'`
  return fetchPrice(filter, i =>
    i.skuName?.toLowerCase() === skuName.toLowerCase() &&
    i.meterName?.toLowerCase().includes('operations') &&
    i.retailPrice > 0
  )
}

// ── SKU Maps ─────────────────────────────────────────────────────────────────

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

const ACCESS_TIER_MAP = {
  'hot':     'Hot LRS',
  'cool':    'Cool LRS',
  'cold':    'Cold LRS',
  'archive': 'Archive LRS',
}

// ── Core calculation (shared by route + recordRemediationSavings) ────────────

async function calculateCostDelta(resourceType, location, fieldPath, oldValue, newValue) {
  const type      = (resourceType || '').toLowerCase()
  const pathLower = (fieldPath || '').toLowerCase()
  const loc       = location || 'westus2'

  // ── Storage Account ─────────────────────────────────────────────────────
  if (type === 'microsoft.storage/storageaccounts') {
    if (pathLower.includes('sku') || pathLower.includes('name')) {
      const oldSku = STORAGE_SKU_MAP[(typeof oldValue === 'object' ? oldValue?.name : oldValue)?.toLowerCase()]
      const newSku = STORAGE_SKU_MAP[(typeof newValue === 'object' ? newValue?.name : newValue)?.toLowerCase()]
      if (!oldSku || !newSku || oldSku === newSku) return { deltaPerMonth: null, reason: 'same or unknown SKU' }
      const [priceFrom, priceTo] = await Promise.all([fetchStorageDataPrice(oldSku, loc), fetchStorageDataPrice(newSku, loc)])
      if (priceFrom === null || priceTo === null) return { deltaPerMonth: null, reason: 'price not found' }
      const refGB = 1024
      return { fieldPath, oldValue, newValue, priceFrom, priceTo, deltaPerMonth: Math.round((priceTo - priceFrom) * refGB * 100) / 100, referenceGB: refGB, unit: 'GB/month' }
    }
    if (pathLower.includes('accesstier')) {
      const oldTier = ACCESS_TIER_MAP[String(oldValue).toLowerCase()]
      const newTier = ACCESS_TIER_MAP[String(newValue).toLowerCase()]
      if (!oldTier || !newTier || oldTier === newTier) return { deltaPerMonth: null, reason: 'same or unknown tier' }
      const [priceFrom, priceTo] = await Promise.all([fetchStorageDataPrice(oldTier, loc), fetchStorageDataPrice(newTier, loc)])
      if (priceFrom === null || priceTo === null) return { deltaPerMonth: null, reason: 'price not found' }
      const refGB = 1024
      return { fieldPath, oldValue, newValue, priceFrom, priceTo, deltaPerMonth: Math.round((priceTo - priceFrom) * refGB * 100) / 100, referenceGB: refGB, unit: 'GB/month' }
    }
    if (pathLower.includes('keysource') || pathLower.includes('encryption')) {
      const isNowCMK = String(newValue).toLowerCase().includes('keyvault')
      if (!isNowCMK) return { deltaPerMonth: null, reason: 'no cost change' }
      return { fieldPath, oldValue, newValue, deltaPerMonth: 5.00, note: 'Approximate Key Vault operations cost for CMK encryption', unit: 'estimated/month' }
    }
  }

  // ── Virtual Machines ────────────────────────────────────────────────────
  if (type === 'microsoft.compute/virtualmachines') {
    if (pathLower.includes('vmsize') || pathLower.includes('hardwareprofile')) {
      const oldSize = typeof oldValue === 'object' ? oldValue?.vmSize : String(oldValue || '')
      const newSize = typeof newValue === 'object' ? newValue?.vmSize : String(newValue || '')
      if (!oldSize || !newSize || oldSize === newSize) return { deltaPerMonth: null, reason: 'same or unknown VM size' }
      const [priceFrom, priceTo] = await Promise.all([fetchVmPrice(oldSize, loc), fetchVmPrice(newSize, loc)])
      if (priceFrom === null || priceTo === null) return { deltaPerMonth: null, reason: 'price not found' }
      const hoursPerMonth = 730
      return { fieldPath, oldValue, newValue, priceFrom, priceTo, deltaPerMonth: Math.round((priceTo - priceFrom) * hoursPerMonth * 100) / 100, unit: 'hours/month (730h)' }
    }
  }

  // ── App Service ─────────────────────────────────────────────────────────
  if (type === 'microsoft.web/sites' || type === 'microsoft.web/serverfarms') {
    if (pathLower.includes('sku') || pathLower.includes('name') || pathLower.includes('tier')) {
      const oldSku = typeof oldValue === 'object' ? (oldValue?.name || oldValue?.tier) : String(oldValue || '')
      const newSku = typeof newValue === 'object' ? (newValue?.name || newValue?.tier) : String(newValue || '')
      if (!oldSku || !newSku || oldSku === newSku) return { deltaPerMonth: null, reason: 'same or unknown App Service SKU' }
      const [priceFrom, priceTo] = await Promise.all([fetchAppServicePrice(oldSku, loc), fetchAppServicePrice(newSku, loc)])
      if (priceFrom === null || priceTo === null) return { deltaPerMonth: null, reason: 'price not found' }
      const hoursPerMonth = 730
      return { fieldPath, oldValue, newValue, priceFrom, priceTo, deltaPerMonth: Math.round((priceTo - priceFrom) * hoursPerMonth * 100) / 100, unit: 'hours/month (730h)' }
    }
  }

  // ── Key Vault ───────────────────────────────────────────────────────────
  if (type === 'microsoft.keyvault/vaults') {
    if (pathLower.includes('sku') || pathLower.includes('name')) {
      const oldSku = typeof oldValue === 'object' ? (oldValue?.name || '') : String(oldValue || '')
      const newSku = typeof newValue === 'object' ? (newValue?.name || '') : String(newValue || '')
      if (!oldSku || !newSku || oldSku.toLowerCase() === newSku.toLowerCase()) return { deltaPerMonth: null, reason: 'same or unknown Key Vault SKU' }
      const [priceFrom, priceTo] = await Promise.all([fetchKeyVaultPrice(oldSku, loc), fetchKeyVaultPrice(newSku, loc)])
      if (priceFrom === null || priceTo === null) return { deltaPerMonth: null, reason: 'price not found' }
      const opsPerMonth = 10000 // reference: 10K operations/month
      return { fieldPath, oldValue, newValue, priceFrom, priceTo, deltaPerMonth: Math.round((priceTo - priceFrom) * opsPerMonth * 100) / 100, note: 'Based on 10K operations/month reference', unit: 'ops/month' }
    }
  }

  return { deltaPerMonth: null, reason: 'no cost mapping for this resource type or field' }
}

// ── Route: GET /api/cost-estimate ────────────────────────────────────────────

router.get('/cost-estimate', async (req, res) => {
  console.log('[GET /cost-estimate] starts')
  const { resourceType, location = 'westus2', fieldPath, oldValue, newValue } = req.query

  if (!resourceType || !fieldPath || oldValue === undefined || newValue === undefined) {
    return res.status(400).json({ error: 'resourceType, fieldPath, oldValue, newValue required' })
  }

  try {
    const result = await calculateCostDelta(resourceType, location, fieldPath, oldValue, newValue)
    res.json(result)
    console.log('[GET /cost-estimate] ends')
  } catch (err) {
    console.log('[GET /cost-estimate] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Savings tracking ─────────────────────────────────────────────────────────

function savingsTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'remediationSavings')
}

const COST_PATHS = /sku|tier|accesstier|replication|capacity|keysource|encryption|vmsize|hardwareprofile/i

async function recordRemediationSavings(subscriptionId, resourceGroupId, resourceId, differences, location, resourceType) {
  if (!resourceType) return 0
  let totalSavings = 0
  const changedFields = []

  for (const diff of differences) {
    if (!COST_PATHS.test(diff.path || '')) continue
    try {
      const oldVal = typeof diff.oldValue === 'object' ? JSON.stringify(diff.oldValue) : String(diff.oldValue ?? '')
      const newVal = typeof diff.newValue === 'object' ? JSON.stringify(diff.newValue) : String(diff.newValue ?? '')
      // Direct function call — no HTTP self-reference
      const result = await calculateCostDelta(resourceType, location || 'westus2', diff.path, oldVal, newVal)
      if (result?.deltaPerMonth) {
        totalSavings += -result.deltaPerMonth
        changedFields.push({ field: diff.path, from: oldVal, to: newVal, delta: Math.round(-result.deltaPerMonth * 100) / 100 })
      }
    } catch { /* non-fatal */ }
  }

  if (totalSavings !== 0) {
    const rowKey = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    await savingsTable().upsertEntity({
      partitionKey: subscriptionId, rowKey, resourceId, resourceGroupId,
      monthlySavings: Math.round(totalSavings * 100) / 100,
      changedFields: JSON.stringify(changedFields),
      remediatedAt: new Date().toISOString(),
    }, 'Replace').catch(() => {})
  }

  return Math.round(totalSavings * 100) / 100
}

// ── Route: GET /api/cost-savings ─────────────────────────────────────────────

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
