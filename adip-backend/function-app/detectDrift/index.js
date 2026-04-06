require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') })
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential }   = require('@azure/identity')
const { BlobServiceClient } = require('@azure/storage-blob')
const { EmailClient }       = require('@azure/communication-email')
const fetch                 = require('node-fetch')

// ── Blob Storage — initialised once at module load ────────────────────────────
const blobService = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
const baselineCtr = blobService.getContainerClient('baselines')
const driftCtr    = blobService.getContainerClient('drift-records')

function blobKey(resourceId) {
  return Buffer.from(resourceId).toString('base64url') + '.json'
}
function driftKey(resourceId, ts) {
  return `${(ts||new Date().toISOString()).replace(/[:.]/g,'-')}_${Buffer.from(resourceId).toString('base64url')}.json`
}
async function readBlob(ctr, name) {
  try { const buf = await ctr.getBlobClient(name).downloadToBuffer(); return JSON.parse(buf.toString()) }
  catch(e) { if(e.statusCode===404||e.code==='BlobNotFound') return null; throw e }
}

const VOLATILE       = ['etag','changedTime','createdTime','provisioningState','lastModifiedAt','systemData','_ts','_etag']
const CRITICAL_PATHS = ['properties.networkAcls','properties.accessPolicies','properties.securityRules','sku','location','identity','properties.encryption']

const API_VERSION_MAP = {
  storageaccounts:'2023-01-01', virtualmachines:'2023-07-01', workflows:'2019-05-01',
  sites:'2023-01-01', vaults:'2023-07-01', virtualnetworks:'2023-05-01',
  networksecuritygroups:'2023-05-01', databaseaccounts:'2024-11-15',
  accounts:'2023-11-01', components:'2020-02-02',
}

function strip(obj) {
  if (obj === null || obj === undefined) return obj
  if (Array.isArray(obj)) return obj.map(strip)
  if (typeof obj === 'object')
    return Object.fromEntries(Object.entries(obj).filter(([k]) => !VOLATILE.includes(k)).map(([k,v]) => [k, strip(v)]))
  return obj
}

function classifySeverity(diffs) {
  if (!diffs.length) return 'none'
  if (diffs.some(d => d.type === 'removed')) return 'critical'
  if (diffs.some(d => CRITICAL_PATHS.some(p => d.path.startsWith(p)))) return 'high'
  if (diffs.length > 5) return 'medium'
  return 'low'
}

function safeStr(val) {
  if (val === null || val === undefined) return 'null'
  if (typeof val === 'object') return JSON.stringify(val)
  return String(val)
}

function computeDiff(prev, curr, path, results) {
  if (prev === null || prev === undefined) {
    if (curr !== null && curr !== undefined) {
      if (typeof curr === 'object' && !Array.isArray(curr)) {
        for (const k of Object.keys(curr)) {
          computeDiff(undefined, curr[k], `${path} → ${k}`, results)
        }
      } else {
        results.push({ path, type: 'added', oldValue: null, newValue: curr,
          sentence: `added "${path.split(' → ').pop()}" = ${safeStr(curr)}` })
      }
    }
    return
  }
  if (curr === null || curr === undefined) {
    results.push({ path, type: 'removed', oldValue: prev, newValue: null,
      sentence: `removed "${path.split(' → ').pop()}" (was ${safeStr(prev)})` })
    return
  }

  if (Array.isArray(prev) && Array.isArray(curr)) {
    if (JSON.stringify(prev) !== JSON.stringify(curr)) {
      const added   = curr.filter(c => !prev.some(p => JSON.stringify(p) === JSON.stringify(c)))
      const removed = prev.filter(p => !curr.some(c => JSON.stringify(c) === JSON.stringify(p)))
      if (added.length > 0)
        results.push({ path, type: 'array-added', oldValue: prev, newValue: curr,
          sentence: `added ${added.length} item(s) to "${path.split(' → ').pop()}"` })
      if (removed.length > 0)
        results.push({ path, type: 'array-removed', oldValue: prev, newValue: curr,
          sentence: `removed ${removed.length} item(s) from "${path.split(' → ').pop()}"` })
      if (added.length === 0 && removed.length === 0)
        results.push({ path, type: 'array-reordered', oldValue: prev, newValue: curr,
          sentence: `reordered items in "${path.split(' → ').pop()}"` })
    }
    return
  }

  if (typeof prev === 'object' && typeof curr === 'object') {
    const allKeys = new Set([...Object.keys(prev), ...Object.keys(curr)])
    for (const k of allKeys) {
      computeDiff(prev[k], curr[k], path ? `${path} → ${k}` : k, results)
    }
    return
  }

  if (prev !== curr) {
    const field = path.split(' → ').pop()
    const isTag = path.includes('tags')
    results.push({
      path, type: 'modified', oldValue: prev, newValue: curr,
      sentence: isTag
        ? `changed tag '${field}' from "${prev}" to "${curr}"`
        : `changed "${field}" from "${safeStr(prev)}" to "${safeStr(curr)}"`,
    })
  }
}

function diffObjects(prev, curr) {
  const results = []
  computeDiff(prev, curr, '', results)
  return results.filter(r => r.path !== '')
}

