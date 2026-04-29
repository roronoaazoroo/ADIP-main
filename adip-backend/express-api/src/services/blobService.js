// FILE: adip-backend/express-api/src/services/blobService.js
// ROLE: All Azure Blob Storage and Table Storage reads/writes for the Express API

// What this file owns:
//   - saveBaseline() / getBaseline(): golden baseline blobs in 'baselines' container
//   - saveDriftRecord() / getDriftRecords(): drift detection results in 'drift-records'
//     + index rows in 'driftIndex' Table for fast filtered queries
//   - saveChangeRecord() / getRecentChanges(): every ARM event in 'all-changes'
//     + index rows in 'changesIndex' Table (used by DashboardHome recent events table)
//   - saveGenomeSnapshot() / listGenomeSnapshots(): versioned config history
//     in 'baseline-genome' container + 'genomeIndex' Table
//   - All blob keys use base64url(resourceId) so ARM resource IDs (which contain /)
//     are safe to use as blob filenames

// Pattern: every blob write is paired with a Table Storage upsert (the index).
//   Table = fast O(filtered) query to find which blobs to fetch.
//   Blob  = full JSON document storage.

// Called by: drift.js, baseline.js, genome.js, compare.js, queuePoller.js, app.js

'use strict'

// Returns true only for real human/SPN callers — filters out System, blank, and automated entries
function isHumanCaller(caller) {
  if (!caller || !caller.trim()) return false
  const c = caller.trim().toLowerCase()
  return c !== 'system' && c !== 'manual-compare' && !c.startsWith('azure ')
}
const { BlobServiceClient } = require('@azure/storage-blob')
const { TableClient } = require('@azure/data-tables')

let _blobService = null
function getBlobService() {
  if (!_blobService) {
    if (!process.env.STORAGE_CONNECTION_STRING) throw new Error('STORAGE_CONNECTION_STRING environment variable is not set')
    _blobService = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
  }
  return _blobService
}

const containers = {}
function container(name) {
  if (!containers[name]) containers[name] = getBlobService().getContainerClient(name)
  return containers[name]
}

// ── Table index clients ───────────────────────────────────────────────────────
const _tables = {}
function tableClient(name) {
  if (!_tables[name]) {
    try {
      _tables[name] = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, name)
    } catch (tableInitError) {
      // Log but don't throw — callers handle null table client gracefully
      console.error(`[blobService] failed to init Table client '${name}':`, tableInitError.message)
    }
  }
  return _tables[name]
}

// Safe row key — base64url of arbitrary string, truncated to 512 chars (Table Storage limit)
function rowKey(str) { return Buffer.from(str).toString('base64url').slice(0, 512) }

// ── blobKey START ─────────────────────────────────────────────────────────────
function blobKey(resourceId) {
  return Buffer.from(resourceId).toString('base64url') + '.json'
}
// ── blobKey END ───────────────────────────────────────────────────────────────

// ── driftKey START ────────────────────────────────────────────────────────────
function driftKey(resourceId, ts) {
  const stamp = (ts || new Date().toISOString()).replace(/[:.]/g, '-')
  return `${stamp}_${Buffer.from(resourceId).toString('base64url')}.json`
}
// ── driftKey END ──────────────────────────────────────────────────────────────

// ── readBlob START ────────────────────────────────────────────────────────────
async function readBlob(containerName, blobName) {
  try {
    const buf = await container(containerName).getBlobClient(blobName).downloadToBuffer()
    return JSON.parse(buf.toString('utf-8'))
  } catch (e) {
    if (e.statusCode === 404 || e.code === 'BlobNotFound') return null
    throw e
  }
}
// ── readBlob END ──────────────────────────────────────────────────────────────

// ── writeBlob START ───────────────────────────────────────────────────────────
async function writeBlob(containerName, blobName, data) {
  const body = JSON.stringify(data)
  await container(containerName)
    .getBlockBlobClient(blobName)
    .upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: 'application/json' } })
}
// ── writeBlob END ─────────────────────────────────────────────────────────────


// ── Baselines ─────────────────────────────────────────────────────────────────

async function getBaseline(subscriptionId, resourceId) {
  if (!resourceId) return null
  const doc = await readBlob('baselines', blobKey(resourceId))
  if (doc && doc.subscriptionId !== subscriptionId) return null
  return doc
}

