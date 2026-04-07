const { BlobServiceClient } = require('@azure/storage-blob')

const blobService = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)

// Container handles — lazy, reused across calls
const containers = {}
function container(name) {
  if (!containers[name]) containers[name] = blobService.getContainerClient(name)
  return containers[name]
}

// Deterministic blob name from resourceId — safe for blob paths
function blobKey(resourceId) {
  return Buffer.from(resourceId).toString('base64url') + '.json'
}

// Timestamp-prefixed key for drift records (enables chronological listing)
function driftKey(resourceId, ts) {
  const stamp = (ts || new Date().toISOString()).replace(/[:.]/g, '-')
  return `${stamp}_${Buffer.from(resourceId).toString('base64url')}.json`
}

async function readBlob(containerName, blobName) {
  try {
    const blob = container(containerName).getBlobClient(blobName)
    const buf  = await blob.downloadToBuffer()
    return JSON.parse(buf.toString('utf-8'))
  } catch (e) {
    if (e.statusCode === 404 || e.code === 'BlobNotFound') return null
    throw e
  }
}

async function writeBlob(containerName, blobName, data) {
  const body = JSON.stringify(data)
  await container(containerName)
    .getBlockBlobClient(blobName)
    .upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: 'application/json' } })
}

// ── Baselines ─────────────────────────────────────────────────────────────────

async function getBaseline(subscriptionId, resourceId) {
  if (!resourceId) return null
  const doc = await readBlob('baselines', blobKey(resourceId))
  // Filter by subscriptionId for safety
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
  // Blob overwrite = upsert — no separate check needed
  return saveBaseline(subscriptionId, resourceGroupId, resourceId, resourceState)
}

// ── Drift Records ─────────────────────────────────────────────────────────────

async function saveDriftRecord(record) {
  const key = driftKey(record.resourceId || 'unknown', record.detectedAt)
  await writeBlob('drift-records', key, { ...record, _blobKey: key })
}

async function getDriftRecords({ subscriptionId, resourceGroup, severity, limit = 50 }) {
  const results = []
  // List blobs newest-first (ISO timestamp prefix sorts lexicographically)
  for await (const blob of container('drift-records').listBlobsFlat()) {
    if (results.length >= Number(limit)) break
    const doc = await readBlob('drift-records', blob.name)
    if (!doc) continue
    if (doc.subscriptionId !== subscriptionId) continue
    if (resourceGroup && doc.resourceGroup !== resourceGroup) continue
    if (severity && doc.severity !== severity) continue
    results.push(doc)
  }
  return results.sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt))
}

// ── Drift History (Task 3) — filtered listing ─────────────────────────────────

async function getDriftHistory({ subscriptionId, startDate, endDate, resourceId, resourceGroup, limit = 100 }) {
  const results = []
  const startTs = startDate ? new Date(startDate).toISOString().replace(/[:.]/g, '-') : null
  const endTs   = endDate   ? new Date(endDate).toISOString().replace(/[:.]/g, '-')   : null

  for await (const blob of container('drift-records').listBlobsFlat()) {
    if (results.length >= Number(limit)) break
    // Cheap prefix filter on blob name before downloading
    const blobTs = blob.name.slice(0, 24)
    if (startTs && blobTs < startTs) continue
    if (endTs   && blobTs > endTs)   continue

    const doc = await readBlob('drift-records', blob.name)
    if (!doc) continue
    if (doc.subscriptionId !== subscriptionId) continue
    if (resourceGroup && doc.resourceGroup !== resourceGroup) continue
    if (resourceId    && doc.resourceId    !== resourceId)    continue
    results.push(doc)
  }
  return results.sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt))
}

// ── Configuration Genome (versioned snapshots) ────────────────────────────────

async function saveGenomeSnapshot(subscriptionId, resourceId, resourceState, label = '') {
  const ts  = new Date().toISOString()
  const key = `${ts.replace(/[:.]/g, '-')}_${Buffer.from(resourceId).toString('base64url')}.json`
  const doc = { subscriptionId, resourceId, resourceState, label, savedAt: ts }
  await writeBlob('baseline-genome', key, doc)
  return { ...doc, _blobKey: key }
}

async function listGenomeSnapshots(subscriptionId, resourceId, limit = 50) {
  const results = []
  for await (const blob of container('baseline-genome').listBlobsFlat()) {
    if (results.length >= limit) break
    const doc = await readBlob('baseline-genome', blob.name)
    if (!doc) continue
    if (doc.subscriptionId !== subscriptionId) continue
    if (resourceId && doc.resourceId !== resourceId) continue
    results.push({ ...doc, _blobKey: blob.name })
  }
  return results.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))
}

async function getGenomeSnapshot(blobKey) {
  return readBlob('baseline-genome', blobKey)
}

module.exports = { getBaseline, saveBaseline, upsertBaseline, saveDriftRecord, getDriftRecords, getDriftHistory, saveGenomeSnapshot, listGenomeSnapshots, getGenomeSnapshot }
