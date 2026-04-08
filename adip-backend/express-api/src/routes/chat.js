'use strict'
const router = require('express').Router()
const fetch  = require('node-fetch')

const ENDPOINT   = () => process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '')
const API_KEY    = () => process.env.AZURE_OPENAI_KEY
const DEPLOYMENT = () => process.env.AZURE_OPENAI_DEPLOYMENT || 'adip-gpt'
const API_VER    = '2024-10-21'

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
  const { messages, context } = req.body
  if (!messages?.length) return res.status(400).json({ error: 'messages required' })
  if (!ENDPOINT() || !API_KEY()) return res.status(503).json({ error: 'Azure OpenAI not configured' })

  try {
    // Inject drift context into system prompt if provided
    let systemPrompt = SYSTEM_PROMPT
    if (context?.resourceId || context?.driftSummary) {
      systemPrompt += `\n\nCurrent context:\n`
      if (context.resourceId) systemPrompt += `Resource: ${context.resourceId}\n`
      if (context.driftSummary) systemPrompt += `Recent drift: ${context.driftSummary}\n`
    }

    const url = `${ENDPOINT()}/openai/deployments/${DEPLOYMENT()}/chat/completions?api-version=${API_VER}`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': API_KEY() },
      body: JSON.stringify({
        messages: [{ role: 'system', content: systemPrompt }, ...messages.slice(-20)], // keep last 20 turns
        max_tokens: 600,
        temperature: 0.4,
        stream: false,
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      return res.status(response.status).json({ error: err })
    }

    const data = await response.json()
    res.json({ reply: data.choices[0]?.message?.content?.trim() || '' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
