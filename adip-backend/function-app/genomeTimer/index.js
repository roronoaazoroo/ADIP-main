// ============================================================
// FILE: adip-backend/function-app/genomeTimer/index.js
// ROLE: Azure Functions Timer Trigger — daily genome snapshots at 7 PM
//       Replaces in-process setTimeout scheduler
// ============================================================
'use strict'
const { app } = require('@azure/functions')
const { DefaultAzureCredential } = require('@azure/identity')
const { ResourceManagementClient } = require('@azure/arm-resources')
const { BlobServiceClient } = require('@azure/storage-blob')
const { TableClient } = require('@azure/data-tables')

app.timer('genomeTimer', {
  // Run daily at 7:00 PM UTC
  schedule: '0 0 19 * * *',
  handler: async (timer, context) => {
    context.log('[genomeTimer] Daily genome snapshot triggered')

    const connStr = process.env.STORAGE_CONNECTION_STRING
    if (!connStr) { context.log('[genomeTimer] No STORAGE_CONNECTION_STRING'); return }

    try {
      // Get all organizations to find monitored subscriptions
      const orgTable = TableClient.fromConnectionString(connStr, 'organizations')
      const orgs = []
      for await (const entity of orgTable.listEntities()) {
        if (entity.subscriptionId) orgs.push(entity)
      }

      const credential = new DefaultAzureCredential()
      const blobSvc = BlobServiceClient.fromConnectionString(connStr)
      const genomeCtr = blobSvc.getContainerClient('baseline-genome')
      await genomeCtr.createIfNotExists()
      const genomeTable = TableClient.fromConnectionString(connStr, 'genomeDailyIndex')

      let snapshotCount = 0

      for (const org of orgs) {
        const sub = org.subscriptionId
        const armClient = new ResourceManagementClient(credential, sub)

        // List all RGs
        for await (const rg of armClient.resourceGroups.list()) {
          try {
            // List resources in RG
            const resources = []
            for await (const r of armClient.resources.listByResourceGroup(rg.name)) {
              resources.push({ id: r.id, name: r.name, type: r.type, location: r.location })
            }

            // Save daily genome snapshot
            const ts = new Date().toISOString().replace(/[:.]/g, '-')
            const key = `daily_${ts}_${Buffer.from(rg.name).toString('base64url')}.json`
            const data = JSON.stringify({ resourceGroup: rg, resources, snapshotType: 'daily', timestamp: new Date().toISOString() })
            await genomeCtr.getBlockBlobClient(key).upload(data, data.length)

            // Index in table
            await genomeTable.upsertEntity({
              partitionKey: sub,
              rowKey: Buffer.from(key).toString('base64url').slice(0, 512),
              resourceGroup: rg.name,
              blobKey: key,
              resourceCount: resources.length,
              timestamp: new Date().toISOString(),
            }, 'Replace').catch(() => {})

            snapshotCount++
          } catch (e) {
            context.log(`[genomeTimer] Error on ${rg.name}: ${e.message}`)
          }
        }
      }

      context.log(`[genomeTimer] Completed — ${snapshotCount} snapshots saved`)
    } catch (error) {
      context.log('[genomeTimer] Fatal error:', error.message)
      throw error
    }
  },
})
