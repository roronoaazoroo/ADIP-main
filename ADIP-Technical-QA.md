# ADIP — 50 Technical Q&A with Flow Diagrams

---

## ARM Config & Frontend Display

**Q1. How does the live ARM config appear in the JSON tree viewer?**
```
User clicks Submit
→ DriftScanner.jsx: fetchResourceConfiguration(subscriptionId, rgId, resourceId)
→ GET /api/configuration
→ configuration.js: getResourceConfigForRoute()
→ azureResourceService.js: getResourceConfig()
→ armClient.resources.get(rg, provider, '', type, name, apiVersion)
→ Returns JSON object
→ setConfigData(cfg)
→ <JsonTree data={configData} />
→ renderNode() recursively renders each key/value
```

**Q2. How does the API version get resolved for an ARM resource?**
```
getApiVersion(subscriptionId, provider, type)
→ Check API_VERSION_MAP[type] → found? return it
→ Check providerApiVersionCache[provider/type] → found? return it
→ armClient.providers.get(provider)
→ Find matching resourceType
→ Pick first stable (non-preview) version
→ Cache it → return it
→ Fallback: '2021-04-01'
```

**Q3. How are child resources (blobServices, fileServices) fetched for a storage account?**
```
getResourceConfig() detects type = 'storageaccounts'
→ Looks up CHILD_RESOURCES['storageaccounts']
→ [blobServices/default, fileServices/default, queueServices/default, tableServices/default]
→ Promise.allSettled(children.map(c => armClient.resources.get(...)))
→ Attaches results to resource._childConfig
→ Also calls fetchStorageChildItems() for actual containers/shares/queues/tables
→ Uses DefaultAzureCredential bearer token + node-fetch to call ARM REST directly
```

**Q4. How are blob containers listed inside a storage account?**
```
fetchStorageChildItems(subscriptionId, rgName, storageAccountName)
→ credential.getToken('https://management.azure.com/.default')
→ fetch GET .../storageAccounts/{name}/blobServices/default/containers?api-version=2023-01-01
→ fetch GET .../fileServices/default/shares
→ fetch GET .../queueServices/default/queues
→ fetch GET .../tableServices/default/tables
→ All 4 in parallel via Promise.all
→ Returns { blobContainers[], fileShares[], storageQueues[], storageTables[] }
→ Merged into resource._childConfig
```

---

## Table Storage Indexing

**Q5. How does Table Storage indexing work for changesIndex?**
```
ARM event arrives → recordChange Function OR queuePoller
→ saveChangeRecord(record)
→ writeBlob('all-changes', timestampKey, record)   ← full JSON blob
→ tableClient('changesIndex').upsertEntity({        ← lightweight index row
    partitionKey: subscriptionId,
    rowKey: base64url(blobKey),
    resourceId, resourceGroup, caller, detectedAt, changeType, ...
  })
```
Index row has all fields the dashboard needs — no blob read required for the table.

**Q6. Where is the changesIndex Table query function?**
```
blobService.js → getRecentChanges()
→ tableClient('changesIndex').listEntities({ filter: "PartitionKey eq '...' and detectedAt ge '...'" })
→ For each entity: push index fields directly (no blob read)
→ Sort by detectedAt descending
→ Cache result for 10 seconds in _recentChangesCache Map
```

**Q7. Why is PartitionKey = subscriptionId?**
```
Table Storage queries are fast when filtering by PartitionKey
All changes for one subscription = one partition = one server node
OData filter on PartitionKey = O(matching rows), not O(all rows)
```

**Q8. What is the RowKey in changesIndex?**
```
RowKey = base64url(blobKey).slice(0, 512)
blobKey = "2026-04-21T10-30-45Z_base64url(resourceId).json"
base64url encoding makes it safe for Table Storage (no / or special chars)
```

---

## Drift Detection Pipeline

**Q9. What triggers drift detection end-to-end?**
```
User changes resource in Azure Portal/CLI
→ ARM fires ResourceWriteSuccess event
→ Event Grid fans out to:
   [1] Storage Queue → queuePoller → Socket.IO (live feed)
   [2] eventGridRouter Function → filters noise → detectDrift Function
→ detectDrift: fetch live config, diff vs baseline, save drift record, notify Express
```

**Q10. How does detectDrift know what baseline to compare against?**
```
detectDrift receives { resourceId, subscriptionId }
→ blobKey(resourceId) = base64url(resourceId) + '.json'
→ readBlob(baselinesContainer, blobKey)
→ Returns { resourceState: {...} } or null
→ If null: no baseline → skip (no drift record written)
→ If found: strip() both configs → diffObjects(baseline, live)
```