async function saveBaseline(subscriptionId, resourceGroupId, resourceId, resourceState) {
  const doc = {
    id: blobKey(resourceId),
    subscriptionId, resourceGroupId, resourceId,
    resourceState, active: true,
    promotedAt: new Date().toISOString(),
  }
  await writeBlob('baselines', blobKey(resourceId), doc)
  return doc
}

// upsertBaseline removed — use saveBaseline directly (YAGNI: identical function)


// ── Drift Records ─────────────────────────────────────────────────────────────

// ── saveDriftRecord START ─────────────────────────────────────────────────────
// Writes blob + upserts a lightweight index entity into Table Storage
async function saveDriftRecord(record) {
  const key = driftKey(record.resourceId || 'unknown', record.detectedAt)
  await writeBlob('drift-records', key, { ...record, _blobKey: key })

  // Write index entity — partitionKey = subscriptionId for efficient filtering
  tableClient('driftIndex')?.upsertEntity({
    partitionKey: record.subscriptionId || 'unknown',
    rowKey:       rowKey(key),
    blobKey:      key,
    resourceId:   record.resourceId   || '',
    resourceGroup:record.resourceGroup|| '',
    severity:     record.severity     || '',
    caller:       record.caller       || '',
    detectedAt:   record.detectedAt   || new Date().toISOString(),
    changeCount:  record.changeCount  || 0,
  }, 'Replace').catch(() => {})
}
// ── saveDriftRecord END ───────────────────────────────────────────────────────


// ── getDriftRecords START ─────────────────────────────────────────────────────
// Queries Table index first, then fetches only matching blobs — O(matches) not O(all)
async function getDriftRecords({ subscriptionId, resourceGroup, severity, limit = 50 }) {
  const tc = tableClient('driftIndex')
  if (!tc) return _scanDriftRecords({ subscriptionId, resourceGroup, severity, limit })

  let filter = `PartitionKey eq '${subscriptionId}'`
  if (resourceGroup) filter += ` and resourceGroup eq '${resourceGroup}'`
  if (severity)      filter += ` and severity eq '${severity}'`

  const results = []
  for await (const entity of tc.listEntities({ queryOptions: { filter } })) {
    if (results.length >= Number(limit)) break
    const doc = await readBlob('drift-records', entity.blobKey)
    if (doc) results.push(doc)
  }
  return results.sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt))
}
// ── getDriftRecords END ───────────────────────────────────────────────────────


// ── getDriftHistory START ─────────────────────────────────────────────────────
// Queries Table index with optional date/resource filters, fetches only matching blobs
async function getDriftHistory({ subscriptionId, startDate, endDate, resourceId, resourceGroup, limit = 100 }) {
  const tc = tableClient('driftIndex')
  if (!tc) return _scanDriftHistory({ subscriptionId, startDate, endDate, resourceId, resourceGroup, limit })

  let filter = `PartitionKey eq '${subscriptionId}'`
  if (resourceGroup) filter += ` and resourceGroup eq '${resourceGroup}'`
  if (resourceId)    filter += ` and resourceId eq '${resourceId}'`
  if (startDate)     filter += ` and detectedAt ge '${new Date(startDate).toISOString()}'`
  if (endDate)       filter += ` and detectedAt le '${new Date(endDate).toISOString()}'`

  const results = []
  for await (const entity of tc.listEntities({ queryOptions: { filter } })) {
    if (results.length >= Number(limit)) break
    const doc = await readBlob('drift-records', entity.blobKey)
    if (doc) results.push(doc)
  }
  return results.sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt))
}
// ── getDriftHistory END ───────────────────────────────────────────────────────


// ── Configuration Genome ──────────────────────────────────────────────────────

// ── saveGenomeSnapshot START ──────────────────────────────────────────────────
// Writes blob + upserts index entity into genomeIndex table
async function saveGenomeSnapshot(subscriptionId, resourceId, resourceState, label = '') {
  const ts  = new Date().toISOString()
  const key = `${ts.replace(/[:.]/g, '-')}_${Buffer.from(resourceId).toString('base64url')}.json`
  const doc = { subscriptionId, resourceId, resourceState, label, savedAt: ts }
  await writeBlob('baseline-genome', key, doc)

  tableClient('genomeIndex')?.upsertEntity({
    partitionKey: subscriptionId || 'unknown',
    rowKey:       rowKey(key),
    blobKey:      key,
    resourceId:   resourceId || '',
    savedAt:      ts,
    label:        label || '',
  }, 'Replace').catch(() => {})

  return { ...doc, _blobKey: key }
}
// ── saveGenomeSnapshot END ────────────────────────────────────────────────────