// ── Direct email alert (no Express dependency) ────────────────────────────────
async function sendAlertEmail(record) {
  const connStr    = process.env.COMMS_CONNECTION_STRING
  const recipients = (process.env.ALERT_RECIPIENT_EMAIL || '').split(',').map(e => e.trim()).filter(Boolean)
  if (!connStr || !recipients.length || !['critical', 'high'].includes(record.severity)) return
  try {
    const client       = new EmailClient(connStr)
    const resourceName = record.resourceId?.split('/').pop() ?? record.resourceId
    const changes      = (record.differences || []).slice(0, 10).map(c => `- ${c.sentence || c.path}`).join('\n')
    const baseUrl      = process.env.EXPRESS_PUBLIC_URL || 'http://localhost:3001'
    const token        = Buffer.from(JSON.stringify({
      resourceId: record.resourceId, resourceGroup: record.resourceGroup,
      subscriptionId: record.subscriptionId, detectedAt: record.detectedAt,
    })).toString('base64url')
    const approveUrl = `${baseUrl}/api/remediate-decision?action=approve&token=${token}`
    const rejectUrl  = `${baseUrl}/api/remediate-decision?action=reject&token=${token}`
    const color      = record.severity === 'critical' ? '#dc2626' : '#d97706'
    const poller = await client.beginSend({
      senderAddress: process.env.SENDER_ADDRESS,
      recipients:    { to: recipients.map(address => ({ address })) },
      content: {
        subject:   `[ADIP] ${record.severity.toUpperCase()} Drift - ${resourceName} - Action Required`,
        html:      `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:600px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden"><div style="background:${color};padding:20px 24px"><h2 style="color:#fff;margin:0">Azure Drift Alert - ${record.severity.toUpperCase()}</h2></div><div style="padding:24px"><p><strong>Resource:</strong> ${resourceName}</p><p><strong>Group:</strong> ${record.resourceGroup}</p><p><strong>Changes:</strong> ${record.differences?.length || 0}</p><pre style="background:#f9fafb;padding:12px;font-size:12px">${changes}</pre><div style="margin-top:20px"><a href="${approveUrl}" style="padding:10px 20px;background:#16a34a;color:#fff;text-decoration:none;border-radius:6px;margin-right:12px">Approve Remediation</a><a href="${rejectUrl}" style="padding:10px 20px;background:#6b7280;color:#fff;text-decoration:none;border-radius:6px">Reject</a></div></div></div>`,
        plainText: `ADIP Drift Alert\nSeverity: ${record.severity.toUpperCase()}\nResource: ${resourceName}\nChanges: ${record.differences?.length || 0}\n\n${changes}`,
      },
    })
    await poller.pollUntilDone()
  } catch (_) { /* non-fatal */ }
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function (context, req) {
  const body = req.body

  // Event Grid validation handshake
  if (Array.isArray(body) && body[0]?.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent') {
    context.res = { status: 200, body: { validationResponse: body[0].data.validationCode } }
    return
  }

  const eventData = Array.isArray(body) ? body[0]?.data : body
  const { resourceId, subscriptionId } = eventData || {}
  if (!resourceId || !subscriptionId) {
    context.res = { status: 400, body: { error: 'resourceId and subscriptionId required' } }
    return
  }

  try {
    const credential = new DefaultAzureCredential()
    const armClient  = new ResourceManagementClient(credential, subscriptionId)
    const parts      = resourceId.split('/')
    const rgName     = parts[4] || ''
    const provider   = parts[6] || ''
    const type       = parts[7] || ''
    const name       = parts[8] || ''

    if (!rgName || !provider || !type || !name) {
      context.res = { status: 400, body: { error: 'Invalid resourceId: ' + resourceId } }
      return
    }

    const apiVersion = API_VERSION_MAP[type.toLowerCase()] || '2021-04-01'

    // Fetch live config from ARM
    const liveRaw = await armClient.resources.get(rgName, provider, '', type, name, apiVersion)
    const live    = strip(liveRaw)

    const baseline = await readBlob(baselineCtr, blobKey(resourceId))

    const baseState = baseline ? strip(baseline.resourceState) : null
    const changes   = baseState ? diffObjects(baseState, live) : []
    const severity  = classifySeverity(changes)

    if (changes.length === 0) {
      context.res = { status: 200, body: { drifted: false, changeCount: 0 } }
      return
    }

    const detectedAt = new Date().toISOString()
    const record = {
      subscriptionId, resourceId,
      resourceGroup: rgName,
      liveState:     live,
      baselineState: baseState,
      differences:   changes,
      severity,
      changeCount:   changes.length,
      detectedAt,
    }

    // Write drift record to Blob Storage
    const driftBody = JSON.stringify(record)
    await driftCtr.getBlockBlobClient(driftKey(resourceId, detectedAt))
      .upload(driftBody, Buffer.byteLength(driftBody), { blobHTTPHeaders: { blobContentType: 'application/json' } })

    // Send alert email directly (no Express dependency)
    sendAlertEmail(record).catch(() => {})

    // Also notify Express API if configured (for real-time Socket.IO feed)
    const apiUrl = process.env.EXPRESS_API_URL
    if (apiUrl) {
      await fetch(`${apiUrl}/internal/drift-event`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      }).catch(() => {})
    }

    context.res = { status: 200, body: { drifted: true, ...record } }
  } catch (err) {
    context.log.error('detectDrift error:', err.message)
    context.res = { status: 500, body: { error: err.message } }
  }
}