**Q11. How does the diff work?**
```
diffObjects(baselineState, liveState)
→ Uses deep-diff library (kind: N=added, D=deleted, E=edited, A=array)
→ Returns array of { path, type, oldValue, newValue }
→ classifySeverity(changes):
   - any 'removed' → critical
   - 3+ tag changes → critical
   - CRITICAL_PATHS match → high
   - >5 changes → medium
   - else → low
```

**Q12. What fields are stripped before diffing?**
```
VOLATILE = ['etag', 'changedTime', 'createdTime', 'provisioningState',
            'lastModifiedAt', 'systemData', '_ts', '_etag']
strip(obj) recursively removes these from both configs
Without stripping: every resource shows as "drifted" because etag changes on every read
```

---

## Real-time Feed (Socket.IO)

**Q13. How does a change appear in the Live Activity Feed without page refresh?**
```
ARM change → Event Grid → Storage Queue
→ queuePoller (every 5s): receiveMessages()
→ parseMessage() → enrichWithDiff() → saveChangeRecord()
→ global.io.to(subscriptionId:resourceGroup).emit('resourceChange', event)
→ Browser: useDriftSocket.js socket.on('resourceChange', handler)
→ addEvent(event) → setLiveEventList([...prev, event])
→ React re-renders LiveActivityFeed
```

**Q14. How does the browser join the correct Socket.IO room?**
```
User selects subscription + RG + resource → clicks Submit
→ useDriftSocket.js: socket.emit('subscribe', { subscriptionId, resourceGroup, resourceId })
→ app.js io.on('connection'): socket.join(subscriptionId:resourceGroup)
→ Also joins subscriptionId:resourceGroup:resourceName if specific resource selected
→ queuePoller emits to all 3 rooms → browser only receives events for its scope
```

**Q15. Why is isSubmittedRef a useRef instead of useState?**
```
Socket.IO handler is created once (closure)
If isSubmitted were useState, handler would always see initial value (false)
useRef is mutable — handler reads isSubmittedRef.current which always has current value
useEffect keeps ref in sync: isSubmittedRef.current = isSubmitted
```

**Q16. How does deduplication work in the queue poller?**
```
isDuplicate(event):
→ bucket = Math.floor(eventTime / 100)  ← 100ms time window
→ key = resourceId:operationName:bucket
→ If key in _dedup Map → duplicate, skip
→ Else add to Map, prune entries >60s old
Prevents same event processed twice if Express restarts mid-poll
```

---

## Baseline & Genome

**Q17. How is a golden baseline saved?**
```
User clicks "Seed Baseline" or "Set as Baseline" in Genome
→ POST /api/seed-baseline or POST /api/genome/promote
→ getResourceConfig() fetches current live ARM config
→ saveBaseline(subscriptionId, rgId, resourceId, liveConfig)
→ blobKey = base64url(resourceId) + '.json'
→ writeBlob('baselines', blobKey, { resourceState: liveConfig, promotedAt: now })
→ Fixed key — always overwrites previous baseline for that resource
```

**Q18. How does the Genome snapshot differ from a baseline?**
```
Baseline: fixed key (base64url(resourceId).json) — only one per resource, always overwritten
Genome:   timestamped key (ISO-ts_base64url(resourceId).json) — unlimited history
Baseline = "what it should be"
Genome   = "what it was at every point in time"
```

**Q19. How does rollback work?**
```
User clicks Rollback on a snapshot
→ POST /api/genome/rollback { subscriptionId, rgId, resourceId, blobKey }
→ getGenomeSnapshot(blobKey) → reads snapshot blob
→ strip(snapshot.resourceState) → removes volatile fields
→ armClient.resources.beginCreateOrUpdateAndWait(rg, provider, '', type, name, apiVersion, strippedState)
→ ARM PUT reverts the resource
→ genomeIndex Table: set rolledBackAt=now on this snapshot, null on all others
→ loadSnapshots() refreshes → Rollback button disables
```

**Q20. How does "Set as Baseline" know which snapshot is currently active?**
```
After promote: genome.js iterates genomeIndex Table entities for that resourceId
→ Sets isCurrentBaseline=true on promoted snapshot
→ Sets isCurrentBaseline=false on all others
→ listGenomeSnapshots() passes isCurrentBaseline through to frontend
→ GenomePage: button disabled when snapshot.isCurrentBaseline === true
```