// ── listGenomeSnapshots START ─────────────────────────────────────────────────
// Queries genomeIndex table, fetches only matching blobs
async function listGenomeSnapshots(subscriptionId, resourceId, limit = 50) {
  const tc = tableClient('genomeIndex')
  if (!tc) return _scanGenomeSnapshots(subscriptionId, resourceId, limit)

  let filter = `PartitionKey eq '${subscriptionId}'`
  if (resourceId) filter += ` and resourceId eq '${resourceId}'`

  const results = []
  for await (const entity of tc.listEntities({ queryOptions: { filter } })) {
    if (results.length >= limit) break
    const doc = await readBlob('baseline-genome', entity.blobKey)
    if (doc) results.push({ ...doc, _blobKey: entity.blobKey, rolledBackAt: entity.rolledBackAt || null, isCurrentBaseline: entity.isCurrentBaseline || false })
  }
  return results.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))
}
// ── listGenomeSnapshots END ───────────────────────────────────────────────────


async function getGenomeSnapshot(key) {
  return readBlob('baseline-genome', key)
}


// ── Fallback blob-scan functions (used if Table Storage unavailable) ───────────
async function _scanDriftRecords({ subscriptionId, resourceGroup, severity, limit }) {
  const results = []
  for await (const blob of container('drift-records').listBlobsFlat()) {
    if (results.length >= Number(limit)) break
    const doc = await readBlob('drift-records', blob.name)
    if (!doc || doc.subscriptionId !== subscriptionId) continue
    if (resourceGroup && doc.resourceGroup !== resourceGroup) continue
    if (severity && doc.severity !== severity) continue
    results.push(doc)
  }
  return results.sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt))
}

async function _scanDriftHistory({ subscriptionId, startDate, endDate, resourceId, resourceGroup, limit }) {
  const results = []
  const startTs = startDate ? new Date(startDate).toISOString().replace(/[:.]/g, '-') : null
  const endTs   = endDate   ? new Date(endDate).toISOString().replace(/[:.]/g, '-')   : null
  for await (const blob of container('drift-records').listBlobsFlat()) {
    if (results.length >= Number(limit)) break
    const blobTs = blob.name.slice(0, 24)
    if (startTs && blobTs < startTs) continue
    if (endTs   && blobTs > endTs)   continue
    const doc = await readBlob('drift-records', blob.name)
    if (!doc || doc.subscriptionId !== subscriptionId) continue
    if (resourceGroup && doc.resourceGroup !== resourceGroup) continue
    if (resourceId    && doc.resourceId    !== resourceId)    continue
    results.push(doc)
  }
  return results.sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt))
}

async function _scanGenomeSnapshots(subscriptionId, resourceId, limit) {
  const results = []
  for await (const blob of container('baseline-genome').listBlobsFlat()) {
    if (results.length >= limit) break
    const doc = await readBlob('baseline-genome', blob.name)
    if (!doc || doc.subscriptionId !== subscriptionId) continue
    if (resourceId && doc.resourceId !== resourceId) continue
    results.push({ ...doc, _blobKey: blob.name })
  }
  return results.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))
}

async function deleteGenomeSnapshot(subscriptionId, blobName) {
  await container('baseline-genome').getBlockBlobClient(blobName).deleteIfExists()
  try {
    const rk = Buffer.from(blobName).toString('base64url').slice(0, 512)
    await tableClient('genomeIndex')?.deleteEntity(subscriptionId || 'unknown', rk)
  } catch {}
}

// ── saveChangeRecord START ────────────────────────────────────────────────────
// Permanently records every ARM change event to all-changes blob + changesIndex Table
// Called by queue poller, detectDrift Function, and scanSubscription Function
async function saveChangeRecord(record) {
  const ts  = record.detectedAt || new Date().toISOString()
  const key = `${ts.replace(/[:.]/g, '-')}_${Buffer.from(record.resourceId || 'unknown').toString('base64url').slice(0, 80)}.json`

  // Write permanent blob
  await writeBlob('all-changes', key, { ...record, _blobKey: key })

  // Write index entry for fast counting — only for human/SPN callers
  if (!isHumanCaller(record.caller)) return
  const rk = Buffer.from(key).toString('base64url').slice(0, 512)
  tableClient('changesIndex')?.upsertEntity({
    partitionKey:  record.subscriptionId || 'unknown',
    rowKey:        rk,
    blobKey:       key,
    resourceId:    record.resourceId    || '',
    resourceGroup: record.resourceGroup || '',
    eventType:     record.eventType     || record.operationName || '',
    changeType:    record.changeType    || 'modified',
    severity:      record.severity      || 'low',
    caller:        record.caller        || '',
    detectedAt:    ts,
    changeCount:   record.changeCount   || record.differences?.length || 0,
  }, 'Replace').catch(() => {})
}
// ── saveChangeRecord END ──────────────────────────────────────────────────────

