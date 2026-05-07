'use strict'
// All imports at top — functions defined after dependencies are loaded
const router      = require('express').Router()
const { TableClient } = require('@azure/data-tables')
const { saveGenomeSnapshot, listGenomeSnapshots, getGenomeSnapshot, saveBaseline, deleteGenomeSnapshot } = require('../services/blobService')
const { getResourceConfig, getApiVersion } = require('../services/azureResourceService')
const { strip } = require('../shared/diff')
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential }   = require('@azure/identity')

// Is this a full ARM resource ID or just a resource group name?
const isArmId = (id) => id && id.startsWith('/subscriptions/')

// Returns a Table Storage client for the genomeIndex table
function getGenomeIndexTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'genomeIndex')
}

// Updates a flag field on all genomeIndex entities for a resource.
// Sets flagValue on the matching blobKey only — does NOT clear the flag on other entities.
// Each rollback/promote event is preserved independently in history.
async function updateGenomeFlag(subscriptionId, resourceId, blobKey, flagField, flagValue) {
  const genomeTable = getGenomeIndexTable()
  const filter = `PartitionKey eq '${subscriptionId}' and resourceId eq '${resourceId}' and blobKey eq '${blobKey}'`
  for await (const entity of genomeTable.listEntities({ queryOptions: { filter } })) {
    await genomeTable.upsertEntity({
      ...entity,
      [flagField]: flagValue,
    }, 'Replace').catch(flagUpdateError => {
      console.warn('[updateGenomeFlag] non-fatal upsert error:', flagUpdateError.message)
    })
  }
}

// Sets isCurrentBaseline=true on the target and false on all others for the resource.
// Used exclusively by promote — ensures only one snapshot is the active baseline.
async function setCurrentBaseline(subscriptionId, resourceId, blobKey) {
  const genomeTable = getGenomeIndexTable()
  const filter = `PartitionKey eq '${subscriptionId}' and resourceId eq '${resourceId}'`
  for await (const entity of genomeTable.listEntities({ queryOptions: { filter } })) {
    await genomeTable.upsertEntity({
      ...entity,
      isCurrentBaseline: entity.blobKey === blobKey ? true : false,
    }, 'Replace').catch(err => console.warn('[setCurrentBaseline] non-fatal:', err.message))
  }
}

//  GET /api/genome START 
// Returns all versioned configuration snapshots for a resource, sorted newest-first
router.get('/genome', async (req, res) => {
  console.log('[GET /genome] starts')
  const { subscriptionId, resourceId, limit } = req.query
  if (!subscriptionId) {
    console.log('[GET /genome] ends — missing subscriptionId')
    return res.status(400).json({ error: 'subscriptionId required' })
  }
  try {
    res.json(await listGenomeSnapshots(subscriptionId, resourceId, Number(limit) || 50))
  } catch (routeError) { res.status(500).json({ error: routeError.message }) }
})
//  GET /api/genome END 

// POST /api/genome/save
router.post('/genome/save', async (req, res) => {
  console.log('[POST /genome/save] starts')
  const { subscriptionId, resourceGroupId, resourceId, label } = req.body
  if (!subscriptionId || !resourceGroupId || !resourceId) {
    console.log('[POST /genome/save] ends — missing required fields')
    return res.status(400).json({ error: 'subscriptionId, resourceGroupId and resourceId required' })
  }
  try {
    // For full ARM IDs fetch the specific resource; for RG-level fetch the whole group
    const liveConfig = isArmId(resourceId)
      ? await getResourceConfig(subscriptionId, resourceGroupId, resourceId)
      : await getResourceConfig(subscriptionId, resourceGroupId, null)

    const snapshot = await saveGenomeSnapshot(subscriptionId, resourceId, liveConfig, label || '')
    res.json(snapshot)
  } catch (routeError) { res.status(500).json({ error: routeError.message }) }
})
//  POST /api/genome/save END 