---

## Remediation

**Q21. What happens when you click "Apply Fix Now" (low severity)?**
```
ComparisonPage: remediateToBaseline(subscriptionId, rgId, resourceId)
→ POST /api/remediate
→ getBaseline() → strip() → getResourceConfig() → strip()
→ diffObjects(live, baseline) → classifySeverity()
→ sendDriftAlertEmail() (no-op for low severity)
→ armClient.resources.beginCreateOrUpdateAndWait(rg, provider, '', type, name, apiVersion, { ...baselineState, location })
→ If NSG: reconcile subnet associations
→ If storage account: reconcile containers/shares/queues/tables
```

**Q22. What happens when you click "Request Approval" (medium/high/critical)?**
```
ComparisonPage: requestRemediation(payload)
→ POST /api/remediate-request
→ sendDriftAlertEmail({ severity, resourceId, differences, ... })
→ alertService.js: severity is high/critical → fetch DRIFT_ALERT_ROUTER_URL
→ driftAlertRouter Function: checks severity → calls sendAlert Function
→ sendAlert: builds HTML email with diff table + Approve/Reject links
→ ACS EmailClient.beginSend() → email delivered
→ Admin clicks Approve link → GET /api/remediate-decision?action=approve&token=...
→ Decodes token → ARM PUT → resource reverted
```

**Q23. What is the approval token?**
```
token = Buffer.from(JSON.stringify({ resourceId, resourceGroup, subscriptionId, detectedAt })).toString('base64url')
Embedded in email Approve/Reject URLs
remediateDecision.js decodes it: JSON.parse(Buffer.from(token, 'base64url'))
Security risk: unsigned — anyone with the link can approve/reject
Production fix: sign with HMAC-SHA256
```

**Q24. Why does ARM PUT fail with "Cannot parse the request" for VMs and NSGs?**
```
Baseline saved with read-only fields ARM rejects on PUT:
VM:  instanceView, powerState, statuses, vmId, timeCreated
NSG: defaultSecurityRules (system rules), resourceGuid, subnets (back-references), networkInterfaces
Fix: READONLY_PROPERTIES list in remediate.js + remediateDecision.js
strip() removes both VOLATILE and READONLY fields before PUT
```

---

## AI Features

**Q25. How does AI drift explanation work?**
```
ComparisonPage: after diff computed, if changes.length > 0
→ fetchAiExplanation({ resourceId, differences, severity })
→ POST /api/ai/explain
→ ai.js: forwardPostToAiFunction('explain', body)
→ aiOperations Function: explainDrift(driftRecord)
→ callAzureOpenAI(systemPrompt, changesText)
→ GPT-4o returns plain-English explanation
→ setAiDriftExplanation(result) → renders in blue AI card
```

**Q26. Can AI reduce severity?**
```
No. reclassifySeverity() in compare.js:
severityOrder = ['none','low','medium','high','critical']
if (indexOf(aiSeverity) > indexOf(currentSeverity)) → escalate
else → keep current
AI can only escalate, never reduce
```

**Q27. How does anomaly detection work?**
```
After Submit on DriftScanner:
→ fetchAnomalies(subscriptionId)
→ GET /api/ai/anomalies
→ aiOperations Function: getDriftRecordsForAnomaly() → last 50 from driftIndex Table
→ Build compact summary: [{ resource, rg, severity, changes, time, actor }]
→ callAzureOpenAI(anomalyPrompt, JSON.stringify(summary))
→ GPT-4o returns JSON array of anomalies [{ title, description, severity, affectedResource }]
→ setAnomalies(result) → renders anomaly cards below stats bar
```

---

## Email & Alerts

**Q28. Where is the single email function and what does it do?**
```
alertService.js → sendDriftAlertEmail(payload)
if severity NOT in ['critical','high'] → return (no email)
if DRIFT_ALERT_ROUTER_URL not set → return
else → fetch(DRIFT_ALERT_ROUTER_URL, POST, payload)
→ driftAlertRouter Function → sendAlert Function → ACS email
Called from: app.js (x2), remediate.js, remediateRequest.js
```

**Q29. What are the 3 layers that block low/medium emails?**
```
Layer 1: alertService.js — ['critical','high'].includes(severity) check before fetch
Layer 2: driftAlertRouter Function — ALERT_SEVERITY_LEVELS = ['critical','high']
Layer 3: sendAlert Function — ALERT_SEVERITY_LEVELS = ['critical','high']
All 3 must pass for an email to be sent
```

