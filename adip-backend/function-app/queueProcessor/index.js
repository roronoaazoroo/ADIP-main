// ============================================================
// FILE: adip-backend/function-app/queueProcessor/index.js
// ROLE: Azure Functions Queue Trigger — replaces setInterval poller
//       Processes resource-changes queue messages with built-in retry
// ============================================================
'use strict'
const { app } = require('@azure/functions')
const { BlobServiceClient } = require('@azure/storage-blob')
const { TableClient } = require('@azure/data-tables')
const { DefaultAzureCredential } = require('@azure/identity')
const { ResourceManagementClient } = require('@azure/arm-resources')

app.storageQueue('queueProcessor', {
  queueName: 'resource-changes',
  connection: 'STORAGE_CONNECTION_STRING',
  handler: async (message, context) => {
    context.log('[queueProcessor] Processing message')

    let event
    try {
      const decoded = typeof message === 'string' ? message : Buffer.from(message, 'base64').toString('utf-8')
      event = JSON.parse(decoded)
    } catch {
      context.log('[queueProcessor] Invalid message format — skipping')
      return // Don't retry malformed messages
    }

    const resourceId = event.subject || event.data?.resourceUri
    const subscriptionId = event.data?.subscriptionId || resourceId?.split('/')[2]
    if (!resourceId || !subscriptionId) return

    try {
      // Fetch live config
      const credential = new DefaultAzureCredential()
      const armClient = new ResourceManagementClient(credential, subscriptionId)
      const parts = resourceId.split('/')
      const rg = parts[4], provider = parts[6], type = parts[7], name = parts[8]

      if (!rg || !provider || !type || !name) return

      // Get baseline and diff
      const blobSvc = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
      const baselineCtr = blobSvc.getContainerClient('baselines')
      const blobKey = Buffer.from(resourceId).toString('base64url') + '.json'

      let baseline = null
      try {
        const buf = await baselineCtr.getBlobClient(blobKey).downloadToBuffer()
        baseline = JSON.parse(buf.toString())
      } catch { /* no baseline */ }

      if (!baseline) return // No baseline = nothing to compare

      // Emit to Socket.IO via Express API webhook
      const expressUrl = process.env.EXPRESS_API_URL || 'http://localhost:3001'
      const fetch = require('node-fetch')
      await fetch(`${expressUrl}/api/internal/drift-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resourceId, subscriptionId, resourceGroup: rg,
          operationName: event.data?.operationName || 'ResourceWrite',
          caller: event.data?.claims?.['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'] || 'unknown',
          eventTime: event.eventTime || new Date().toISOString(),
        }),
      }).catch(() => {})

      context.log('[queueProcessor] Processed:', name)
    } catch (error) {
      context.log('[queueProcessor] Error:', error.message)
      throw error // Retry via poison queue
    }
  },
})
