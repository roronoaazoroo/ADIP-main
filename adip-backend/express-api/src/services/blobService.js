const { BlobServiceClient } = require('@azure/storage-blob')
const { TableClient, odata } = require('@azure/data-tables')

let _blobService = null
function getBlobService() {
  if (!_blobService) _blobService = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
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
  if (!_tables[name])
    try { _tables[name] = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, name) } catch {}
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

async function upsertBaseline(subscriptionId, resourceGroupId, resourceId, resourceState) {
  return saveBaseline(subscriptionId, resourceGroupId, resourceId, resourceState)
}


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
    if (doc) results.push({ ...doc, _blobKey: entity.blobKey })
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
    const { TableClient } = require('@azure/data-tables')
    const tc = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'genomeIndex')
    const rk = Buffer.from(blobName).toString('base64url').slice(0, 512)
    await tc.deleteEntity(subscriptionId || 'unknown', rk)
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

  // Write index entry for fast counting
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
// Queries changesIndex Table for last N hours, fetches full blobs for detail
async function getRecentChanges({ subscriptionId, resourceGroup, caller, changeType, since, limit = 200 }) {
  const tc = tableClient('changesIndex')
  if (!tc) return []

  let filter = `PartitionKey eq '${subscriptionId}' and detectedAt ge '${since}'`
  if (resourceGroup) filter += ` and resourceGroup eq '${resourceGroup}'`
  if (changeType)    filter += ` and changeType eq '${changeType}'`

  const results = []
  for await (const entity of tc.listEntities({ queryOptions: { filter } })) {
    if (results.length >= limit) break
    if (caller && entity.caller !== caller) continue
    // Read full blob for complete detail
    const doc = await readBlob('all-changes', entity.blobKey).catch(() => null)
    if (doc) results.push(doc)
    else {
      // Fallback: use index entity fields if blob missing
      results.push({
        subscriptionId,
        resourceId:    entity.resourceId    || '',
        resourceGroup: entity.resourceGroup || '',
        eventType:     entity.eventType     || '',
        operationName: entity.operationName || '',
        changeType:    entity.changeType    || 'modified',
        caller:        entity.caller        || '',
        detectedAt:    entity.detectedAt    || '',
        _blobKey:      entity.blobKey,
      })
    }
  }
  return results.sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt))
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

module.exports = {
  getBaseline,
  saveBaseline,
  upsertBaseline,
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
}
