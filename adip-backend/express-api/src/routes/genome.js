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




// GET /api/genome/cto-summary?subscriptionId=&resourceId= — Executive summary for CTO view
router.get('/genome/cto-summary', async (req, res) => {
  const { subscriptionId, resourceId } = req.query
  if (!subscriptionId || !resourceId) return res.status(400).json({ error: 'subscriptionId and resourceId required' })

  try {
    const fetch = require('node-fetch')
    const { listGenomeSnapshots, getSnapshotConfig, getGenomeSnapshot } = require('../services/blobService')

    const isRgLevel = !resourceId.startsWith('/subscriptions/')
    let snapshots
    if (isRgLevel) {
      const all = await listGenomeSnapshots(subscriptionId, null, 200)
      snapshots = all.filter(s => s.resourceId?.toLowerCase().includes('/resourcegroups/' + resourceId.toLowerCase() + '/')).slice(0, 20)
    } else {
      snapshots = await listGenomeSnapshots(subscriptionId, resourceId, 20)
    }

    if (!snapshots.length) return res.json({ healthScore: 0, summary: 'No configuration history available.', costTrend: [], risks: [], stability: {} })

    // Extract config data from snapshots
    const configs = []
    for (const snap of snapshots.slice(0, 10)) {
      const doc = snap.resourceState || (await getSnapshotConfig(snap._blobKey).catch(() => null))?.resourceState || (await getGenomeSnapshot(snap._blobKey).catch(() => null))?.resourceState
      if (!doc) continue
      const props = doc.properties || {}
      configs.push({
        savedAt: snap.savedAt,
        sku: doc.sku?.name || '',
        httpsOnly: props.supportsHttpsTrafficOnly ?? false,
        tls: props.minimumTlsVersion || '',
        publicAccess: props.allowBlobPublicAccess ?? true,
        networkDefault: props.networkAcls?.defaultAction || 'Allow',
        encryption: props.encryption?.keySource || '',
        identity: doc.identity?.type || 'None',
      })
    }

    // Compute health score (0-100)
    const latest = configs[0] || {}
    let healthScore = 50
    if (latest.httpsOnly === true) healthScore += 10
    if (latest.tls === 'TLS1_2') healthScore += 10
    if (latest.publicAccess === false) healthScore += 10
    if (latest.networkDefault === 'Deny') healthScore += 10
    if (latest.encryption?.includes('Keyvault')) healthScore += 5
    if (latest.identity !== 'None') healthScore += 5
    healthScore = Math.min(healthScore, 100)

    // Cost trend
    const skuCost = { 'standard_lrs': 0.018, 'standard_grs': 0.036, 'standard_zrs': 0.023, 'standard_ragrs': 0.046, 'premium_lrs': 0.15 }
    const costTrend = configs.map(c => ({ date: c.savedAt?.slice(0, 10), costPerGB: skuCost[(c.sku || '').toLowerCase()] || 0 }))

    // Stability
    const totalChanges = snapshots.length
    const daySpan = Math.max(1, Math.round((new Date(snapshots[0]?.savedAt) - new Date(snapshots[snapshots.length - 1]?.savedAt)) / 86400000))
    const changesPerDay = (totalChanges / daySpan).toFixed(1)

    // Risks
    const risks = []
    if (latest.httpsOnly !== true) risks.push({ level: 'critical', message: 'HTTPS enforcement is disabled' })
    if (latest.publicAccess !== false) risks.push({ level: 'high', message: 'Public blob access is enabled' })
    if (latest.networkDefault !== 'Deny') risks.push({ level: 'high', message: 'Network default action is Allow (not restricted)' })
    if (latest.tls !== 'TLS1_2') risks.push({ level: 'medium', message: 'TLS version is below 1.2' })

    // AI executive summary
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '')
    const apiKey = process.env.AZURE_OPENAI_KEY
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'adip-gpt'
    let aiSummary = ''
    if (endpoint && apiKey) {
      try {
        const aiResp = await fetch(`${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${process.env.AZURE_OPENAI_API_VERSION || '2024-10-21'}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
          body: JSON.stringify({
            messages: [
              { role: 'system', content: 'You are a CTO advisor. Give a 2-3 sentence executive summary of this Azure resource configuration health. Mention cost, security posture, and stability. Be direct and actionable. No technical jargon.' },
              { role: 'user', content: JSON.stringify({ healthScore, risks, changesPerDay, latestConfig: latest, totalSnapshots: totalChanges }) },
            ],
            max_tokens: 100, temperature: 0.3,
          }),
        })
        if (aiResp.ok) {
          const aiData = await aiResp.json()
          aiSummary = aiData.choices?.[0]?.message?.content?.trim() || ''
        }
      } catch { /* non-fatal */ }
    }

    res.json({ healthScore, summary: aiSummary, costTrend, risks, stability: { totalChanges, daySpan, changesPerDay }, latestConfig: latest })
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

    // Get last 20 snapshots — RG-level gets all resources in the group
    const isRgLevel = !resourceId.startsWith('/subscriptions/')
    let snapshots
    if (isRgLevel) {
      const all = await listGenomeSnapshots(subscriptionId, null, 200)
      snapshots = all.filter(s => s.resourceId?.toLowerCase().includes('/resourcegroups/' + resourceId.toLowerCase() + '/')).slice(0, 20)
    } else {
      snapshots = await listGenomeSnapshots(subscriptionId, resourceId, 20)
    }
    if (!snapshots.length) return res.json([])

    // Extract summary from each + calculate duration between snapshots
    const summaries = []
    for (let i = 0; i < snapshots.length; i++) {
      const snap = snapshots[i]
      const doc = snap.resourceState || (await getSnapshotConfig(snap._blobKey).catch(() => null))?.resourceState || (await getGenomeSnapshot(snap._blobKey).catch(() => null))?.resourceState
      if (!doc) continue
      const props = doc.properties || {}
      // Duration: how long this config lasted (hours until next snapshot)
      const nextSnap = snapshots[i + 1]
      const durationHours = nextSnap ? Math.round((new Date(snap.savedAt) - new Date(nextSnap.savedAt)) / 3600000) : 0
      // Cost estimate based on SKU
      const skuCostMap = { 'standard_lrs': 0.018, 'standard_grs': 0.036, 'standard_zrs': 0.023, 'standard_ragrs': 0.046, 'premium_lrs': 0.15, 'premium_zrs': 0.18 }
      const estimatedCostPerGB = skuCostMap[(doc.sku?.name || '').toLowerCase()] || 0
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
        durationHours,
        estimatedCostPerGB,
      })
    }

    if (!summaries.length) return res.json([])

    const systemPrompt = `You are a senior Azure cloud architect performing a configuration audit. You are given multiple snapshots of the same Azure resource captured at different points in time. Each snapshot represents the full configuration state at that moment.

Your task: identify the TOP configuration for each of these 3 categories by comparing ALL snapshots against Azure Well-Architected Framework best practices.

CATEGORIES AND SCORING CRITERIA:

1. cost_optimized — Pick the config with the LOWEST monthly cost:
   - Prefer Standard_LRS over GRS/ZRS/RAGRS (cheaper replication)
   - Prefer Hot tier only if data is frequently accessed, otherwise Cool/Archive saves money
   - Fewer premium features = lower cost
   - No unnecessary CMK encryption (adds Key Vault cost)
   - SystemAssigned identity is free, no cost impact

2. most_secure — Pick the config with the STRONGEST security posture:
   - supportsHttpsTrafficOnly MUST be true
   - minimumTlsVersion MUST be TLS1_2
   - allowBlobPublicAccess MUST be false
   - encryption with Microsoft.Keyvault (CMK) is stronger than Microsoft.Storage
   - networkAcls.defaultAction = Deny is more secure than Allow
   - More ipRules/vnRules = more restricted = more secure
   - SystemAssigned identity = better than None

3. best_networking — Pick the config with the TIGHTEST network isolation:
   - networkAcls_defaultAction = Deny is mandatory
   - Higher networkAcls_vnRules count = better (VNet-restricted access)
   - Higher networkAcls_ipRules count = more controlled access
   - allowBlobPublicAccess = false required
   - Private endpoint access preferred over public

ADDITIONAL DATA PROVIDED:
- durationHours: how long this config lasted before being changed. Higher = more stable/trusted.
- estimatedCostPerGB: actual Azure price per GB/month for the SKU. Lower = cheaper.

IMPORTANT: Prefer configs that lasted longer (higher durationHours) as they were validated in production. Different snapshots may win different categories. The cheapest config is rarely the most secure.

Respond ONLY with valid JSON array (no markdown, no explanation):
[{"category":"cost_optimized","index":N,"reason":"one specific sentence explaining why this config wins"},{"category":"most_secure","index":N,"reason":"one specific sentence citing the security settings"},{"category":"best_networking","index":N,"reason":"one specific sentence citing network rules"}]`

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
    const isRgLevel = !resourceId.startsWith('/subscriptions/')
    const categories = ['Network', 'Security', 'Tags', 'SKU', 'Identity', 'Configuration']
    const events = []
    const uncategorized = []

    for await (const entity of genomeTable.listEntities({ queryOptions: { filter } })) {
      if (isRgLevel) {
        if (!entity.resourceId?.toLowerCase().includes('/resourcegroups/' + resourceIdLower + '/')) continue
      } else {
        if (entity.resourceId?.toLowerCase() !== resourceIdLower) continue
      }
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
    const isRgLevel = !resourceId.startsWith('/subscriptions/')

    for await (const entity of genomeTable.listEntities({ queryOptions: { filter } })) {
      if (isRgLevel) {
        if (!entity.resourceId?.toLowerCase().includes('/resourcegroups/' + resourceIdLower + '/')) continue
      } else {
        if (entity.resourceId?.toLowerCase() !== resourceIdLower) continue
      }
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