// POST /api/genome/promote — make snapshot the golden baseline
router.post('/genome/promote', async (req, res) => {
  console.log('[POST /genome/promote] starts')
  const { subscriptionId, resourceGroupId, resourceId, blobKey } = req.body
  if (!subscriptionId || !resourceId || !blobKey) {
    console.log('[POST /genome/promote] ends — missing required fields')
    return res.status(400).json({ error: 'subscriptionId, resourceId and blobKey required' })
  }
  try {
    const snapshot = await getGenomeSnapshot(blobKey)
    if (!snapshot?.resourceState) {
      console.log('[POST /genome/promote] ends — snapshot not found')
      return res.status(404).json({ error: 'Snapshot not found' })
    }
    await saveBaseline(subscriptionId, resourceGroupId || '', resourceId, snapshot.resourceState)

    // Mark this snapshot as the active baseline; clear the flag on all others
    await setCurrentBaseline(subscriptionId, resourceId, blobKey).catch(() => {})
    await updateGenomeFlag(subscriptionId, resourceId, blobKey, 'promotedAt', new Date().toISOString()).catch(() => {})

    res.json({ promoted: true, resourceId, blobKey })
  } catch (routeError) { res.status(500).json({ error: routeError.message }) }
})
//  POST /api/genome/promote END 

// POST /api/genome/rollback — revert resource to snapshot via ARM PUT
router.post('/genome/rollback', async (req, res) => {
  console.log('[POST /genome/rollback] starts')
  const { subscriptionId, resourceGroupId, resourceId, blobKey } = req.body
  if (!subscriptionId || !resourceGroupId || !resourceId || !blobKey) {
    console.log('[POST /genome/rollback] ends — missing required fields')
    return res.status(400).json({ error: 'subscriptionId, resourceGroupId, resourceId and blobKey required' })}
  try {
    const snapshot = await getGenomeSnapshot(blobKey)
    if (!snapshot?.resourceState) {
      console.log('[POST /genome/rollback] ends — snapshot not found')
      return res.status(404).json({ error: 'Snapshot not found' })
    }

    const credential = new DefaultAzureCredential()
    const armClient  = new ResourceManagementClient(credential, subscriptionId)

    // Resource group snapshot: rollback each resource individually
    if (!isArmId(resourceId) && snapshot.resourceState.resources) {
      const results = []
      for (const r of snapshot.resourceState.resources) {
        if (!r.id) continue
        try {
          const state    = strip(r)
          const parts    = r.id.split('/')
          const rgName   = parts[4], provider = parts[6], type = parts[7], name = parts[8]
          if (!rgName || !provider || !type || !name) continue
          const apiVersion = await getApiVersion(subscriptionId, provider, type)
          const location   = state.location || (await armClient.resources.get(rgName, provider, '', type, name, apiVersion).catch(() => ({}))).location || process.env.DEFAULT_AZURE_LOCATION || 'eastus'
          await armClient.resources.beginCreateOrUpdateAndWait(rgName, provider, '', type, name, apiVersion, { ...state, location })
          results.push({ resourceId: r.id, status: 'rolledBack' })
        } catch (e) {
          results.push({ resourceId: r.id, status: 'failed', error: e.message })
        }
      }
      return res.json({ rolledBack: true, resourceId, blobKey, savedAt: snapshot.savedAt, results })
    }

    // Single resource rollback — retry up to 3 times for exclusive access errors
    const state      = strip(snapshot.resourceState)
    const parts      = resourceId.split('/')
    const rgName = parts[4], provider = parts[6], type = parts[7], name = parts[8]
    const apiVersion = await getApiVersion(subscriptionId, provider, type)
    let location = state.location
    if (!location) {
      try { location = (await armClient.resources.get(rgName, provider, '', type, name, apiVersion)).location }
      catch { location = process.env.DEFAULT_AZURE_LOCATION || 'eastus' }
    }

    const MAX_RETRIES = 3
    let lastError
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await armClient.resources.beginCreateOrUpdateAndWait(rgName, provider, '', type, name, apiVersion, { ...state, location })
        lastError = null
        break
      } catch (armError) {
        lastError = armError
        const isLocked = armError.message?.toLowerCase().includes('exclusive access') ||
                         armError.message?.toLowerCase().includes('another operation') ||
                         armError.statusCode === 409
        if (!isLocked || attempt === MAX_RETRIES) throw armError
        const delayMs = attempt * 15000  // 15s, 30s
        console.log(`[POST /genome/rollback] ARM locked, retrying in ${delayMs}ms (attempt ${attempt}/${MAX_RETRIES})`)
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
    }

    // Mark this snapshot as the active rollback; clear the flag on all others
    await updateGenomeFlag(subscriptionId, resourceId, blobKey, 'rolledBackAt', new Date().toISOString()).catch(() => {})
    res.json({ rolledBack: true, resourceId, blobKey, savedAt: snapshot.savedAt })
  } catch (routeError) { res.status(500).json({ error: routeError.message }) }
})
//  POST /api/genome/rollback END 


