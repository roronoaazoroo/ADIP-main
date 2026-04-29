// FILE: services/aiService.js
// ROLE: Azure OpenAI integration — all AI features for drift analysis
//
// Functions:
//   callAzureOpenAI(systemPrompt, userMessage, maxTokens)
//     — generic wrapper: sends one chat turn to GPT-4o, returns response text
//   explainDrift(driftRecord)                    — plain-English security explanation
//   reclassifySeverity(driftRecord)              — AI severity override (can only escalate)
//   getRemediationRecommendation(driftRecord)    — what reverting to baseline will do
//   detectAnomalies(recentDriftRecords)          — pattern detection across last 50 records
'use strict'
const fetch = require('node-fetch')

// Azure OpenAI configuration — read from environment at call time
// API_VERSION is pinned here; update when Azure OpenAI releases a new stable version
const OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21'

// ── callAzureOpenAI START ────────────────────────────────────────────────────
// Sends a single-turn chat completion to Azure OpenAI and returns the response text
async function callAzureOpenAI(systemPrompt, userMessageContent, maxTokens = 400) {
  console.log('[callAzureOpenAI] starts')

  const endpoint   = process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '')
  const apiKey     = process.env.AZURE_OPENAI_KEY
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'adip-gpt'

  if (!endpoint || !apiKey) {
    console.log('[callAzureOpenAI] ends — no endpoint/key configured')
    throw new Error('Azure OpenAI not configured')
  }

  const openAiUrl    = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${OPENAI_API_VERSION}`
  const httpResponse = await fetch(openAiUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify({
      messages:    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessageContent }],
      max_tokens:  maxTokens,
      temperature: 0.3,
    }),
  })
  if (!httpResponse.ok) {
    console.log('[callAzureOpenAI] ends — API error')
    throw new Error(`OpenAI API error ${httpResponse.status}: ${await httpResponse.text()}`)
  }
  const responseData = await httpResponse.json()
  const responseText = responseData.choices[0]?.message?.content?.trim() || ''
  console.log('[callAzureOpenAI] ends')
  return responseText
}
// ── callAzureOpenAI END ───────────────────────────────────────────────────────

// ── withAiGuard START ─────────────────────────────────────────────────────────
// Shared guard for all AI functions:
//   - Validates driftRecord is a non-null object
//   - Checks AZURE_OPENAI_ENDPOINT is configured
//   - Wraps the AI call in try/catch, returns null/[] on failure
// Eliminates the repeated guard + try/catch pattern across all AI functions (DRY)
async function withAiGuard(fnName, driftRecord, fallback, aiCallFn) {
  if (!driftRecord || typeof driftRecord !== 'object') {
    console.log(`[${fnName}] ends — invalid driftRecord, skipping`)
    return fallback
  }
  if (!process.env.AZURE_OPENAI_ENDPOINT) {
    console.log(`[${fnName}] ends — no endpoint configured`)
    return fallback
  }
  try {
    return await aiCallFn()
  } catch (aiError) {
    console.error(`[${fnName}] caught error:`, aiError.message)
    console.log(`[${fnName}] ends — caught error`)
    return fallback
  }
}
// ── withAiGuard END ───────────────────────────────────────────────────────────


// ── explainDrift START ───────────────────────────────────────────────────────
// Feature 1: Natural Language Drift Explanation
// Sends drift changes to Azure OpenAI and returns a plain-English security explanation
async function explainDrift(driftRecord) {
  console.log('[explainDrift] starts')
  return withAiGuard('explainDrift', driftRecord, null, async () => {
    const changesText = (driftRecord.differences || driftRecord.changes || [])
      .map(changeItem => changeItem.sentence || `${changeItem.type} ${changeItem.path}`)
      .slice(0, 15).join('\n')

    const explanationText = await callAzureOpenAI(
      'You are an Azure security expert. Explain this configuration drift in plain English in 3-4 sentences. Focus on security implications. No markdown, no bullet points.',
      `Resource: ${driftRecord.resourceId?.split('/').pop()} (type: ${driftRecord.resourceId?.split('/')[7] || 'unknown'})\nResource Group: ${driftRecord.resourceGroup}\nChanges:\n${changesText}`
    )
    console.log('[explainDrift] ends')
    return explanationText
  })
}
// ── explainDrift END ─────────────────────────────────────────────────────────


// ── reclassifySeverity START ─────────────────────────────────────────────────
// Feature 2: AI Severity Re-classification
// Sends changes to Azure OpenAI to get a severity rating that may override rule-based classification
async function reclassifySeverity(driftRecord) {
  console.log('[reclassifySeverity] starts')
  return withAiGuard('reclassifySeverity', driftRecord, null, async () => {
    const changesText = (driftRecord.differences || driftRecord.changes || [])
      .map(changeItem => changeItem.sentence || `${changeItem.type} ${changeItem.path}: ${JSON.stringify(changeItem.oldValue)} → ${JSON.stringify(changeItem.newValue)}`)
      .slice(0, 10).join('\n')

    const aiResponseText = await callAzureOpenAI(
      'You are an Azure security expert. Classify drift severity. Respond ONLY with valid JSON: {"severity":"critical|high|medium|low","reasoning":"one sentence"}',
      `Resource type: ${driftRecord.resourceId?.split('/')[7] || 'unknown'}\nRule-based severity: ${driftRecord.severity}\nChanges:\n${changesText}`,
      150
    )
    const parsedSeverity = JSON.parse(aiResponseText.replace(/```json|```/g, '').trim())
    console.log('[reclassifySeverity] ends')
    return parsedSeverity
  })
}
// ── reclassifySeverity END ───────────────────────────────────────────────────


// ── getRemediationRecommendation START ───────────────────────────────────────
// Feature 3: Remediation Recommendation
// Returns an AI-generated explanation of what reverting to baseline will do and if it is safe
async function getRemediationRecommendation(driftRecord) {
  console.log('[getRemediationRecommendation] starts')
  return withAiGuard('getRemediationRecommendation', driftRecord, null, async () => {
    const changesText = (driftRecord.differences || driftRecord.changes || [])
      .map(changeItem => changeItem.sentence || `${changeItem.type} ${changeItem.path}`)
      .slice(0, 10).join('\n')

    const recommendationText = await callAzureOpenAI(
      'You are an Azure cloud architect. Give a 2-3 sentence remediation recommendation. Explain what reverting to baseline will do and whether it is safe. No markdown.',
      `Resource: ${driftRecord.resourceId?.split('/').pop()}\nChanges to revert:\n${changesText}`
    )
    console.log('[getRemediationRecommendation] ends')
    return recommendationText
  })
}
// ── getRemediationRecommendation END ─────────────────────────────────────────


// ── detectAnomalies START ────────────────────────────────────────────────────
// Feature 5: Anomaly Detection
// Analyses the last 50 drift records to surface unusual patterns in the drift history
async function detectAnomalies(recentDriftRecords) {
  console.log('[detectAnomalies] starts')

  if (!Array.isArray(recentDriftRecords) || !recentDriftRecords.length) {
    console.log('[detectAnomalies] ends — no endpoint or empty records')
    return []
  }
  if (!process.env.AZURE_OPENAI_ENDPOINT) {
    console.log('[detectAnomalies] ends — no endpoint or empty records')
    return []
  }

  try {
    // Build a compact summary of each drift record for the AI prompt
    const driftSummaryForAI = recentDriftRecords.slice(0, 50).map(driftRecord => ({
      resource: driftRecord.resourceId?.split('/').pop() || 'unknown',
      rg:       driftRecord.resourceGroup,
      severity: driftRecord.severity,
      changes:  driftRecord.changeCount,
      time:     driftRecord.detectedAt,
      actor:    driftRecord.caller || driftRecord.actor || 'unknown',
    }))

    const aiResponseText = await callAzureOpenAI(
      'You are an Azure security analyst. Find anomalies in this drift history. Respond ONLY with valid JSON array (max 3 items): [{"title":"short title","description":"1-2 sentences","severity":"high|medium|low","affectedResource":"name"}]. Return [] if no anomalies.',
      JSON.stringify(driftSummaryForAI),
      500
    )
    const parsedAnomalies = JSON.parse(aiResponseText.replace(/```json|```/g, '').trim())
    const anomalyList     = Array.isArray(parsedAnomalies) ? parsedAnomalies : []
    console.log('[detectAnomalies] ends')
    return anomalyList
  } catch (aiError) {
    console.error('[AI anomalies]', aiError.message)
    console.log('[detectAnomalies] ends — caught error')
    return []
  }
}
// ── detectAnomalies END ──────────────────────────────────────────────────────

module.exports = { explainDrift, reclassifySeverity, getRemediationRecommendation, detectAnomalies }
