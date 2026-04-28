require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') })
const { BlobServiceClient } = require('@azure/storage-blob')
const { TableClient }       = require('@azure/data-tables')
const fetch                 = require('node-fetch')

const ENDPOINT   = process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '')
const API_KEY    = process.env.AZURE_OPENAI_KEY
const DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || 'adip-gpt'
const API_VER    = '2024-10-21'
const SUB        = '8f461bb6-e3a4-468b-b134-8b1269337ac7'

async function chat(system, user, maxTokens = 600) {
  const url = `${ENDPOINT}/openai/deployments/${DEPLOYMENT}/chat/completions?api-version=${API_VER}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': API_KEY },
    body: JSON.stringify({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens, temperature: 0.3 }),
  })
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`)
  const d = await res.json()
  return d.choices[0]?.message?.content?.trim() || ''
}

async function getAllDriftRecords() {
  const blobSvc  = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
  const driftCtr = blobSvc.getContainerClient('drift-records')
  const tc       = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'driftIndex')

  const records = []
  for await (const entity of tc.listEntities({ queryOptions: { filter: `PartitionKey eq '${SUB}'` } })) {
    if (records.length >= 50) break
    const blobClient = driftCtr.getBlobClient(entity.blobKey)
    try {
      const dl = await blobClient.download()
      const chunks = []
      for await (const chunk of dl.readableStreamBody) chunks.push(chunk)
      records.push(JSON.parse(Buffer.concat(chunks).toString()))
    } catch {}
  }
  return records.sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt))
}

async function main() {
  console.log('\n========== STEP 1: Fetch all drift records ==========')
  const records = await getAllDriftRecords()
  console.log(`Total drift records found: ${records.length}`)
  
  if (!records.length) { console.log('No drift records — cannot test prediction'); return }

  // Show summary of all records
  console.log('\n--- Drift Record Summary ---')
  const byResource = {}
  records.forEach(r => {
    const name = r.resourceId?.split('/').pop() || 'unknown'
    if (!byResource[name]) byResource[name] = []
    byResource[name].push({ detectedAt: r.detectedAt, severity: r.severity, changeCount: r.changeCount, fields: (r.differences||r.changes||[]).map(d=>d.path).slice(0,3) })
  })
  Object.entries(byResource).forEach(([name, recs]) => {
    console.log(`\nResource: ${name} (${recs.length} drift events)`)
    recs.forEach(r => console.log(`  ${r.detectedAt} | ${r.severity} | ${r.changeCount} changes | fields: ${r.fields.join(', ')}`))
  })

  // Pick the resource with most drift history
  const topResource = Object.entries(byResource).sort((a,b) => b[1].length - a[1].length)[0]
  const topResId = records.find(r => r.resourceId?.split('/').pop() === topResource[0])?.resourceId
  console.log(`\n========== STEP 2: Test Prediction for "${topResource[0]}" (${topResource[1].length} events) ==========`)

  const summary = topResource[1].map(r => ({
    detectedAt: r.detectedAt, severity: r.severity, changeCount: r.changeCount,
    fields: r.fields, caller: 'unknown'
  }))

  const predResponse = await chat(
    `You are an Azure infrastructure risk analyst. Analyse this resource's drift history and predict future drift risk.
Respond ONLY with valid JSON (no markdown):
{"likelihood":"HIGH|MEDIUM|LOW","predictedDays":<integer 1-7 or null>,"fieldsAtRisk":["field.path"],"reasoning":"2-3 sentences","basedOn":"X drift events over Y days"}`,
    `Resource: ${topResource[0]}\nHistory (newest first):\n${JSON.stringify(summary)}`,
    400
  )
  const prediction = JSON.parse(predResponse.replace(/```json|```/g, '').trim())
  console.log('\nPREDICTION RESULT:')
  console.log(JSON.stringify(prediction, null, 2))

  console.log('\n========== STEP 3: Test AI Recommendations ==========')
  const recResponse = await chat(
    `You are an Azure cloud architect. Based on this drift history, give 3 specific, actionable recommendations to prevent future drift.
Respond ONLY with valid JSON array (no markdown):
[{"title":"short title","description":"2 sentences","priority":"Critical|High|Medium|Low","action":"specific Azure action to take"}]`,
    `Drift history for ${topResource[0]}:\n${JSON.stringify(summary)}`,
    600
  )
  const recommendations = JSON.parse(recResponse.replace(/```json|```/g, '').trim())
  console.log('\nRECOMMENDATIONS:')
  recommendations.forEach((r, i) => {
    console.log(`\n[${i+1}] ${r.title} (${r.priority})`)
    console.log(`    ${r.description}`)
    console.log(`    Action: ${r.action}`)
  })

  console.log('\n========== STEP 4: Accuracy Assessment ==========')
  const assessResponse = await chat(
    `You are evaluating an AI drift prediction system. Given the actual drift history and the prediction made, assess accuracy.
Respond ONLY with valid JSON (no markdown):
{"accuracyScore":0-100,"assessment":"2 sentences","isReasoningAccurate":true|false,"areFieldsAccurate":true|false,"confidence":"high|medium|low"}`,
    `Actual drift history: ${JSON.stringify(summary)}\nPrediction made: ${JSON.stringify(prediction)}`,
    300
  )
  const accuracy = JSON.parse(assessResponse.replace(/```json|```/g, '').trim())
  console.log('\nACCURACY ASSESSMENT:')
  console.log(JSON.stringify(accuracy, null, 2))
}

main().catch(e => console.error('FATAL:', e.message, e.stack))