// ── getRecentChanges START ────────────────────────────────────────────────────
// Queries changesIndex Table for last N hours and returns index fields directly.
// Results are cached in-memory for 10 seconds to avoid hammering Table Storage
// on every dashboard auto-refresh cycle.
const _recentChangesCache = new Map()  // key: cacheKey string → { data, expiresAt }

async function getRecentChanges({ subscriptionId, resourceGroup, caller, changeType, since, limit = 10000 }) {
  if (!subscriptionId || !since) {
    console.error('[getRecentChanges] missing required params: subscriptionId and since')
    return []
  }
  const tc = tableClient('changesIndex')
  if (!tc) return []

  // Cache key includes all filter params so different filters get separate cache entries
  const cacheKey = `${subscriptionId}|${resourceGroup||''}|${caller||''}|${changeType||''}|${since}|${limit}`
  const cachedEntry = _recentChangesCache.get(cacheKey)
  if (cachedEntry && cachedEntry.expiresAt > Date.now()) return cachedEntry.data

  let filter = `PartitionKey eq '${subscriptionId}' and detectedAt ge '${since}'`
  if (resourceGroup) filter += ` and resourceGroup eq '${resourceGroup}'`
  if (changeType)    filter += ` and changeType eq '${changeType}'`

  const results = []
  for await (const entity of tc.listEntities({ queryOptions: { filter } })) {
    if (results.length >= limit) break
    if (caller && entity.caller !== caller) continue
    if (!isHumanCaller(entity.caller)) continue  // skip System/blank entries
    // Return index fields directly — no blob read needed for the dashboard table
    results.push({
      subscriptionId,
      resourceId:    entity.resourceId    || '',
      resourceGroup: entity.resourceGroup || '',
      eventType:     entity.eventType     || '',
      operationName: entity.operationName || '',
      changeType:    entity.changeType    || 'modified',
      caller:        entity.caller        || '',
      detectedAt:    entity.detectedAt    || '',
      changeCount:   entity.changeCount   || 0,
      severity:      entity.severity      || '',
      _blobKey:      entity.blobKey,
    })
  }
  const sortedResults = results.sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt))

  // Cache for 10 seconds — short enough to show new events quickly
  _recentChangesCache.set(cacheKey, { data: sortedResults, expiresAt: Date.now() + 10000 })
  // Prune stale entries to prevent unbounded growth
  for (const [key, entry] of _recentChangesCache) {
    if (entry.expiresAt < Date.now()) _recentChangesCache.delete(key)
  }

  return sortedResults
}
// ── getRecentChanges END ──────────────────────────────────────────────────────


// Returns total permanent change count for a subscription (all time)
async function getTotalChangesCount(subscriptionId) {
  const tc = tableClient('changesIndex')
  if (!tc) return 0
  let count = 0
  for await (const _ of tc.listEntities({ queryOptions: { filter: `PartitionKey eq '${subscriptionId}'`, select: ['RowKey'] } })) {
    count++
  }
  return count
}
// ── getTotalChangesCount END ──────────────────────────────────────────────────

// Exported table client accessors — routes use these instead of instantiating TableClient directly
function getMonitorSessionsTableClient() { return tableClient('monitorSessions') }
function getDriftIndexTableClient()      { return tableClient('driftIndex') }
function getChangesIndexTableClient()    { return tableClient('changesIndex') }

module.exports = {
  getBaseline,
  saveBaseline,
  saveDriftRecord,
  getDriftRecords,
  getDriftHistory,
  saveGenomeSnapshot,
  listGenomeSnapshots,
  getGenomeSnapshot,
  deleteGenomeSnapshot,
  saveChangeRecord,
  getTotalChangesCount,
  getRecentChanges,
  getMonitorSessionsTableClient,
  getDriftIndexTableClient,
  getChangesIndexTableClient,
  readBlob,
}
