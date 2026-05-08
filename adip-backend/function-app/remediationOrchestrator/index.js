// ============================================================
// FILE: adip-backend/function-app/remediationOrchestrator/index.js
// ROLE: Durable Functions orchestrator for approval + remediation workflow
//       Handles: ticket creation → approval wait → remediation execution → audit
// ============================================================
'use strict'
const { app } = require('@azure/functions')
const df = require('durable-functions')

// Orchestrator: manages the full remediation lifecycle
df.app.orchestration('remediationOrchestrator', function* (context) {
  const input = context.df.getInput()
  const { ticketId, subscriptionId, resourceGroupId, resourceId, requiredApprovals } = input

  // Step 1: Wait for approvals (with 48h timeout)
  const approvalResult = yield context.df.waitForExternalEvent('ApprovalReceived', '48:00:00')

  if (!approvalResult || approvalResult.action === 'reject') {
    yield context.df.callActivity('recordAudit', { ticketId, action: 'rejected', timestamp: new Date().toISOString() })
    return { status: 'rejected', ticketId }
  }

  // Step 2: Execute remediation
  const remediationResult = yield context.df.callActivity('executeRemediation', {
    subscriptionId, resourceGroupId, resourceId, ticketId,
  })

  // Step 3: Record audit
  yield context.df.callActivity('recordAudit', {
    ticketId, action: 'remediated', result: remediationResult, timestamp: new Date().toISOString(),
  })

  return { status: 'completed', ticketId, result: remediationResult }
})

// Activity: Execute the actual remediation
df.app.activity('executeRemediation', {
  handler: async (input, context) => {
    const { subscriptionId, resourceGroupId, resourceId, ticketId } = input
    const fetch = require('node-fetch')
    const expressUrl = process.env.EXPRESS_API_URL || 'http://localhost:3001'

    // Call Express API to perform remediation (reuses existing logic)
    const res = await fetch(`${expressUrl}/api/remediate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.INTERNAL_API_KEY}` },
      body: JSON.stringify({ subscriptionId, resourceGroupId, resourceId, ticketId, internal: true }),
    })

    if (!res.ok) throw new Error(`Remediation failed: ${res.status}`)
    return await res.json()
  },
})

// Activity: Record audit entry
df.app.activity('recordAudit', {
  handler: async (input, context) => {
    const { TableClient } = require('@azure/data-tables')
    const tc = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'remediationAudit')
    await tc.upsertEntity({
      partitionKey: input.ticketId,
      rowKey: new Date().toISOString(),
      ...input,
    }, 'Replace').catch(() => {})
  },
})

// HTTP trigger to start orchestration (called by approval ticket system)
app.http('startRemediation', {
  methods: ['POST'],
  route: 'orchestrate/remediation',
  handler: async (req, context) => {
    const client = df.getClient(context)
    const body = await req.json()
    const instanceId = await client.startNew('remediationOrchestrator', { input: body })
    return { status: 202, jsonBody: { instanceId, statusUrl: client.createHttpManagementPayload(instanceId) } }
  },
})
