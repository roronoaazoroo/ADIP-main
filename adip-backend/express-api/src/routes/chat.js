'use strict'
const router = require('express').Router()
const fetch  = require('node-fetch')

// API version pinned — update when Azure OpenAI releases a new stable version
const CHAT_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21'

const SYSTEM_PROMPT = `You are an Azure Cloud Expert assistant embedded in the Azure Drift Intelligence Platform (ADIP).
You help users with:
- Azure architecture questions and best practices
- Understanding configuration drift and its security/cost implications
- Explaining specific Azure resource configurations (Storage, VMs, Key Vault, NSGs, App Services, etc.)
- Cost optimization recommendations for Azure resources
- Remediation guidance when drift is detected
- Azure Policy, RBAC, and compliance questions

When discussing drift, be specific about which configuration changes matter for security vs cost vs compliance.
Keep answers concise and actionable. Use bullet points for lists. No markdown headers.`

// POST /api/chat  { messages: [{role, content}], context?: { resourceId, driftSummary } }
router.post('/chat', async (req, res) => {
  const { messages: conversationHistory, context: resourceContext } = req.body
  if (!Array.isArray(conversationHistory) || !conversationHistory.length) return res.status(400).json({ error: 'messages must be a non-empty array' })
  const endpoint   = process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '')
  const apiKey     = process.env.AZURE_OPENAI_KEY
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'adip-gpt'
  if (!endpoint || !apiKey) return res.status(503).json({ error: 'Azure OpenAI not configured' })

  try {
    // Build the system prompt, optionally injecting the current resource context
    let systemPromptWithContext = SYSTEM_PROMPT
    if (resourceContext?.resourceId || resourceContext?.driftSummary) {
      systemPromptWithContext += `\n\nCurrent context:\n`
      if (resourceContext.resourceId)   systemPromptWithContext += `Resource: ${resourceContext.resourceId}\n`
      if (resourceContext.driftSummary) systemPromptWithContext += `Recent drift: ${resourceContext.driftSummary}\n`
    }

    // Auto-fetch resource config if user mentions a known resource name
    const lastUserMessage = (conversationHistory[conversationHistory.length - 1]?.content || '').toLowerCase()
    try {
      const { getResourceConfig } = require('../services/azureResourceService')
      const { TableClient } = require('@azure/data-tables')
      const subId = process.env.AZURE_SUBSCRIPTION_ID
      if (subId) {
        const changesTc = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'changesIndex')
        const seen = new Set()
        for await (const entity of changesTc.listEntities({ queryOptions: { filter: `PartitionKey eq '${subId}'` } })) {
          const resName = (entity.resourceId || '').split('/').pop()?.toLowerCase()
          if (!resName || seen.has(resName)) continue
          seen.add(resName)
          if (lastUserMessage.includes(resName)) {
            const rg = entity.resourceGroup || entity.resourceId.split('/')[4]
            const config = await getResourceConfig(subId, rg, entity.resourceId)
            if (config) {
              systemPromptWithContext += `\n\nLIVE CONFIGURATION of ${resName} (fetched from Azure):\n${JSON.stringify(config, null, 2).slice(0, 4000)}\nUse this data to answer the user.`
            }
            break
          }
        }
      }
    } catch (configErr) { console.log('[chat] config fetch non-fatal:', configErr.message) }

    const openAiEndpointUrl = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${CHAT_API_VERSION}`
    const openAiResponse = await fetch(openAiEndpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        messages: [{ role: 'system', content: systemPromptWithContext }, ...conversationHistory.slice(-20)], // keep last 20 turns
        max_tokens: 600,
        temperature: 0.4,
        stream: false,
      }),
    })

    if (!openAiResponse.ok) {
      const errorBody = await openAiResponse.text()
      return res.status(openAiResponse.status).json({ error: errorBody })
    }

    const openAiResponseData = await openAiResponse.json()
    res.json({ reply: openAiResponseData.choices[0]?.message?.content?.trim() || '' })
  } catch (chatError) {
    res.status(500).json({ error: chatError.message })
  }
})

module.exports = router
