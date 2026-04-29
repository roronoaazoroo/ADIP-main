// FILE: services/storageChildService.js
// ROLE: Shared business logic for reconciling storage account child resources

// Handles: blob containers, file shares, queues, tables

// reconcileStorageChildren(subscriptionId, rgName, accountName, baselineChildConfig, liveChildConfig, credential)
//   - Deletes items in live but NOT in baseline
//   - Creates items in baseline but NOT in live

'use strict'
const fetch = require('node-fetch')

// ARM API version for storage child resources — centralised to avoid hardcoding in multiple files
const STORAGE_CHILD_API_VERSION = process.env.STORAGE_CHILD_API_VERSION || '2023-01-01'

// ARM management endpoint — use env var to support sovereign clouds
const ARM_ENDPOINT = process.env.ARM_ENDPOINT || 'https://management.azure.com'

// Child resource type definitions: Table key, ARM service path, PUT body for creation
const STORAGE_CHILD_TYPES = [
  { key: 'blobContainers',  path: 'blobServices/default/containers',  createBody: { properties: {} } },
  { key: 'fileShares',      path: 'fileServices/default/shares',       createBody: { properties: {} } },
  { key: 'storageQueues',   path: 'queueServices/default/queues',      createBody: {} },
  { key: 'storageTables',   path: 'tableServices/default/tables',      createBody: {} },
]

/**
 * Calls an ARM REST endpoint for a storage account child resource.
 * @param {string} method - HTTP method (PUT, DELETE)
 * @param {string} subscriptionId
 * @param {string} resourceGroupName
 * @param {string} storageAccountName
 * @param {string} childResourcePath - e.g. 'blobServices/default/containers/mycontainer'
 * @param {object|null} requestBody
 * @param {string} bearerToken
 */
async function callStorageChildApi(method, subscriptionId, resourceGroupName, storageAccountName, childResourcePath, requestBody, bearerToken) {
  const armUrl = `${ARM_ENDPOINT}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Storage/storageAccounts/${storageAccountName}/${childResourcePath}?api-version=${STORAGE_CHILD_API_VERSION}`
  const fetchOptions = {
    method,
    headers: { 'Authorization': `Bearer ${bearerToken}`, 'Content-Type': 'application/json' },
  }
  if (requestBody) fetchOptions.body = JSON.stringify(requestBody)
  const httpResponse = await fetch(armUrl, fetchOptions)
  if (!httpResponse.ok) {
    const errorText = await httpResponse.text()
    throw new Error(`Storage child API ${method} ${childResourcePath} failed ${httpResponse.status}: ${errorText}`)
  }
}

/**
 * Reconciles storage account child resources (containers, shares, queues, tables)
 * between a baseline config and the current live config.
 * Items in live but NOT in baseline are deleted.
 * Items in baseline but NOT in live are created.
 *
 * @param {string} subscriptionId
 * @param {string} resourceGroupName
 * @param {string} storageAccountName
 * @param {object} baselineChildConfig - baseline._childConfig
 * @param {object} liveChildConfig     - liveState._childConfig
 * @param {object} credential          - DefaultAzureCredential instance
 */
async function reconcileStorageChildren(subscriptionId, resourceGroupName, storageAccountName, baselineChildConfig, liveChildConfig, credential) {
  console.log('[reconcileStorageChildren] starts — account:', storageAccountName)

  const tokenResponse = await credential.getToken('https://management.azure.com/.default')
  const bearerToken   = tokenResponse.token

  await Promise.allSettled(
    STORAGE_CHILD_TYPES.map(async ({ key, path, createBody }) => {
      const baselineItems = (baselineChildConfig?.[key] || []).map(item => item.name.toLowerCase())
      const liveItems     = (liveChildConfig?.[key]     || []).map(item => item.name.toLowerCase())

      // Items in live but NOT in baseline → delete
      for (const itemName of liveItems.filter(n => !baselineItems.includes(n))) {
        try {
          await callStorageChildApi('DELETE', subscriptionId, resourceGroupName, storageAccountName, `${path}/${itemName}`, null, bearerToken)
          console.log(`[reconcileStorageChildren] deleted ${key}: ${itemName}`)
        } catch (deleteError) {
          console.warn(`[reconcileStorageChildren] failed to delete ${key} ${itemName}:`, deleteError.message)
        }
      }

      // Items in baseline but NOT in live → create
      for (const itemName of baselineItems.filter(n => !liveItems.includes(n))) {
        try {
          await callStorageChildApi('PUT', subscriptionId, resourceGroupName, storageAccountName, `${path}/${itemName}`, createBody, bearerToken)
          console.log(`[reconcileStorageChildren] created ${key}: ${itemName}`)
        } catch (createError) {
          console.warn(`[reconcileStorageChildren] failed to create ${key} ${itemName}:`, createError.message)
        }
      }
    })
  )

  console.log('[reconcileStorageChildren] ends')
}

module.exports = { reconcileStorageChildren }
