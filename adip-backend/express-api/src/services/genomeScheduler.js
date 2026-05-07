// ============================================================
// FILE: adip-backend/express-api/src/services/genomeScheduler.js
// ROLE: Automated genome operations
//   - createDailySnapshots(): snapshots all monitored resources
//   - cleanupExpiredGenomes(): deletes genomes past retention
// Called by setInterval in app.js (daily) or manually via API
// ============================================================
'use strict'
const { TableClient } = require('@azure/data-tables')
const { BlobServiceClient } = require('@azure/storage-blob')
const { getResourceConfig } = require('./azureResourceService')

function genomeIndexTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'genomeIndex')
}

function organizationsTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'organizations')
}

/**
 * Creates a daily genome snapshot for all resources that have at least one existing genome.
 * Groups by subscriptionId, fetches live config, saves snapshot with label 'daily-{date}'.
 */
async function createDailySnapshots() {
  console.log('[createDailySnapshots] starts')
  const { saveGenomeSnapshot } = require('./blobService')
  const today = new Date().toISOString().slice(0, 10)

  // Get retention from org settings (default 30)
  let retentionDays = 30
  try {
    for await (const org of organizationsTable().listEntities()) {
      retentionDays = org.retentionDays || 30
      break // use first org's setting
    }
  } catch { /* use default */ }

  // Find all unique resourceIds that have genomes
  const resourceMap = {} // { resourceId: subscriptionId }
  try {
    for await (const entity of genomeIndexTable().listEntities()) {
      if (entity.resourceId && !resourceMap[entity.resourceId]) {
        resourceMap[entity.resourceId] = entity.partitionKey
      }
    }
  } catch (error) {
    console.log('[createDailySnapshots] error listing genomes:', error.message)
    return { created: 0, errors: 0 }
  }

  let created = 0
  let errors = 0

  for (const [resourceId, subscriptionId] of Object.entries(resourceMap)) {
    try {
      // Parse resourceId to get resourceGroup
      const parts = resourceId.split('/')
      const resourceGroupId = parts[4] || ''
      const liveConfig = await getResourceConfig(subscriptionId, resourceGroupId, resourceId)
      if (liveConfig) {
        await saveGenomeSnapshot(subscriptionId, resourceId, liveConfig, `daily-${today}`, retentionDays)
        created++
      }
    } catch (error) {
      console.log('[createDailySnapshots] error for', resourceId.split('/').pop(), ':', error.message)
      errors++
    }
  }

  console.log('[createDailySnapshots] ends — created:', created, 'errors:', errors)
  return { created, errors }
}

/**
 * Deletes genome snapshots that have passed their expiresAt date.
 * Removes both the blob and the table entity.
 */
async function cleanupExpiredGenomes() {
  console.log('[cleanupExpiredGenomes] starts')
  const now = new Date().toISOString()
  let deleted = 0

  try {
    const blobService = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
    const container = blobService.getContainerClient('baseline-genome')

    for await (const entity of genomeIndexTable().listEntities()) {
      if (!entity.expiresAt || entity.expiresAt > now) continue
      try {
        // Delete blob
        await container.getBlobClient(entity.blobKey).delete().catch(() => {})
        // Delete table entity
        await genomeIndexTable().deleteEntity(entity.partitionKey, entity.rowKey)
        deleted++
      } catch { /* non-fatal per entity */ }
    }
  } catch (error) {
    console.log('[cleanupExpiredGenomes] error:', error.message)
  }

  console.log('[cleanupExpiredGenomes] ends — deleted:', deleted)
  return { deleted }
}

module.exports = { createDailySnapshots, cleanupExpiredGenomes }