**Q30. How does the after-hours alert work?**
```
app.js: startAfterHoursAlertCheck() → setInterval every 60s
if (now.getHours() < 19) return
if (lastFiredDate === today) return
→ getDriftRecords({ severity: 'critical', limit: 50 })
→ filter to today only
→ for each record: sendDriftAlertEmail({ ...record, afterHoursAlert: true })
→ lastFiredDate = today
Fires once per day after 19:00 if critical drift exists
```

---

## Logic App → Function Migration

**Q31. What did adip-logic-app do and what replaced it?**
```
adip-logic-app (Logic App):
  Event Grid webhook → filter noise → call detectDrift Function

Replaced by: eventGridRouter Function
  HTTP trigger (anonymous) → same noise filters → call detectDrift
  Also handles Event Grid validation handshake automatically
```

**Q32. What did adip-drift-alert do and what replaced it?**
```
adip-drift-alert (Logic App):
  HTTP POST from Express → check severity (critical/high) → call sendAlert Function

Replaced by: driftAlertRouter Function
  HTTP trigger (anonymous) → check severity → call sendAlert Function
  Express now calls DRIFT_ALERT_ROUTER_URL instead of ALERT_LOGIC_APP_URL
```

**Q33. How was the Event Grid subscription updated?**
```
az eventgrid event-subscription update
  --name adip-sub-logic
  --source-resource-id /subscriptions/.../
  --endpoint https://adip-func-001.azurewebsites.net/api/eventGridRouter
  --endpoint-type webhook
Now Event Grid calls eventGridRouter Function directly instead of Logic App
```

---

## Performance

**Q34. Why is getRecentChanges fast now?**
```
Before: query changesIndex Table → for each entity: readBlob() → 200 sequential HTTP calls
After:  query changesIndex Table → return entity fields directly → 0 blob reads
Dashboard table only needs: resourceId, caller, operationName, changeType, detectedAt
All stored in Table index row — blob only needed for full diff detail
```

**Q35. How does the 10-second cache work?**
```
_recentChangesCache = new Map()  // key: filter params string → { data, expiresAt }
On each request:
→ Build cacheKey from all filter params
→ If cached and expiresAt > now → return cached data immediately
→ Else: query Table, sort, store in cache with expiresAt = now + 10000ms
→ Prune expired entries
Dashboard auto-refreshes every 30s → only 1 Table query per 30s per filter combo
```

---

## Storage & Blobs

**Q36. Why use base64url for blob keys?**
```
ARM resource IDs contain '/' (path separators)
/subscriptions/abc/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/foo
Blob Storage interprets '/' as folder separator
base64url: replaces + → -, / → _, removes = padding
Result: safe flat filename, deterministic, O(1) lookup
```

**Q37. What is the Blob + Table pattern and why?**
```
Blob = full JSON document (cheap storage, slow to query)
Table = lightweight index row (fast OData queries)
Pattern: every blob write → paired Table upsert
Query: Table (fast, filtered) → fetch only needed blobs
Without Table: listBlobsFlat() = O(n) scan of entire container
With Table: O(matching rows) filtered by PartitionKey + OData
```

**Q38. How does liveStateCache survive Express restarts?**
```
liveStateCache = Proxy over _mem object
set trap: writes to _mem (sync) + cacheSet() (async Table upsert)
get trap: reads from _mem
On restart: cacheGet() checks _mem first, then queries liveStateCache Table
First event after restart: has previous state from Table → shows proper diff
Without persistence: first event after restart shows "N/A" for old values
```

---

## Authentication & Access

**Q39. How does ADIP access Azure resources?**
```
DefaultAzureCredential (from @azure/identity)
Locally: resolves to Azure CLI token (az login)
In cloud: resolves to Managed Identity
Used for: ARM SDK calls, Policy Insights, Storage (via connection string separately)
No hardcoded credentials — credential chain tries multiple sources
```

**Q40. Why does ADIP only work on the machine where Express runs?**
```
VITE_API_BASE_URL=http://172.10.1.109:3001/api (hardcoded local IP)
Vite bakes this URL into the JS bundle at build time
Other devices' browsers try to connect to 172.10.1.109:3001
Works if: same network + Windows Firewall allows port 3001
Fix: deploy Express to Azure App Service → use App Service URL
```

---

## Frontend State

