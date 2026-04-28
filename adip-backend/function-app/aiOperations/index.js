'use strict'
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') })
const fetch = require('node-fetch')
const { BlobServiceClient } = require('@azure/storage-blob')
const { TableClient }       = require('@azure/data-tables')
const { blobKey, readBlob } = require('adip-shared/blobHelpers')

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