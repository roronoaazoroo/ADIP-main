'use strict'
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') })
const fetch = require('node-fetch')
const { BlobServiceClient } = require('@azure/storage-blob')
const { TableClient }       = require('@azure/data-tables')
// Inlined from adip-shared/blobHelpers — avoids file: dependency resolution failure on Azure
function blobKey(resourceId) { return Buffer.from(resourceId).toString('base64url') + '.json' }
async function readBlob(containerClient, blobName) {
  try {
    const buf = await containerClient.getBlobClient(blobName).downloadToBuffer()
    return JSON.parse(buf.toString('utf-8'))
  } catch (e) {
    if (e.statusCode === 404 || e.code === 'BlobNotFound') return null
    throw e
  }
}

const ENDPOINT   = () => process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '')
const API_KEY    = () => process.env.AZURE_OPENAI_KEY
const DEPLOYMENT = () => process.env.AZURE_OPENAI_DEPLOYMENT || 'adip-gpt'
const API_VER    = '2024-10-21'

// ── chat START ────────────────────────────────────────────────────────────────
async function chat(systemPrompt, userContent, maxTokens = 400) {
  console.log('[chat] starts')
  if (!ENDPOINT() || !API_KEY()) {
    console.log('[chat] ends — Azure OpenAI not configured')
    throw new Error('Azure OpenAI not configured')
  }
  const url = `${ENDPOINT()}/openai/deployments/${DEPLOYMENT()}/chat/completions?api-version=${API_VER}`
  const res  = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': API_KEY() },
    body: JSON.stringify({
      messages:    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
      max_tokens:  maxTokens,
      temperature: 0.3,
    }),
  })
  if (!res.ok) {
    console.log('[chat] ends — OpenAI API error:', res.status)
    throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`)
  }
  const data = await res.json()
  const result = data.choices[0]?.message?.content?.trim() || ''
  console.log('[chat] ends')
  return result
}
// ── chat END ──────────────────────────────────────────────────────────────────


// ── explainDrift START ────────────────────────────────────────────────────────
async function explainDrift(record) {
  console.log('[explainDrift] starts')
  const changes = (record.differences || record.changes || [])
    .map(c => c.sentence || `${c.type} ${c.path}`).slice(0, 15).join('\n')
  const result = await chat(
    'You are an Azure security expert. Explain this configuration drift in plain English in 3-4 sentences. Focus on security implications. No markdown, no bullet points.',
    `Resource: ${record.resourceId?.split('/').pop()} (type: ${record.resourceId?.split('/')[7] || 'unknown'})\nResource Group: ${record.resourceGroup}\nChanges:\n${changes}`
  )
  console.log('[explainDrift] ends')
  return result
}
// ── explainDrift END ──────────────────────────────────────────────────────────


// ── reclassifySeverity START ──────────────────────────────────────────────────
async function reclassifySeverity(record) {
  console.log('[reclassifySeverity] starts')
  const changes = (record.differences || record.changes || [])
    .map(c => c.sentence || `${c.type} ${c.path}: ${JSON.stringify(c.oldValue)} → ${JSON.stringify(c.newValue)}`)
    .slice(0, 10).join('\n')
  const response = await chat(
    'You are an Azure security expert. Classify drift severity. Respond ONLY with valid JSON: {"severity":"critical|high|medium|low","reasoning":"one sentence"}',
    `Resource type: ${record.resourceId?.split('/')[7] || 'unknown'}\nRule-based severity: ${record.severity}\nChanges:\n${changes}`,
    150
  )
  const parsed = JSON.parse(response.replace(/```json|```/g, '').trim())
  console.log('[reclassifySeverity] ends')
  return parsed
}
// ── reclassifySeverity END ────────────────────────────────────────────────────


// ── getRemediationRecommendation START ────────────────────────────────────────
async function getRemediationRecommendation(record) {
  console.log('[getRemediationRecommendation] starts')
  const changes = (record.differences || record.changes || [])
    .map(c => c.sentence || `${c.type} ${c.path}`).slice(0, 10).join('\n')
  const result = await chat(
    'You are an Azure cloud architect. Give a 2-3 sentence remediation recommendation. Explain what reverting to baseline will do and whether it is safe. No markdown.',
    `Resource: ${record.resourceId?.split('/').pop()}\nChanges to revert:\n${changes}`
  )
  console.log('[getRemediationRecommendation] ends')
  return result
}
// ── getRemediationRecommendation END ─────────────────────────────────────────


// ── detectAnomalies START ─────────────────────────────────────────────────────
async function detectAnomalies(driftRecords) {
  console.log('[detectAnomalies] starts')
  if (!driftRecords?.length) {
    console.log('[detectAnomalies] ends — no drift records provided')
    return []
  }
  const summary = driftRecords.slice(0, 50).map(r => ({
    resource: r.resourceId?.split('/').pop() || 'unknown',
    rg:       r.resourceGroup,
    severity: r.severity,
    changes:  r.changeCount,
    time:     r.detectedAt,
    actor:    r.caller || r.actor || 'unknown',
  }))
  const response = await chat(
    'You are an Azure security analyst. Find anomalies in this drift history. Respond ONLY with valid JSON array (max 3 items): [{"title":"short title","description":"1-2 sentences","severity":"high|medium|low","affectedResource":"name"}]. Return [] if no anomalies.',
    JSON.stringify(summary),
    500
  )
  const parsed = JSON.parse(response.replace(/```json|```/g, '').trim())
  const result = Array.isArray(parsed) ? parsed : []
  console.log('[detectAnomalies] ends — anomalies found:', result.length)
  return result
}
// ── detectAnomalies END ───────────────────────────────────────────────────────

// ── predictDrift START ────────────────────────────────────────────────────────
// Analyses historical drift records for a resource and predicts future drift risk.
// Returns: likelihood (HIGH/MEDIUM/LOW), predictedDays, fieldsAtRisk[], reasoning, basedOn
async function predictDrift(subscriptionId, resourceId) {
  console.log('[predictDrift] starts — resourceId:', resourceId)

  const blobSvc  = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
  const driftCtr = blobSvc.getContainerClient('drift-records')
  const tc       = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'driftIndex')

  const records = []
  const filter  = `PartitionKey eq '${subscriptionId}' and resourceId eq '${resourceId}'`
  for await (const entity of tc.listEntities({ queryOptions: { filter } })) {
    if (records.length >= 30) break
    const doc = await readBlob(driftCtr, entity.blobKey)
    if (doc) records.push(doc)
  }

  if (!records.length) {
    console.log('[predictDrift] ends — no history, returning low risk')
    return { likelihood: 'LOW', predictedDays: null, fieldsAtRisk: [], reasoning: 'No drift history found for this resource.', basedOn: '0 drift events' }
  }

  const sorted  = records.sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt))
  const summary = sorted.map(r => ({
    detectedAt:  r.detectedAt,
    severity:    r.severity,
    changeCount: r.changeCount,
    fields:      (r.differences || r.changes || []).map(d => d.path).slice(0, 5),
    caller:      r.caller || 'unknown',
  }))

  const response = await chat(
    `You are an Azure infrastructure risk analyst. Analyse this resource's drift history and predict future drift risk.
Respond ONLY with valid JSON (no markdown):
{"likelihood":"HIGH|MEDIUM|LOW","predictedDays":<integer 1-7 or null>,"fieldsAtRisk":["field.path"],"reasoning":"2-3 sentences","basedOn":"X drift events over Y days"}`,
    `Resource: ${resourceId.split('/').pop()} (${resourceId.split('/')[7] || 'unknown'})\nHistory (newest first):\n${JSON.stringify(summary)}`,
    400
  )

  const parsed = JSON.parse(response.replace(/```json|```/g, '').trim())
  console.log('[predictDrift] ends — likelihood:', parsed.likelihood)
  return parsed
}
// ── predictDrift END ──────────────────────────────────────────────────────────



// ── getRecommendations START ─────────────────────────────────────────────────
// Returns 3 specific, actionable AI recommendations based on a resource's drift history
async function getRecommendations(subscriptionId, resourceId) {
  console.log('[getRecommendations] starts — resourceId:', resourceId)

  const blobSvc  = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
  const driftCtr = blobSvc.getContainerClient('drift-records')
  const tc       = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'driftIndex')

  const records = []
  const filter  = `PartitionKey eq '${subscriptionId}' and resourceId eq '${resourceId}'`
  for await (const entity of tc.listEntities({ queryOptions: { filter } })) {
    if (records.length >= 20) break
    const doc = await readBlob(driftCtr, entity.blobKey)
    if (doc) records.push(doc)
  }

  if (!records.length) {
    return [{ title: 'No drift history', description: 'No drift events found for this resource.', priority: 'Low', action: 'Monitor the resource and establish a baseline.' }]
  }

  const summary = records.sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt)).map(r => ({
    detectedAt:  r.detectedAt,
    severity:    r.severity,
    changeCount: r.changeCount,
    fields:      (r.differences || r.changes || []).map(d => d.path).slice(0, 5),
    caller:      r.caller || 'unknown',
  }))

  const response = await chat(
    `You are an Azure cloud architect. Based on this resource's drift history, give 3 specific actionable recommendations to prevent future drift.
Respond ONLY with valid JSON array (no markdown):
[{"title":"short title under 8 words","description":"2 sentences max","priority":"Critical|High|Medium|Low","action":"specific Azure service or feature to use"}]`,
    `Resource: ${resourceId.split('/').pop()} (${resourceId.split('/')[7] || 'unknown'})
Drift history:
${JSON.stringify(summary)}`,
    600
  )

  const parsed = JSON.parse(response.replace(/```json|```/g, '').trim())
  console.log('[getRecommendations] ends — count:', parsed.length)
  return Array.isArray(parsed) ? parsed : []
}
// ── getRecommendations END ────────────────────────────────────────────────────


// ── getDriftRecordsForAnomaly START ───────────────────────────────────────────
async function getDriftRecordsForAnomaly(subscriptionId) {
  console.log('[getDriftRecordsForAnomaly] starts — subscriptionId:', subscriptionId)
  const tc = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'driftIndex')
  const blobSvc = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
  const driftCtr = blobSvc.getContainerClient('drift-records')

  const results = []
  const filter  = `PartitionKey eq '${subscriptionId}'`
  for await (const entity of tc.listEntities({ queryOptions: { filter } })) {
    if (results.length >= 50) break
    const doc = await readBlob(driftCtr, entity.blobKey)
    if (doc) results.push(doc)
  }
  const sorted = results.sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt))
  console.log('[getDriftRecordsForAnomaly] ends — records fetched:', sorted.length)
  return sorted
}
// ── getDriftRecordsForAnomaly END ─────────────────────────────────────────────


// ── getRgRecommendations START ───────────────────────────────────────────────
// Returns AI recommendations scoped to ALL drifted resources in a resource group
async function getRgRecommendations(subscriptionId, resourceGroup) {
  console.log('[getRgRecommendations] starts — rg:', resourceGroup)

  const blobSvc  = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
  const driftCtr = blobSvc.getContainerClient('drift-records')
  const tc       = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'driftIndex')

  // Fetch up to 30 drift records for this resource group
  const records = []
  const filter  = `PartitionKey eq '${subscriptionId}' and resourceGroup eq '${resourceGroup}'`
  for await (const entity of tc.listEntities({ queryOptions: { filter } })) {
    if (records.length >= 30) break
    const doc = await readBlob(driftCtr, entity.blobKey)
    if (doc) records.push(doc)
  }

  if (!records.length) {
    return [{ title: 'No drift history', description: 'No drift events found for this resource group.', priority: 'Low', action: 'Monitor resources and establish baselines.' }]
  }

  // Build per-resource summary
  const byResource = {}
  records.sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt)).forEach(r => {
    const name = r.resourceId?.split('/').pop() || 'unknown'
    if (!byResource[name]) byResource[name] = { name, type: r.resourceId?.split('/')[7], drifts: 0, severities: [], fields: [] }
    byResource[name].drifts++
    byResource[name].severities.push(r.severity)
    byResource[name].fields.push(...(r.differences || r.changes || []).map(d => d.path).slice(0, 3))
  })

  const summary = Object.values(byResource).map(r => ({
    resource:   r.name,
    type:       r.type,
    driftCount: r.drifts,
    severities: [...new Set(r.severities)],
    topFields:  [...new Set(r.fields)].slice(0, 4),
  }))

  const response = await chat(
    `You are an Azure cloud architect. Based on drift history across multiple resources in a resource group, give 4-5 specific actionable recommendations to prevent future drift across the group.
Each recommendation should reference the specific resource(s) it applies to.
Respond ONLY with valid JSON array (no markdown):
[{"title":"short title under 10 words","description":"2 sentences referencing specific resources","priority":"Critical|High|Medium|Low","action":"specific Azure service or feature","affectedResources":["resource1"]}]`,
    `Resource group: ${resourceGroup}
Drift summary per resource:
${JSON.stringify(summary)}`,
    800
  )

  const parsed = JSON.parse(response.replace(/```json|```/g, '').trim())
  console.log('[getRgRecommendations] ends — count:', parsed.length)
  return Array.isArray(parsed) ? parsed : []
}
// ── getRgRecommendations END ──────────────────────────────────────────────────


// ── Main handler START ────────────────────────────────────────────────────────
module.exports = async function (context, req) {
  console.log('[mainHandler] starts — operation:', context.bindingData.operation)
  const operation = context.bindingData.operation?.toLowerCase()

  try {
    switch (operation) {

      case 'explain': {
        console.log('[mainHandler] routing to explainDrift')
        if (req.method !== 'POST') {
          console.log('[mainHandler] ends — 405 wrong method for explain')
          context.res = { status: 405, body: { error: 'POST required' } }
          return
        }
        const explanation = await explainDrift(req.body)
        context.res = { status: 200, body: { explanation } }
        console.log('[mainHandler] ends — explain success')
        break
      }

      case 'severity': {
        console.log('[mainHandler] routing to reclassifySeverity')
        if (req.method !== 'POST') {
          console.log('[mainHandler] ends — 405 wrong method for severity')
          context.res = { status: 405, body: { error: 'POST required' } }
          return
        }
        const result = await reclassifySeverity(req.body)
        context.res = { status: 200, body: result || {} }
        console.log('[mainHandler] ends — severity success')
        break
      }

      case 'recommend': {
        console.log('[mainHandler] routing to getRemediationRecommendation')
        if (req.method !== 'POST') {
          console.log('[mainHandler] ends — 405 wrong method for recommend')
          context.res = { status: 405, body: { error: 'POST required' } }
          return
        }
        const recommendation = await getRemediationRecommendation(req.body)
        context.res = { status: 200, body: { recommendation } }
        console.log('[mainHandler] ends — recommend success')
        break
      }

      case 'anomalies': {
        console.log('[mainHandler] routing to detectAnomalies')
        if (req.method !== 'GET') {
          console.log('[mainHandler] ends — 405 wrong method for anomalies')
          context.res = { status: 405, body: { error: 'GET required' } }
          return
        }
        const subscriptionId = req.query.subscriptionId
        if (!subscriptionId) {
          console.log('[mainHandler] ends — 400 missing subscriptionId')
          context.res = { status: 400, body: { error: 'subscriptionId required' } }
          return
        }
        const records   = await getDriftRecordsForAnomaly(subscriptionId)
        const anomalies = await detectAnomalies(records)
        context.res = { status: 200, body: { anomalies } }
        console.log('[mainHandler] ends — anomalies success')
        break
      }

      case 'rg-recommendations': {
        if (req.method !== 'GET') { context.res = { status: 405, body: { error: 'GET required' } }; return }
        const { subscriptionId: rgSubId, resourceGroup: rgName } = req.query
        if (!rgSubId || !rgName) { context.res = { status: 400, body: { error: 'subscriptionId and resourceGroup required' } }; return }
        const rgRecs = await getRgRecommendations(rgSubId, rgName)
        context.res = { status: 200, body: rgRecs }
        console.log('[mainHandler] ends — rg-recommendations success')
        break
      }

      case 'recommendations': {
        if (req.method !== 'GET') { context.res = { status: 405, body: { error: 'GET required' } }; return }
        const { subscriptionId: rSubId, resourceId: rResId } = req.query
        if (!rSubId || !rResId) { context.res = { status: 400, body: { error: 'subscriptionId and resourceId required' } }; return }
        const recs = await getRecommendations(rSubId, rResId)
        context.res = { status: 200, body: recs }
        console.log('[mainHandler] ends — recommendations success')
        break
      }

      case 'predict': {
        console.log('[mainHandler] routing to predictDrift')
        if (req.method !== 'GET') { context.res = { status: 405, body: { error: 'GET required' } }; return }
        const { subscriptionId: subId, resourceId: resId } = req.query
        if (!subId || !resId) { context.res = { status: 400, body: { error: 'subscriptionId and resourceId required' } }; return }
        const prediction = await predictDrift(subId, resId)
        context.res = { status: 200, body: prediction }
        console.log('[mainHandler] ends — predict success')
        break
      }

      default:
        console.log('[mainHandler] ends — 404 unknown operation:', operation)
        context.res = { status: 404, body: { error: `Unknown AI operation: ${operation}` } }
    }
  } catch (err) {
    console.log('[mainHandler] ends — caught error:', err.message)
    context.log.error(`[aiOperations/${operation}] error:`, err.message)
    context.res = { status: 500, body: { error: err.message } }
  }
}
// ── Main handler END ──────────────────────────────────────────────────────────