// GET /api/genome/config?blobKey=&subscriptionId=&resourceId= — returns stored config for a genome event
router.get('/genome/config', async (req, res) => {
  const { blobKey, subscriptionId, resourceId } = req.query
  if (!blobKey) return res.status(400).json({ error: 'blobKey query param required' })
  try {
    const { getSnapshotConfig, getGenomeSnapshot } = require('../services/blobService')
    const { getResourceConfig } = require('../services/azureResourceService')
    // Try blob lookup across all genome containers
    let doc = await getSnapshotConfig(blobKey)
    if (!doc) doc = await getGenomeSnapshot(blobKey)
    if (doc) {
      return res.json({ resourceState: doc.resourceState || doc, savedAt: doc.savedAt, label: doc.label, snapshotType: doc.snapshotType, caller: doc.caller })
    }
    // Fallback: blob expired or missing — fetch live ARM config if resourceId provided
    if (subscriptionId && resourceId) {
      try {
        const parts = resourceId.split('/')
        const rgName = parts[4] || ''
        if (rgName) {
          const liveConfig = await getResourceConfig(subscriptionId, rgName, resourceId)
          if (liveConfig) return res.json({ resourceState: liveConfig, savedAt: null, label: 'live (snapshot expired)', snapshotType: 'live', caller: '' })
        }
      } catch (armErr) {
        console.log('[GET /genome/config] ARM fallback failed:', armErr.message)
      }
    }
    res.status(404).json({ error: 'Configuration not available — blob expired and live fetch failed' })
  } catch (err) { res.status(500).json({ error: err.message }) }
})



