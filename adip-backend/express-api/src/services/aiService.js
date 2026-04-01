const fetch = require('node-fetch')

const ENDPOINT   = () => process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '')
const API_KEY    = () => process.env.AZURE_OPENAI_KEY
const DEPLOYMENT = () => process.env.AZURE_OPENAI_DEPLOYMENT || 'adip-gpt'
const API_VER    = '2024-10-21'

async function chat(systemPrompt, userContent, maxTokens = 400) {
  if (!ENDPOINT() || !API_KEY()) throw new Error('Azure OpenAI not configured')

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
  if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`)
  const data = await res.json()
  return data.choices[0]?.message?.content?.trim() || ''
}

// ── Feature 1: Natural Language Drift Explanation ─────────────────────────────
async function explainDrift(record) {
  if (!ENDPOINT()) return null
  try {
    const changes = (record.differences || record.changes || [])
      .map(c => c.sentence || `${c.type} ${c.path}`)
      .slice(0, 15).join('\n')

    return await chat(
      'You are an Azure security expert. Explain this configuration drift in plain English in 3-4 sentences. Focus on security implications. No markdown, no bullet points.',
      `Resource: ${record.resourceId?.split('/').pop()} (type: ${record.resourceId?.split('/')[7] || 'unknown'})
Resource Group: ${record.resourceGroup}
Changes:\n${changes}`
    )
  } catch (e) { console.error('[AI explainDrift]', e.message); return null }
}

// ── Feature 2: AI Severity Re-classification ──────────────────────────────────
async function reclassifySeverity(record) {
  if (!ENDPOINT()) return null
  try {
    const changes = (record.differences || record.changes || [])
      .map(c => c.sentence || `${c.type} ${c.path}: ${JSON.stringify(c.oldValue)} → ${JSON.stringify(c.newValue)}`)
      .slice(0, 10).join('\n')

    const response = await chat(
      'You are an Azure security expert. Classify drift severity. Respond ONLY with valid JSON: {"severity":"critical|high|medium|low","reasoning":"one sentence"}',
      `Resource type: ${record.resourceId?.split('/')[7] || 'unknown'}
Rule-based severity: ${record.severity}
Changes:\n${changes}`,
      150
    )
    return JSON.parse(response.replace(/```json|```/g, '').trim())
  } catch (e) { console.error('[AI reclassify]', e.message); return null }
}

// ── Feature 3: Remediation Recommendation ────────────────────────────────────
async function getRemediationRecommendation(record) {
  if (!ENDPOINT()) return null
  try {
    const changes = (record.differences || record.changes || [])
      .map(c => c.sentence || `${c.type} ${c.path}`)
      .slice(0, 10).join('\n')

    return await chat(
      'You are an Azure cloud architect. Give a 2-3 sentence remediation recommendation. Explain what reverting to baseline will do and whether it is safe. No markdown.',
      `Resource: ${record.resourceId?.split('/').pop()}
Changes to revert:\n${changes}`
    )
  } catch (e) { console.error('[AI recommend]', e.message); return null }
}

// ── Feature 5: Anomaly Detection ─────────────────────────────────────────────
async function detectAnomalies(driftRecords) {
  if (!ENDPOINT() || !driftRecords?.length) return []
  try {
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
    return Array.isArray(parsed) ? parsed : []
  } catch (e) { console.error('[AI anomalies]', e.message); return [] }
}

module.exports = { explainDrift, reclassifySeverity, getRemediationRecommendation, detectAnomalies }
