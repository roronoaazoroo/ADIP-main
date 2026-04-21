// ============================================================
// FILE: services/aiService.js
// ROLE: Azure OpenAI integration — all AI features for drift analysis
//
// Functions:
//   callAzureOpenAI(systemPrompt, userMessage, maxTokens)
//     — generic wrapper: sends one chat turn to GPT-4o, returns response text
//   explainDrift(driftRecord)         — plain-English security explanation
//   reclassifySeverity(driftRecord)   — AI severity override (can only escalate)
//   getRemediationRecommendation(driftRecord) — what reverting to baseline will do
//   detectAnomalies(recentDriftRecords) — pattern detection across last 50 records
// ============================================================
const fetch = require('node-fetch')

const ENDPOINT   = () => process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '')
const API_KEY    = () => process.env.AZURE_OPENAI_KEY
const DEPLOYMENT = () => process.env.AZURE_OPENAI_DEPLOYMENT || 'adip-gpt'
const API_VER    = '2024-10-21'

// ── chat START ──────────────────────────────────────────────────────────────
// Sends a chat completion request to Azure OpenAI and returns the response text
// Sends a single-turn chat completion to Azure OpenAI and returns the response text
async function callAzureOpenAI(systemPrompt, userMessageContent, maxTokens = 400) {
  console.log('[callAzureOpenAI] starts')
  if (!ENDPOINT() || !API_KEY()) {
    console.log('[callAzureOpenAI] ends — no endpoint/key configured')
    throw new Error('Azure OpenAI not configured')
  }

  const openAiUrl    = `${ENDPOINT()}/openai/deployments/${DEPLOYMENT()}/chat/completions?api-version=${API_VER}`
  const httpResponse = await fetch(openAiUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': API_KEY() },
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
// ── chat END ─────────────────────────────────────────────────────────────────


// ── explainDrift START ───────────────────────────────────────────────────────
// Feature 1: Natural Language Drift Explanation
// Sends drift changes to Azure OpenAI and returns a plain-English security explanation
async function explainDrift(driftRecord) {
  console.log('[explainDrift] starts')
  if (!ENDPOINT()) {
    console.log('[explainDrift] ends — no endpoint configured')
    return null
  }
  try {
    const changesText = (driftRecord.differences || driftRecord.changes || [])
      .map(changeItem => changeItem.sentence || `${changeItem.type} ${changeItem.path}`)
      .slice(0, 15).join('\n')

    const explanationText = await callAzureOpenAI(
      'You are an Azure security expert. Explain this configuration drift in plain English in 3-4 sentences. Focus on security implications. No markdown, no bullet points.',
      `Resource: ${driftRecord.resourceId?.split('/').pop()} (type: ${driftRecord.resourceId?.split('/')[7] || 'unknown'})\nResource Group: ${driftRecord.resourceGroup}\nChanges:\n${changesText}`
    )
    console.log('[explainDrift] ends')
    return explanationText
  } catch (aiError) {
    console.error('[AI explainDrift]', aiError.message)
    console.log('[explainDrift] ends — caught error')
    return null
  }
}
// ── explainDrift END ─────────────────────────────────────────────────────────


// ── reclassifySeverity START ─────────────────────────────────────────────────
// Feature 2: AI Severity Re-classification
// Sends changes to Azure OpenAI to get a severity rating that may override rule-based classification
async function reclassifySeverity(driftRecord) {
  console.log('[reclassifySeverity] starts')
  if (!ENDPOINT()) {
    console.log('[reclassifySeverity] ends — no endpoint configured')
    return null
  }
  try {
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
  } catch (aiError) {
    console.error('[AI reclassify]', aiError.message)
    console.log('[reclassifySeverity] ends — caught error')
    return null
  }
}
// ── reclassifySeverity END ───────────────────────────────────────────────────


// ── getRemediationRecommendation START ───────────────────────────────────────
// Feature 3: Remediation Recommendation
// Returns an AI-generated explanation of what reverting to baseline will do and if it is safe
async function getRemediationRecommendation(driftRecord) {
  console.log('[getRemediationRecommendation] starts')
  if (!ENDPOINT()) {
    console.log('[getRemediationRecommendation] ends — no endpoint configured')
    return null
  }
  try {
    const changesText = (driftRecord.differences || driftRecord.changes || [])
      .map(changeItem => changeItem.sentence || `${changeItem.type} ${changeItem.path}`)
      .slice(0, 10).join('\n')

    const recommendationText = await callAzureOpenAI(
      'You are an Azure cloud architect. Give a 2-3 sentence remediation recommendation. Explain what reverting to baseline will do and whether it is safe. No markdown.',
      `Resource: ${driftRecord.resourceId?.split('/').pop()}\nChanges to revert:\n${changesText}`
    )
    console.log('[getRemediationRecommendation] ends')
    return recommendationText
  } catch (aiError) {
    console.error('[AI recommend]', aiError.message)
    console.log('[getRemediationRecommendation] ends — caught error')
    return null
  }
}
// ── getRemediationRecommendation END ─────────────────────────────────────────


// ── detectAnomalies START ────────────────────────────────────────────────────
// Feature 5: Anomaly Detection
// Analyses the last 50 drift records to surface unusual patterns in the drift history
async function detectAnomalies(recentDriftRecords) {
  console.log('[detectAnomalies] starts')
  if (!ENDPOINT() || !recentDriftRecords?.length) {
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