**Q41. How does state persist when navigating between pages?**
```
DashboardContext.jsx: usePersisted(key, default)
→ useState initialized from sessionStorage.getItem(key)
→ setter writes to both React state AND sessionStorage
Keys: adip.sub, adip.rg, adip.resource, adip.rgs, adip.resources
Navigate DriftScanner → ComparisonPage → back: selections preserved
Tab close: sessionStorage cleared (not localStorage)
```

**Q42. Why are there pendingFilters AND appliedFilters in DashboardHome?**
```
pendingFilters: updates on every checkbox click (no API call)
appliedFilters: only updates when user clicks Apply button
load() uses appliedFilters → API only called on Apply, not on every checkbox
Prevents: 10 API calls while user is selecting multiple filters
```

---

## NSG & Network

**Q43. How does NSG subnet re-association work on remediation?**
```
After ARM PUT on NSG:
baselineSubnetIds = baseline.properties.subnets[].id (lowercased)
liveSubnetIds     = current live NSG.properties.subnets[].id

subnetsToDisassociate = liveSubnetIds NOT in baseline
→ GET subnet → delete subnet.properties.networkSecurityGroup → PUT subnet

subnetsToReassociate = baselineSubnetIds NOT in live
→ GET subnet → set subnet.properties.networkSecurityGroup = { id: nsgResourceId } → PUT subnet
```

**Q44. Why can't you set subnets directly on the NSG PUT body?**
```
NSG.properties.subnets = back-references (ARM populates automatically)
You cannot set them via PUT on the NSG
You must PUT on the subnet and set subnet.properties.networkSecurityGroup
ARM rejects NSG PUT with subnets in body → added 'subnets' to READONLY_PROPERTIES list
```

---

## Miscellaneous

**Q45. How does the bar chart get its data?**
```
BarChart component (self-fetching):
→ useState: mode ('24h'/'7d'/'30d'), data, loading
→ useEffect on [subscriptionId, mode]: fetchChartStats(subscriptionId, mode)
→ GET /api/stats/chart?mode=24h
→ drift.js: query changesIndex Table with detectedAt filter
→ Bucket events by hour (24h) or day (7d/30d)
→ Returns { buckets: [{ label, count, key }] }
→ Renders bars proportional to count/max
```

**Q46. How does the donut chart get its data?**
```
DashboardHome: fetchStatsToday(subscriptionId)
→ GET /api/stats/today
→ drift.js: query changesIndex Table since midnight
→ Count unique resourceIds → totalDrifted
→ DonutChart: changed=totalDrifted, total=totalResourceCount
→ pct = changed/total * 100
→ SVG strokeDasharray = pct, 100
```

**Q47. How does clicking a table row navigate to ComparisonPage?**
```
DashboardHome table row onClick → navigateToComparison(changeEvent)
→ fetchResourceConfiguration(subscriptionId, resourceGroup, resourceId)
→ navigate('/comparison', { state: { subscriptionId, resourceGroupId, resourceId, liveState } })
→ ComparisonPage reads location.state
→ Fetches baseline → diffs against passed liveState
→ Shows field-level diff
```

**Q48. How does the JSON tree expand/collapse work?**
```
JsonTree.jsx: expandedNodes = Set of dot-notation paths
toggleNode(path): add/remove from Set → re-render
expandAll(): DFS collect all paths → setExpandedNodes(allPaths)
collapseAll(): setExpandedNodes(new Set())
useImperativeHandle exposes expandAll/collapseAll on forwarded ref
Parent calls: jsonTreeRef.current.expandAll()
```

**Q49. How does the genome page know a rollback happened?**
```
After rollback ARM PUT succeeds:
→ genome.js: iterate genomeIndex Table for subscriptionId + resourceId
→ upsertEntity: rolledBackAt = now on rolled-back snapshot, null on others
→ listGenomeSnapshots() passes rolledBackAt through to frontend
→ GenomePage: Rollback button disabled when snapshot.rolledBackAt is truthy
→ loadSnapshots() called after rollback → button disables immediately
```

**Q50. How does the queue poller handle the first diff after Express restart?**
```
Problem: liveStateCache is empty after restart → no previous state → no diff
Solution 1 (automatic): queuePoller.enrichWithDiff()
  → cacheGet(resourceId) → null (empty after restart)
  → tries getBaseline() as fallback previous state
  → if baseline exists: diffs against it
  → cacheSet(resourceId, currentLive) for next event
Solution 2 (manual): DriftScanner Submit → cacheState() seeds the cache
  → POST /api/cache-state → writes to liveStateCache Table
  → Next event has previous state → shows proper old→new diff
```

---

*ADIP Technical Q&A — 50 questions | Generated 2026-04-24*