// GET /api/genome/best-configs?subscriptionId=&resourceId= — AI picks top 3 configs
router.get('/genome/best-configs', async (req, res) => {
  const { subscriptionId, resourceId } = req.query
  if (!subscriptionId || !resourceId) return res.status(400).json({ error: 'subscriptionId and resourceId required' })

  const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '')
  const apiKey = process.env.AZURE_OPENAI_KEY
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'adip-gpt'
  if (!endpoint || !apiKey) return res.status(503).json({ error: 'Azure OpenAI not configured' })

  try {
    const fetch = require('node-fetch')
    const { getSnapshotConfig, getGenomeSnapshot, listGenomeSnapshots } = require('../services/blobService')

    // Get last 20 snapshots
    const snapshots = await listGenomeSnapshots(subscriptionId, resourceId, 20)
    if (!snapshots.length) return res.json([])

    // Extract summary from each
    const summaries = []
    for (const snap of snapshots) {
      const doc = snap.resourceState || (await getSnapshotConfig(snap._blobKey).catch(() => null))?.resourceState || (await getGenomeSnapshot(snap._blobKey).catch(() => null))?.resourceState
      if (!doc) continue
      const props = doc.properties || {}
      summaries.push({
        index: summaries.length,
        savedAt: snap.savedAt,
        blobKey: snap._blobKey,
        sku: doc.sku?.name || '',
        tier: doc.sku?.tier || '',
        accessTier: props.accessTier || '',
        supportsHttpsTrafficOnly: props.supportsHttpsTrafficOnly ?? '',
        minimumTlsVersion: props.minimumTlsVersion || '',
        allowBlobPublicAccess: props.allowBlobPublicAccess ?? '',
        networkAcls_defaultAction: props.networkAcls?.defaultAction || '',
        networkAcls_ipRules: (props.networkAcls?.ipRules || []).length,
        networkAcls_vnRules: (props.networkAcls?.virtualNetworkRules || []).length,
        encryption_keySource: props.encryption?.keySource || '',
        identity: doc.identity?.type || 'None',
        tags: Object.keys(doc.tags || {}).length,
      })
    }

    if (!summaries.length) return res.json([])

    const systemPrompt = `You are an Azure cloud architect. Analyze these configuration snapshots of the same resource at different times. Pick the BEST config for each category:
1. cost_optimized — lowest cost (cheapest SKU/tier, no premium features, efficient access tier)
2. most_secure — strongest security (HTTPS enforced, TLS 1.2, public access disabled, encryption, strict ACLs)
3. best_networking — tightest network isolation (defaultAction Deny, VNet rules, no public access)

Respond ONLY with valid JSON array:
[{"category":"cost_optimized","index":N,"reason":"one sentence"},{"category":"most_secure","index":N,"reason":"one sentence"},{"category":"best_networking","index":N,"reason":"one sentence"}]
where index is the position in the configs array.`

    const aiResp = await fetch(`${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${process.env.AZURE_OPENAI_API_VERSION || '2024-10-21'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(summaries.map(s => ({ ...s, blobKey: undefined }))) },
        ],
        max_tokens: 300,
        temperature: 0.2,
      }),
    })

    if (!aiResp.ok) return res.status(502).json({ error: 'AI request failed' })
    const aiData = await aiResp.json()
    const raw = aiData.choices?.[0]?.message?.content?.trim() || '[]'
    const parsed = JSON.parse(raw.replace(/```json|```/g, ''))

    // Enrich with snapshot metadata
    const result = parsed.map(pick => {
      const snap = summaries[pick.index] || summaries[0]
      return { category: pick.category, reason: pick.reason, savedAt: snap.savedAt, blobKey: snap.blobKey, config: snap }
    })

    res.json(result)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET /api/genome/categorize?subscriptionId=&resourceId= — AI-categorized genome history
// Categorizes each genome using GPT-4o. Caches result in Table so AI is called only once per entry.
router.get('/genome/categorize', async (req, res) => {
  const { subscriptionId, resourceId } = req.query
  if (!subscriptionId || !resourceId) return res.status(400).json({ error: 'subscriptionId and resourceId required' })
  try {
    const fetch = require('node-fetch')
    const genomeTable = getGenomeIndexTable()
    const filter = `PartitionKey eq '${subscriptionId}'`
    const resourceIdLower = resourceId.toLowerCase()
    const categories = ['Network', 'Security', 'Tags', 'SKU', 'Identity', 'Configuration']
    const events = []
    const uncategorized = []

    for await (const entity of genomeTable.listEntities({ queryOptions: { filter } })) {
      if (entity.resourceId?.toLowerCase() !== resourceIdLower) continue
      const event = {
        eventType: 'created', eventAt: entity.savedAt, blobKey: entity.blobKey,
        snapshotLabel: entity.label || 'snapshot', snapshotType: entity.snapshotType || '',
        caller: entity.caller || '', changedFields: entity.changedFields || '',
        isCurrentBaseline: entity.isCurrentBaseline || false,
        rolledBackAt: entity.rolledBackAt || null, promotedAt: entity.promotedAt || null,
        _rowKey: entity.rowKey, _partitionKey: entity.partitionKey,
      }
      events.push(event)
      if (!event.changedFields || !categories.includes(event.changedFields.split(',')[0])) {
        uncategorized.push(event)
      }
    }

    // Return immediately — categorize uncategorized entries in background (non-blocking)
    uncategorized.forEach(e => { if (!e.changedFields) e.changedFields = 'Configuration' })

    // Fire-and-forget: AI categorization runs after response is sent
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '')
    const apiKey = process.env.AZURE_OPENAI_KEY
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'adip-gpt'

    // AI categorization using GPT-4o — runs in background, caches to Table
    // Rate limit: 1 req/sec to stay within 10 req/10s limit
    if (uncategorized.length > 0) {
      const { getSnapshotConfig, getGenomeSnapshot } = require('../services/blobService')
      const fetch = require('node-fetch')
      const aiEndpoint = process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '')
      const aiKey = process.env.AZURE_OPENAI_KEY
      const aiDeployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'adip-gpt'
      const valid = ['Network','Security','Tags','SKU','Identity','Configuration']
      const aiUrl = `${aiEndpoint}/openai/deployments/${aiDeployment}/chat/completions?api-version=${process.env.AZURE_OPENAI_API_VERSION || '2024-10-21'}`
      const sysPrompt = 'You classify Azure config changes. Based on the changed fields, respond with exactly ONE word from: Network, Security, Tags, SKU, Identity, Configuration. Network=networkAcls/ipRules/virtualNetworkRules/subnets/publicIP/firewall/defaultAction. Security=encryption/supportsHttpsTrafficOnly/minimumTlsVersion/securityRules/accessPolicies/allowBlobPublicAccess/keySource. Tags=tags. SKU=sku/tier/capacity. Identity=identity/managedIdentity/principalId. Configuration=everything else.'

      setImmediate(async () => {
        for (const event of uncategorized) {
          try {
            // Compare this snapshot with the next one (older) to find what actually changed
            const doc = await getSnapshotConfig(event.blobKey).catch(() => null) || await getGenomeSnapshot(event.blobKey).catch(() => null)
            let diffKeys = ''
            if (doc?.resourceState) {
              const idx = events.indexOf(event)
              const olderEvent = events[idx + 1]
              if (olderEvent?.blobKey) {
                const olderDoc = await getSnapshotConfig(olderEvent.blobKey).catch(() => null) || await getGenomeSnapshot(olderEvent.blobKey).catch(() => null)
                if (olderDoc?.resourceState) {
                  // Find keys that differ between the two snapshots
                  const curr = JSON.stringify(doc.resourceState)
                  const prev = JSON.stringify(olderDoc.resourceState)
                  const changedKeys = []
                  for (const k of Object.keys(doc.resourceState)) {
                    if (JSON.stringify(doc.resourceState[k]) !== JSON.stringify(olderDoc.resourceState?.[k])) changedKeys.push(k)
                  }
                  if (doc.resourceState.properties && olderDoc.resourceState?.properties) {
                    for (const k of Object.keys(doc.resourceState.properties)) {
                      if (JSON.stringify(doc.resourceState.properties[k]) !== JSON.stringify(olderDoc.resourceState.properties?.[k])) changedKeys.push(k)
                    }
                  }
                  diffKeys = changedKeys.filter(k => !['id','name','type','location','etag','_childConfig','provisioningState'].includes(k)).join(', ')
                }
              }
              if (!diffKeys) diffKeys = event.snapshotLabel
            }
            if (!diffKeys) diffKeys = event.snapshotLabel

            if (aiEndpoint && aiKey) {
              const resp = await fetch(aiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'api-key': aiKey },
                body: JSON.stringify({ messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: diffKeys }], max_tokens: 5, temperature: 0.2 }),
              })
              if (resp.ok) {
                const data = await resp.json()
                const cat = (data.choices?.[0]?.message?.content?.trim() || '').split(/[,\s]/)[0]
                const finalCat = valid.includes(cat) ? cat : 'Configuration'
                event.changedFields = finalCat
                genomeTable.upsertEntity({ partitionKey: event._partitionKey, rowKey: event._rowKey, changedFields: finalCat }, 'Merge').catch(() => {})
              }
              // Rate limit: wait 1.1s between calls
              await new Promise(r => setTimeout(r, 1100))
            }
          } catch { /* non-fatal */ }
        }
      })
    }

    // Expand rolledBack/promoted as separate events
    const allEvents = []
    for (const e of events) {
      allEvents.push(e)
      if (e.rolledBackAt) allEvents.push({ ...e, eventType: 'rolledBack', eventAt: e.rolledBackAt })
      if (e.promotedAt) allEvents.push({ ...e, eventType: 'promoted', eventAt: e.promotedAt })
    }
    allEvents.sort((a, b) => new Date(b.eventAt) - new Date(a.eventAt))
    res.json(allEvents)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET /api/genome/history — returns the full activity history for a resource's genomes
// Includes: snapshots created, snapshots deleted (tracked via deletedAt), rollbacks, and baseline promotions
// Used by the Genome History tab on GenomePage
router.get('/genome/history', async (req, res) => {
  console.log('[GET /genome/history] starts')
  const { subscriptionId, resourceId } = req.query
  if (!subscriptionId || !resourceId) {
    console.log('[GET /genome/history] ends — missing required params')
    return res.status(400).json({ error: 'subscriptionId and resourceId required' })
  }
  try {
    const genomeTable = getGenomeIndexTable()
    // Filter by partition only — resourceId comparison is case-insensitive (ARM IDs have inconsistent casing)
    const filter = `PartitionKey eq '${subscriptionId}'`
    const historyEvents = []
    const resourceIdLower = resourceId.toLowerCase()

    for await (const entity of genomeTable.listEntities({ queryOptions: { filter } })) {
      if (entity.resourceId?.toLowerCase() !== resourceIdLower) continue
      const snapshotLabel = entity.label || 'snapshot'
      const blobKey       = entity.blobKey

      // Event: snapshot created
      historyEvents.push({
        eventType:  'created',
        eventAt:    entity.savedAt,
        blobKey,
        snapshotLabel,
        snapshotType: entity.snapshotType || '',
        caller: entity.caller || '',
        changedFields: entity.changedFields || '',
        isCurrentBaseline: entity.isCurrentBaseline || false,
      })

      // Event: rolled back to this snapshot
      if (entity.rolledBackAt) {
        historyEvents.push({
          eventType:  'rolledBack',
          eventAt:    entity.rolledBackAt,
          blobKey,
          snapshotLabel,
          caller: entity.caller || '',
          isCurrentBaseline: entity.isCurrentBaseline || false,
        })
      }

      // Event: promoted to baseline
      if (entity.promotedAt) {
        historyEvents.push({
          eventType:  'promoted',
          eventAt:    entity.promotedAt,
          blobKey,
          snapshotLabel,
          caller: entity.caller || '',
          isCurrentBaseline: entity.isCurrentBaseline || false,
        })
      }

      // Event: deleted (tracked via deletedAt field set on soft-delete)
      if (entity.deletedAt) {
        historyEvents.push({
          eventType:  'deleted',
          eventAt:    entity.deletedAt,
          blobKey,
          snapshotLabel,
          isCurrentBaseline: false,
        })
      }
    }

    // Sort all events newest first
    historyEvents.sort((a, b) => new Date(b.eventAt) - new Date(a.eventAt))
    res.json(historyEvents)
    console.log('[GET /genome/history] ends — found:', historyEvents.length, 'events')
  } catch (routeError) { res.status(500).json({ error: routeError.message }) }
})

// POST /api/genome/delete
router.post('/genome/delete', async (req, res) => {
  const { subscriptionId, blobKey } = req.body
  if (!subscriptionId || !blobKey) return res.status(400).json({ error: 'subscriptionId and blobKey required' })
  try {
    // Record deletedAt on the Table entity before removing the blob
    // This preserves the deletion event in genome history
    await updateGenomeFlag(subscriptionId, blobKey, blobKey, 'deletedAt', new Date().toISOString()).catch(() => {})
    await deleteGenomeSnapshot(subscriptionId, blobKey)
    res.json({ deleted: true, blobKey })
  } catch (routeError) { res.status(500).json({ error: routeError.message }) }
})

module.exports = router