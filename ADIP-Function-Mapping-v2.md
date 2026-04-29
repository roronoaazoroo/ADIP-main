# ADIP — Complete Technical Architecture & Traceability Document (v2)
**Ref:** ADIP-ARCH-2026-002 | **Version:** 2.0 | **Updated:** 2026-04-20

> **What's new in v2:** Added complete Azure Resource mapping (Phase 0), missing API endpoints (`/stats/today`, `/stats/chart`, `/changes/recent`, `/changes/count`), corrected dead-code flags, and added the `monitorResources` timer function flow.

---

## Phase 0: Azure Resource Inventory (NEW)

This phase was entirely absent from v1. Every Azure resource used by ADIP, its purpose, and how the code connects to it.

### 0.1 Provisioned Azure Resources

| Resource Name | Type | Resource Group | Location | Purpose in ADIP |
|---|---|---|---|---|
| `adipstore001` | Storage Account | rg-adip | West US 2 | Blob containers + Storage Queue + Table Storage |
| `adip-func-001` | Function App | rg-adip | West US 2 | Hosts all 7 Azure Functions |
| `WestUS2LinuxDynamicPlan` | App Service Plan | rg-adip | West US 2 | Consumption plan for Function App |
| `adip-eg-topic` | Event Grid Topic | rg-adip | West US 2 | Receives ARM ResourceWriteSuccess/DeleteSuccess events |
| `adip-logic-app` | Logic App | rg-adip | West US 2 | Routes Event Grid → detectDrift Function (with noise filter) |
| `adip-drift-alert` | Logic App | rg-adip | West US 2 | Routes severity alerts → sendAlert Function → ACS email |
| `adip-comms` | Communication Services | rg-adip | Global | Parent ACS resource |
| `adip-email` | Email Communication Service | rg-adip | Global | Email sending domain |
| `adip-email/AzureManagedDomain` | Email Domain | rg-adip | Global | Managed sender domain for DoNotReply@ address |
| `adip-openai` | Azure OpenAI | rg-adip | East US | GPT-4o deployment `adip-gpt` for AI features |

### 0.2 Storage Account — Blob Containers

All containers live in `adipstore001`. Created automatically on first write by `blobService.js`.

| Container | Key Scheme | Written By | Read By |
|---|---|---|---|
| `baselines` | `base64url(resourceId).json` | `saveBaseline()`, genome promote, remediation reject | `getBaseline()`, ComparisonPage, detectDrift Function |
| `drift-records` | `ISO-ts_base64url(resourceId).json` | `saveDriftRecord()` (Express + detectDrift Function) | `getDriftRecords()`, `getDriftHistory()`, GenomePage |
| `baseline-genome` | `ISO-ts_base64url(resourceId).json` | `saveGenomeSnapshot()` (queue poller auto + manual) | `listGenomeSnapshots()`, GenomePage |
| `all-changes` | `ISO-ts_base64url(resourceId).json` | `recordChange` Azure Function, `saveChangeRecord()` | `getRecentChanges()`, DashboardHome |

### 0.3 Storage Account — Table Storage Tables

| Table | PartitionKey | RowKey | Written By | Used For |
|---|---|---|---|---|
| `driftIndex` | subscriptionId | base64url(blobKey) | `saveDriftRecord()` | O(filtered) queries for `/api/drift-events`, `/api/stats/today` |
| `genomeIndex` | subscriptionId | base64url(blobKey) | `saveGenomeSnapshot()` | O(filtered) queries for `/api/genome` |
| `changesIndex` | subscriptionId | base64url(blobKey) | `recordChange` Function, `saveChangeRecord()` | `/api/changes/recent`, `/api/stats/today`, `/api/stats/chart` |
| `liveStateCache` | `state` | base64url(resourceId) | `cacheSet()` in queuePoller.js | Persist previous state across Express restarts for diff |
| `monitorSessions` | subscriptionId | sessionId | `/api/monitor/start`, `/api/monitor/stop` | `monitorResources` Function reads active sessions |

### 0.4 Storage Queue

| Queue Name | Producer | Consumer | Message Format |
|---|---|---|---|
| `resource-changes` | Azure Event Grid (direct subscription) | `queuePoller.js` setInterval (every 5s) | Base64-encoded JSON array of Event Grid schema events |

### 0.5 Azure Function App — All Functions

| Function | Trigger | Env Vars Used | Purpose |
|---|---|---|---|
| `detectDrift` | HTTP (authLevel: function) | `STORAGE_CONNECTION_STRING`, `COMMS_CONNECTION_STRING`, `SENDER_ADDRESS`, `ALERT_RECIPIENT_EMAIL`, `EXPRESS_API_URL` | Fetch live ARM config, diff vs baseline blob, write drift-record, send email, POST to Express |
| `aiOperations` | HTTP (authLevel: function) | `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_KEY`, `AZURE_OPENAI_DEPLOYMENT` | explain, severity, recommend, anomalies via Azure OpenAI |
| `monitorResources` | Timer (every 1 min) | `STORAGE_CONNECTION_STRING`, `EXPRESS_API_URL` | Read active monitorSessions Table, diff each resource vs baseline, save drift record |
| `scanSubscription` | Timer (every 1 hour) | `STORAGE_CONNECTION_STRING`, `AZURE_SUBSCRIPTION_ID` | Full subscription sweep — all RGs × all resources with baselines |
| `recordChange` | HTTP (Event Grid webhook) | `STORAGE_CONNECTION_STRING` | Write every ARM event to `all-changes` blob + `changesIndex` Table |
| `seedBaseline` | HTTP (authLevel: function) | `STORAGE_CONNECTION_STRING` | Fetch live ARM config and save as golden baseline blob |
| `sendAlert` | HTTP (called by adip-drift-alert Logic App) | `COMMS_CONNECTION_STRING`, `SENDER_ADDRESS`, `ALERT_RECIPIENT_EMAIL`, `EXPRESS_PUBLIC_URL` | Build HTML email with diff table + Approve/Reject links, send via ACS |

### 0.6 Event Grid Topic — Subscriptions

| Subscription Name | Endpoint Type | Endpoint | Filter |
|---|---|---|---|
| Storage Queue subscription | Storage Queue | `adipstore001/resource-changes` | EventType: ResourceWriteSuccess, ResourceDeleteSuccess |
| Logic App subscription | Webhook | `adip-logic-app` HTTP trigger | EventType: ResourceWriteSuccess, ResourceDeleteSuccess |

### 0.7 Logic Apps

**adip-logic-app** (Event Grid → detectDrift):
1. Receives HTTP webhook from Event Grid
2. Condition: `status != 'Failed'` AND `operationName` not contains `read`/`list` AND `resourceUri` not contains `/deployments/`
3. If passes → HTTP POST to `adip-func-001/api/detectDrift?code=<FUNCTION_KEY>`

**adip-drift-alert** (Express alert → sendAlert):
1. Receives HTTP POST from Express `remediateRequest.js` via `ALERT_LOGIC_APP_URL`
2. Condition: severity is `critical`, `high`, or `medium`
3. If passes → HTTP POST to `adip-func-001/api/sendAlert?code=<FUNCTION_KEY>`

### 0.8 Azure OpenAI

| Setting | Value |
|---|---|
| Resource | `adip-openai` (East US) |
| Deployment name | `adip-gpt` |
| Model | GPT-4o |
| API version | `2024-10-21` |
| Used by | `aiService.js` (Express proxy), `aiOperations/index.js` (Function App) |
| Temperature | 0.3 (AI analysis), 0.4 (chatbot) |

### 0.9 Azure Communication Services

| Setting | Value |
|---|---|
| Resource | `adip-comms` (Global) |
| Email domain | `adip-email/AzureManagedDomain` |
| Sender address | `DoNotReply@d8515e4e-69a5-4147-a28a-8f41ebdabf18.azurecomm.net` |
| SDK | `@azure/communication-email` v1.1 |
| Used by | `alertService.js` (Express), `sendAlert/index.js` (Function App) |

### 0.10 Authentication & Identity

| Context | Credential | Scope |
|---|---|---|
| Express API (local) | `DefaultAzureCredential` → Azure CLI token | Reader on subscription, Contributor on rg-adip |
| Function App (cloud) | `DefaultAzureCredential` → Managed Identity | Same RBAC as above |
| Storage Account | Connection string (`STORAGE_CONNECTION_STRING`) | Full access via account key |
| ACS Email | Connection string (`COMMS_CONNECTION_STRING`) | Full access via account key |
| Azure OpenAI | API key (`AZURE_OPENAI_KEY`) | Full access |
| Event Grid | Topic key (`EVENTGRID_TOPIC_KEY`) | Publish only |


---

## Phase 1: Tech Stack & Architecture Overview

### Core Technology Inventory

| Layer | Technology | Version | Role |
|---|---|---|---|
| Frontend Framework | React | 18.3.1 | SPA component rendering |
| Frontend Bundler | Vite | 6.x | Dev server, HMR, production build |
| Frontend Routing | React Router DOM | v6 | Client-side navigation |
| Frontend State | React Context + sessionStorage | — | Cross-page persistence via DashboardContext |
| Real-time Client | socket.io-client | 4.8.3 | Receives live drift events from server |
| JSON Diffing (Frontend) | deep-diff | 1.0.2 | Field-level diff on ComparisonPage |
| Charts | Recharts | 3.8.1 | KPI bar chart and donut chart on Dashboard |
| Backend Runtime | Node.js | 18+ | Express API process |
| Backend Framework | Express | 4.22 | REST routing, middleware |
| Real-time Server | Socket.IO | 4.8.3 | Bi-directional events, room-based broadcasting |
| Serverless | Azure Functions | v4 (Node 20) | detectDrift, aiOperations, monitorResources, scanSubscription, recordChange, seedBaseline, sendAlert |
| Primary Storage | Azure Blob Storage SDK | 12.31 | baselines, drift-records, baseline-genome, all-changes containers |
| Index Storage | Azure Table Storage SDK | 13.3 | driftIndex, genomeIndex, changesIndex, monitorSessions, liveStateCache tables |
| Queue | Azure Storage Queue SDK | 12.29 | resource-changes queue, bridges Event Grid → Express |
| Event Bus | Azure Event Grid | — | Captures ARM ResourceWriteSuccess/Delete events |
| Orchestration | Azure Logic Apps | — | adip-logic-app (routing), adip-drift-alert (alerting) |
| AI | Azure OpenAI (GPT-4o) | API ver 2024-10-21 | Drift explanation, severity re-classification, anomaly detection |
| Email | Azure Communication Services SDK | 1.1 | HTML drift alert emails with Approve/Reject links |
| Policy | Azure Policy Insights SDK | 6.0 | Read-only compliance queries |
| Auth | Azure DefaultAzureCredential | identity SDK 4.x | CLI locally, Managed Identity in cloud |
| Shared Module | adip-shared | file:../shared | diff.js, severity.js, constants.js, blobHelpers.js shared by Express + Function App |

### ARM Resource Types Monitored (API_VERSION_MAP)

| Resource Type | ARM Type | API Version |
|---|---|---|
| Storage Accounts | `Microsoft.Storage/storageAccounts` | 2023-01-01 |
| Virtual Machines | `Microsoft.Compute/virtualMachines` | 2023-07-01 |
| Logic Apps | `Microsoft.Logic/workflows` | 2019-05-01 |
| App Service / Function Apps | `Microsoft.Web/sites` | 2023-01-01 |
| Key Vaults | `Microsoft.KeyVault/vaults` | 2023-07-01 |
| Virtual Networks | `Microsoft.Network/virtualNetworks` | 2023-05-01 |
| Network Security Groups | `Microsoft.Network/networkSecurityGroups` | 2023-05-01 |
| Public IP Addresses | `Microsoft.Network/publicIPAddresses` | 2023-05-01 |
| Network Interfaces | `Microsoft.Network/networkInterfaces` | 2023-05-01 |
| Managed Disks | `Microsoft.Compute/disks` | 2023-04-02 |
| SQL Servers | `Microsoft.Sql/servers` | 2023-05-01 |
| SQL Databases | `Microsoft.Sql/servers/databases` | 2023-05-01 |
| Application Insights | `Microsoft.Insights/components` | 2020-02-02 |
| Cosmos DB | `Microsoft.DocumentDB/databaseAccounts` | 2024-11-15 |
| Service Bus / Event Hubs Namespaces | `Microsoft.ServiceBus/namespaces` | 2022-10-01 |
| Event Grid Topics | `Microsoft.EventGrid/topics` | 2022-06-15 |
| Container Registries | `Microsoft.ContainerRegistry/registries` | 2023-07-01 |
| AKS Clusters | `Microsoft.ContainerService/managedClusters` | 2023-08-01 |
| Load Balancers | `Microsoft.Network/loadBalancers` | 2023-05-01 |
| Application Gateways | `Microsoft.Network/applicationGateways` | 2023-05-01 |
| Cognitive Services / OpenAI | `Microsoft.CognitiveServices/accounts` | 2023-11-01 |
| PostgreSQL Flexible Servers | `Microsoft.DBforPostgreSQL/flexibleServers` | 2023-06-01-preview |
| Azure Cache for Redis | `Microsoft.Cache/redis` | 2023-08-01 |
| Azure AI Search | `Microsoft.Search/searchServices` | 2023-11-01 |
| App Service Plans | `Microsoft.Web/serverfarms` | 2023-01-01 |
| VNet Connections | `Microsoft.Network/connections` | 2023-05-01 |
| DNS Zones | `Microsoft.Network/dnsZones` | 2018-05-01 |
| Private DNS Zones | `Microsoft.Network/privateDnsZones` | 2020-06-01 |
| Bastion Hosts | `Microsoft.Network/bastionHosts` | 2023-05-01 |
| VNet Gateways | `Microsoft.Network/virtualNetworkGateways` | 2023-05-01 |
| Route Tables | `Microsoft.Network/routeTables` | 2023-05-01 |
| Availability Sets | `Microsoft.Compute/availabilitySets` | 2023-07-01 |
| Disk Snapshots | `Microsoft.Compute/snapshots` | 2023-04-02 |
| VM Images | `Microsoft.Compute/images` | 2023-07-01 |
| Container Instances | `Microsoft.ContainerInstance/containerGroups` | 2023-05-01 |

> **Note:** For any resource type not in this map, `getApiVersion()` dynamically queries the ARM provider API and caches the result in `providerApiVersionCache`.

### Child Resources Fetched Per Parent

| Parent Type | Child Resources Fetched |
|---|---|
| `storageAccounts` | blobServices/default, fileServices/default, queueServices/default, tableServices/default |
| `sites` (App Service) | config/web |


---

## Phase 2: Detailed Component-to-Function Mapping

### 2.1 Authentication

| Frontend Component | User Action/Trigger | Frontend Logic | Backend Endpoint/Function | Logic Description |
|---|---|---|---|---|
| `LoginPage.jsx` → `handleLogin()` | Button click ("Sign In") or Enter key | Validates username/password against hardcoded `DUMMY_USERS` array; on match writes `JSON.stringify(user)` to `sessionStorage('user')`; calls `navigate('/dashboard')` | None — fully client-side | No backend call is made. Auth is a local array comparison. sessionStorage is the session store. |
| `LoginPage.jsx` → password visibility toggle | Button click on eye icon | Toggles `showPass` boolean state; swaps `input[type]` between password/text | None | Pure UI state toggle. |

> ⚠️ **Dead Code Flag:** `src/services/auth.js` exports `isSSOConfigured()` and `getDemoUser()`, and `VITE_AZURE_CLIENT_ID` is in `.env.example`, but `LoginPage.jsx` never imports `auth.js`. The SSO code path is documented but entirely unreachable in the current build.

---

### 2.2 DashboardHome — KPIs, Charts, Recent Changes Table

| Frontend Component | User Action/Trigger | Frontend Logic | Backend Endpoint/Function | Logic Description |
|---|---|---|---|---|
| `DashboardHome.jsx` → `load()` | useEffect on mount + every 30s interval | Sets `loading=true`; calls APIs in sequence | `GET /api/subscriptions` → `subscriptions.js` → `listSubscriptions()` | Uses `SubscriptionClient` from `@azure/arm-subscriptions` with `DefaultAzureCredential`; iterates `client.subscriptions.list()`. |
| `DashboardHome.jsx` → `load()` | After sub list resolves | Calls `fetchResourceGroups(sub)` for first/active sub | `GET /api/subscriptions/:id/resource-groups` | Uses `ResourceManagementClient.resourceGroups.list()`. |
| `DashboardHome.jsx` → `load()` | After RG list resolves | Calls `fetchResources` for first 10 RGs concurrently via `Promise.allSettled` | `GET /api/subscriptions/:id/resource-groups/:rg/resources` | Calls `client.resources.listByResourceGroup(rg)`; accumulates total resource count. |
| `DashboardHome.jsx` → `load()` | After RGs resolve | Calls `fetchStatsToday(sub)` | `GET /api/stats/today?subscriptionId=` | Queries `changesIndex` Table Storage with `PartitionKey eq subscriptionId AND detectedAt ge midnight-ISO`; returns `{totalChanges, totalDrifted, totalRGs, uniqueCallers, allTimeTotal}`. |
| `DashboardHome.jsx` → `load()` | After stats resolve | Calls `fetchRecentChanges(sub, {hours, filters})` | `GET /api/changes/recent` | Queries `changesIndex` Table with `detectedAt ge since`; for each matching entity fetches full blob from `all-changes` container. |
| `DashboardHome.jsx` → chart | Auto after load | Calls `fetchChartData(sub, mode)` | `GET /api/stats/chart?subscriptionId=&mode=24h\|7d\|30d` | Queries `changesIndex` Table; buckets events by hour (24h) or day (7d/30d); returns `{mode, buckets[{label, count}]}`. |
| `DashboardHome.jsx` → Filter dropdowns | onChange on each FilterDropdown | Updates `pendingFilters` state via `toggleFilterOption`; does NOT call API yet | None until Apply | Pure local state accumulation. |
| `DashboardHome.jsx` → Apply button | Click | Sets `appliedFilters = pendingFilters`; closes dropdown; triggers `load()` re-run | Re-triggers entire `load()` with new filter params | `fetchRecentChanges` is called again with `resourceGroup`, `caller`, `changeType` derived from `appliedFilters`. |
| `DashboardHome.jsx` → table row | None — no navigation on row click | Rows render static data | None | ⚠️ **Flag:** `navigateToComparison()` is defined but never wired to the table. Comparison navigation only works from DriftScanner. |
| `DashboardHome.jsx` → 30s setInterval | Timer | Calls `load()` again | Same as above | Keeps KPIs and recent changes fresh without page reload. |

---

### 2.3 DriftScanner — Resource Selection, Submit, Stop

| Frontend Component | User Action/Trigger | Frontend Logic | Backend Endpoint/Function | Logic Description |
|---|---|---|---|---|
| `DriftScanner.jsx` → Subscription select | onChange | Sets subscription in DashboardContext; clears resourceGroup, resource, configData; calls `fetchRGs(v)` | `GET /api/subscriptions/:id/resource-groups` | Same as DashboardHome RG fetch. |
| `DriftScanner.jsx` → Resource Group select | onChange | Sets resourceGroup in context; clears resource; calls `fetchResources(subscription, v)` | `GET /api/subscriptions/:id/resource-groups/:rg/resources` | Same as DashboardHome resources fetch. |
| `DriftScanner.jsx` → `handleSubmit()` | Button click ("Submit Scan") | Sets `isScanning=true`, `isSubmitted=false`, clears configData and liveEvents; starts setInterval that fires every 10ms to replay `LIVE_EVENTS_TEMPLATE` entries | `GET /api/configuration?subscriptionId=&resourceGroupId=&resourceId=` | Fetches live ARM config for resource/RG; fetches child resources via `CHILD_RESOURCES` map in parallel using `Promise.allSettled`; returns object with `_childConfig`. |
| `DriftScanner.jsx` → after configData resolves | Auto (inside config `Promise.then`) | Sets `isSubmitted=true`, `configData`; starts monitoring; calls 3 parallel post-submit calls | `GET /api/policy/compliance` | Queries `PolicyInsightsClient.policyStates.listQueryResultsForResource`; returns `{total, nonCompliant, compliant, violations[]}`. |
| `DriftScanner.jsx` → after configData resolves (2) | Auto | Calls `fetchAnomalies(subscription)` | `GET /api/ai/anomalies?subscriptionId=` | Express proxies to Azure Function; Function queries `driftIndex` Table for last 50 records, then calls Azure OpenAI to identify patterns. |
| `DriftScanner.jsx` → after configData resolves (3) | Auto | Calls `cacheState(r.id, r)` for each resource | `POST /api/cache-state` | Strips VOLATILE fields from state; writes to `liveStateCache` Proxy (in-memory `_mem` map + async write to `liveStateCache` Table Storage via `cacheSet`). Critical for enabling first-event diffs. |
| `DriftScanner.jsx` → `handleStop()` | Button click (stop icon) | Clears scanInterval; calls `stopMonitoring`; resets all context state to defaults | `POST /api/monitor/stop` | Upserts `monitorSessions` Table entity with `active: false` using Merge operation. |
| `DriftScanner.jsx` → Compare button | Button click | Calls `navigate('/comparison', { state: {...} })` | None — navigation only | Passes `subscriptionId`, `resourceGroupId`, `resourceId`, `resourceName`, and `configData` as React Router location state. |
| `DriftScanner.jsx` → Genome button | Button click | Calls `navigate('/genome', { state: {...} })` | None — navigation only | Passes resource identifiers as Router state. |
| `DriftScanner.jsx` → 5s setInterval (after submit) | Timer (while `isSubmitted`) | Auto-refreshes configData silently | `GET /api/configuration` | Keeps JSON tree current for live resources without user interaction. |

---

### 2.4 DriftScanner — Socket.IO Real-time Feed (useDriftSocket)

| Frontend Component | User Action/Trigger | Frontend Logic | Backend Endpoint/Function | Logic Description |
|---|---|---|---|---|
| `useDriftSocket.js` → `connectSocket()` | useEffect when `scope.subscriptionId` changes | Dynamically imports socket.io-client; connects to `VITE_SOCKET_URL`; emits `subscribe` with `{subscriptionId, resourceGroup, resourceId}` | Socket.IO `subscribe` event in `app.js` `io.on('connection')` handler | Server calls `socket.join(baseRoom)` where `baseRoom = subscriptionId:resourceGroup` (lowercased). Optionally joins resource-specific room. |
| `useDriftSocket.js` → `socket.on('resourceChange')` | Server push event | Checks `isSubmittedRef.current`; checks scope match; calls `addEvent(event)` which deduplicates; if `onConfigUpdate` provided, calls it | Emitted by `queuePoller.js` `startQueuePoller()` or `broadcastDriftEvent()` in `socketService.js` | Events originate from Storage Queue poll (every 5s) or from `/internal/drift-event` (called by Function App). Each event carries `resourceId`, `changes[]`, `liveState`, `caller`, etc. |
| `useDriftSocket.js` → `addEvent()` | Internal call | Deduplicates using composite key; prepends `_clientId` and `_receivedAt`; caps array at 200 | None — local state | Uses functional update pattern to prevent stale closure issues. |
| `DriftScanner.jsx` → `handleConfigUpdate()` | Called by useDriftSocket on each `resourceChange` | If `event.liveState` exists and specific resource selected, sets `configData = event.liveState`; otherwise re-fetches | `GET /api/configuration` (conditional) | Allows JSON tree to auto-update in real time without user re-submitting. |

---

### 2.5 ComparisonPage — Baseline Fetch, Diff, Remediation

| Frontend Component | User Action/Trigger | Frontend Logic | Backend Endpoint/Function | Logic Description |
|---|---|---|---|---|
| `ComparisonPage.jsx` → useEffect on mount | Page load | Calls `fetchPolicyCompliance` and `fetchBaseline` concurrently | `GET /api/baselines?subscriptionId=&resourceId=` | Computes `blobKey(resourceId) = base64url(resourceId) + '.json'`; calls `getBlobClient(key).downloadToBuffer()`; verifies `doc.subscriptionId` matches; returns document or null. |
| `ComparisonPage.jsx` → after baseline resolves | Auto | Calls `deepDiff(normaliseState(baseline), normaliseState(passedLive))`; maps raw diff to structured format; calls `classifySeverity(diffs)` | Frontend only | `normaliseState()` strips VOLATILE fields (etag, provisioningState, etc.) before diffing to eliminate noise. |
| `ComparisonPage.jsx` → AI explanation trigger | Auto (when `differences.length > 0`) | Sets `aiLoading=true`; calls `fetchAiExplanation(record)` non-blocking | `POST /api/ai/explain` | Express proxy calls `FUNCTION_APP_URL/ai/explain?code=${AI_FUNCTION_KEY}`; Function builds prompt with resource type + changes; calls Azure OpenAI; returns `{explanation: string}`. |
| `ComparisonPage.jsx` → "Apply Fix Now" / "Request Approval" button | Click | Checks severity; if 'low' calls `remediateToBaseline`; else calls `requestRemediation`; also calls `fetchAiRecommendation` non-blocking | `POST /api/remediate` OR `POST /api/remediate-request` | See Phase 3 for detailed logic. |
| `ComparisonPage.jsx` → Upload Baseline | File selection | Reads .json file; detects ARM template format; extracts `resources[0]` if ARM template; calls `uploadBaseline` | `POST /api/baselines/upload` | Calls `saveBaseline()` which writes JSON to `baselines/base64url(resourceId).json` blob. Then re-fetches baseline and recomputes diff. |
| `ComparisonPage.jsx` → Expand/Collapse buttons | Click | Calls `baselineTreeRef.current?.expandAll()` and `liveTreeRef.current?.expandAll()` | None — imperative ref call on JsonTree | `useImperativeHandle` in `JsonTree.jsx` exposes `expandAll`/`collapseAll` which rebuild `expandedNodes` Set. |

---

### 2.6 GenomePage — Snapshots, Promote, Rollback, Delete

| Frontend Component | User Action/Trigger | Frontend Logic | Backend Endpoint/Function | Logic Description |
|---|---|---|---|---|
| `GenomePage.jsx` → `load()` | useEffect on mount | Calls `fetchGenomeSnapshots(subscriptionId, resourceId)` | `GET /api/genome?subscriptionId=&resourceId=` | Queries `genomeIndex` Table with `PartitionKey eq subscriptionId AND resourceId eq resourceId`; for each entity fetches blob from `baseline-genome` container; sorts newest-first. |
| `GenomePage.jsx` → "+ Save Snapshot" button | Click | Sets `saving=true`; calls `saveGenomeSnapshot(subscriptionId, rgId, resourceId, label)` | `POST /api/genome/save` | Fetches current live ARM config; generates blob key `ISO-timestamp_base64url(resourceId).json`; writes to `baseline-genome` container; upserts index entity in `genomeIndex` Table. |
| `GenomePage.jsx` → "Set as Baseline" button | Click | Sets `acting=blobKey`; calls `promoteGenomeSnapshot` | `POST /api/genome/promote` | Reads snapshot blob from `baseline-genome`; writes its `resourceState` to `baselines/base64url(resourceId).json`, overwriting the golden baseline. |
| `GenomePage.jsx` → "Rollback" / "Rollback All" button | Click | `window.confirm()` gate; calls `rollbackToSnapshot` | `POST /api/genome/rollback` | Reads snapshot; strips VOLATILE fields; parses ARM resource ID; calls `armClient.resources.beginCreateOrUpdateAndWait()` — synchronous ARM PUT. For RG-level rollback, iterates `snapshot.resourceState.resources[]` and PUTs each one. |
| `GenomePage.jsx` → "Delete" button | Click | `window.confirm()` gate; calls `deleteGenomeSnapshot` | `POST /api/genome/delete` | Calls `getBlobClient(blobName).deleteIfExists()`; then attempts to delete matching entity from `genomeIndex` Table. |

---

### 2.7 Remediation Decision (Email Approval Flow)

| Frontend Component | User Action/Trigger | Frontend Logic | Backend Endpoint/Function | Logic Description |
|---|---|---|---|---|
| Email client (admin's browser) → Approve/Reject link | Click on email hyperlink | Browser GET to `EXPRESS_PUBLIC_URL/api/remediate-decision?action=approve&token=...` | `GET /api/remediate-decision` | Decodes base64url token; if approve: fetches baseline, strips VOLATILE, ARM PUT; if reject: fetches live state, saves as new baseline; returns styled HTML confirmation page. |
| `ComparisonPage.jsx` → "Request Approval" button | Click | Calls `requestRemediation(payload)` | `POST /api/remediate-request` | Posts payload to `ALERT_LOGIC_APP_URL` if severity is critical/high/medium; Logic App forwards to `sendAlert` Function which emails admins. Returns `{requested: true}` immediately. |

---

### 2.8 AzureChatbot

| Frontend Component | User Action/Trigger | Frontend Logic | Backend Endpoint/Function | Logic Description |
|---|---|---|---|---|
| `AzureChatbot.jsx` → `send()` | Button click or Enter key | Appends user message to messages array; sets `loading=true`; sends last-20-turns history | `POST /api/chat` | Constructs system prompt with Azure cloud expert context; optionally injects `context.resourceId` and `context.driftSummary`; calls Azure OpenAI `/openai/deployments/{deployment}/chat/completions` with `max_tokens:600`, `temperature:0.4`; returns `{reply: string}`. |
| `AzureChatbot.jsx` → FAB button | Click | Toggles `open` boolean; mounts/unmounts chat window | None | Pure UI toggle. Chat history persists in component state while mounted. |

---

### 2.9 Internal Backend Paths (No Direct Frontend Trigger)

| Source | Trigger | Function | Logic Description |
|---|---|---|---|
| `app.js` server start | Node.js process start | `startQueuePoller()` in `queuePoller.js` | Begins setInterval at `QUEUE_POLL_INTERVAL_MS` (default 5000ms); polls `resource-changes` Storage Queue. |
| Azure Event Grid | ARM ResourceWriteSuccess/ResourceDeleteSuccess | `recordChange/index.js` (Azure Function) | Filters out failed, read, list, and `/deployments/` events; writes blob to `all-changes` container and entity to `changesIndex` Table. Independent of Express. |
| Azure Event Grid → Logic App `adip-logic-app` | ARM change event passes filters | `detectDrift/index.js` (Azure Function) | Fetches live ARM config; reads baseline blob; computes diff; classifies severity; writes `drift-records` blob; POSTs to `EXPRESS_API_URL/internal/drift-event`. |
| `POST /internal/drift-event` | Function App HTTP POST | Inline handler in `app.js` | Cross-path dedup via `_emittedEvents` Map; emits `resourceChange` to Socket.IO room; optionally fires Logic App alert webhook for critical/high events. |
| `queuePoller.js` poll cycle | 5s timer | `enrichWithDiff(event)` | Fetches live ARM config; checks `liveStateCache` for previous state; runs `diffObjects()`; updates cache; auto-saves genome snapshot if changes detected; emits to 3 Socket.IO rooms. |
| Azure Functions timer | Every 1 minute | `monitorResources/index.js` | Reads `monitorSessions` Table for `active=true` entities; for each session fetches live config, diffs against baseline blob, saves drift record + `driftIndex` entity, notifies Express. |
| Azure Functions timer | Every hour | `scanSubscription/index.js` | Iterates all subscriptions → all RGs → all resources (batch of 5 RGs in parallel); for each resource with a baseline blob, diffs and saves drift records. |


---

## Phase 3: Complete API Endpoint Reference

All endpoints are prefixed with `/api` and served by Express on port 3001.

### Subscriptions & Resources

| Method | Endpoint | Query Params | Body | Returns | Source File |
|---|---|---|---|---|---|
| GET | `/subscriptions` | — | — | `[{id, displayName, state}]` | `subscriptions.js` |
| GET | `/subscriptions/:id/resource-groups` | — | — | `[{name, location, id}]` | `resourceGroups.js` |
| GET | `/subscriptions/:id/resource-groups/:rg/resources` | — | — | `[{name, type, id, location}]` | `resources.js` |
| GET | `/configuration` | `subscriptionId`, `resourceGroupId`, `resourceId` | — | `{...armConfig, _childConfig}` | `configuration.js` |

### Baseline Management

| Method | Endpoint | Query Params | Body | Returns | Source File |
|---|---|---|---|---|---|
| GET | `/baselines` | `subscriptionId`, `resourceId` | — | `{id, subscriptionId, resourceId, resourceState, promotedAt}` or `null` | `baseline.js` |
| POST | `/baselines` | — | `{subscriptionId, resourceGroupId, resourceId, resourceState}` | `{id, ...}` | `baseline.js` |
| POST | `/baselines/upload` | — | `{subscriptionId, resourceGroupId, resourceId, baseline}` (raw ARM config or ARM template) | `{id, ...}` | `baselineUpload.js` |
| POST | `/seed-baseline` | — | `{subscriptionId, resourceGroupId, resourceId}` | `{id, ...}` | `seed.js` |

### Drift Detection & History

| Method | Endpoint | Query Params | Body | Returns | Source File |
|---|---|---|---|---|---|
| POST | `/compare` | — | `{subscriptionId, resourceGroupId, resourceId, liveState}` | `{drift: {...}, severity, changes[]}` | `compare.js` |
| GET | `/drift-events` | `subscriptionId`, `resourceGroup?`, `severity?`, `since?`, `caller?`, `limit=50` | — | `[{resourceId, severity, changes[], detectedAt, caller}]` | `drift.js` |
| GET | `/changes/recent` | `subscriptionId`, `resourceGroup?`, `caller?`, `changeType?`, `hours=24`, `limit=200` | — | `[{resourceId, operationName, caller, detectedAt, changeCount}]` | `drift.js` |
| GET | `/changes/count` | `subscriptionId` | — | `{total}` | `drift.js` |
| GET | `/stats/today` | `subscriptionId` | — | `{totalChanges, totalDrifted, totalRGs, uniqueCallers[], since, allTimeTotal}` | `drift.js` |
| GET | `/stats/chart` | `subscriptionId`, `mode=24h\|7d\|30d` | — | `{mode, buckets[{label, count, key}]}` | `drift.js` |

### Monitoring

| Method | Endpoint | Query Params | Body | Returns | Source File |
|---|---|---|---|---|---|
| POST | `/monitor/start` | — | `{subscriptionId, resourceGroupId, resourceId, interval}` | `{sessionId, active: true}` | `app.js` (inline) |
| POST | `/monitor/stop` | — | `{sessionId}` | `{active: false}` | `app.js` (inline) |
| POST | `/cache-state` | — | `{resourceId, state}` | `{cached: true, resourceId}` | `app.js` (inline) |

### Remediation

| Method | Endpoint | Query Params | Body | Returns | Source File |
|---|---|---|---|---|---|
| POST | `/remediate` | — | `{subscriptionId, resourceGroupId, resourceId, baselineState}` | `{remediated: true}` or `{error}` | `remediate.js` |
| POST | `/remediate-request` | — | `{subscriptionId, resourceGroupId, resourceId, differences, severity, caller}` | `{requested: true}` | `remediateRequest.js` |
| GET | `/remediate-decision` | `action=approve\|reject`, `token=<base64url>` | — | HTML confirmation page | `remediateDecision.js` |

### Configuration Genome

| Method | Endpoint | Query Params | Body | Returns | Source File |
|---|---|---|---|---|---|
| GET | `/genome` | `subscriptionId`, `resourceId`, `limit=50` | — | `[{_blobKey, subscriptionId, resourceId, resourceState, label, savedAt}]` | `genome.js` |
| POST | `/genome/save` | — | `{subscriptionId, resourceGroupId, resourceId, label?}` | `{_blobKey, ...}` | `genome.js` |
| POST | `/genome/promote` | — | `{subscriptionId, resourceId, blobKey}` | `{promoted: true}` | `genome.js` |
| POST | `/genome/rollback` | — | `{subscriptionId, resourceGroupId, resourceId, blobKey}` | `{rolledBack: true}` or `{error}` | `genome.js` |
| POST | `/genome/delete` | — | `{blobKey}` | `{deleted: true}` | `genome.js` |

### AI Features

| Method | Endpoint | Query Params | Body | Returns | Source File |
|---|---|---|---|---|---|
| POST | `/ai/explain` | — | `{resourceId, resourceGroup, subscriptionId, severity, differences}` | `{explanation: string}` | `ai.js` (proxy to Function App) |
| POST | `/ai/severity` | — | `{resourceId, resourceGroup, subscriptionId, differences, currentSeverity}` | `{severity: string, reasoning: string}` | `ai.js` (proxy to Function App) |
| POST | `/ai/recommend` | — | `{resourceId, resourceGroup, subscriptionId, differences, severity}` | `{recommendation: string}` | `ai.js` (proxy to Function App) |
| GET | `/ai/anomalies` | `subscriptionId` | — | `{anomalies: string}` | `ai.js` (proxy to Function App) |

### Policy & Alerts

| Method | Endpoint | Query Params | Body | Returns | Source File |
|---|---|---|---|---|---|
| GET | `/policy/compliance` | `subscriptionId`, `resourceGroupId?`, `resourceId?` | — | `{total, nonCompliant, compliant, violations[]}` | `policy.js` |
| POST | `/alert/email` | — | `{resourceId, severity, changes[], caller, detectedAt}` | `{sent: true}` | Logic App → `sendAlert` Function |
| POST | `/internal/drift-event` | — | `{eventId, resourceId, subscriptionId, resourceGroup, changes[], liveState, caller, eventTime}` | `200 OK` | `app.js` (inline) |

### Chat

| Method | Endpoint | Query Params | Body | Returns | Source File |
|---|---|---|---|---|---|
| POST | `/chat` | — | `{messages[], context?}` | `{reply: string}` | `chat.js` |

---

## Phase 4: Severity Classification Rules

| Level | Condition |
|---|---|
| **Critical** | Any field deleted, OR 3+ tag changes in one event |
| **High** | Change to `properties.networkAcls`, `properties.accessPolicies`, `properties.securityRules`, `sku`, `location`, `identity`, or `properties.encryption` |
| **Medium** | More than 5 fields changed (none security-sensitive) |
| **Low** | 1–5 non-security field changes |

After rule-based classification, Azure OpenAI may **escalate** severity if context warrants it (e.g., changing a tag on a production Key Vault during off-hours). AI never reduces severity.

### Remediation Behavior by Severity

| Severity | Action on "Remediate" click |
|---|---|
| **Low** | Immediately applies ARM PUT (no approval needed) |
| **Medium / High / Critical** | Sends approval email to `ALERT_RECIPIENT_EMAIL`; admin clicks Approve/Reject link |
| **Reject** | Accepts current live state as the new golden baseline |

---

## Phase 5: Dead Code & Inconsistency Flags (Corrected)

| # | File | Issue | Severity |
|---|---|---|---|
| 1 | `src/pages/LoginPage.jsx` | `import { isSSOConfigured, getDemoUser }` is in the services layer but `LoginPage.jsx` never imports `auth.js`. SSO path is documented but unreachable. | Medium |
| 2 | `src/pages/DashboardHome.jsx` | `navigateToComparison()` function is defined (line ~167) and never called from any table row `onClick`. The table is view-only. | High |
| 3 | `adip-backend/express-api/src/routes/ai.js` | `AI_FUNCTION_KEY` is read from `process.env.AI_FUNCTION_KEY` but this variable is not present in `.env.example`. If the Function App has auth level `function`, all AI proxied calls will return 401 silently. | High |
| 4 | `adip-backend/express-api/src/services/queuePoller.js` | `saveChangeRecord()` is imported but the call is wrapped in try/catch and never throws on failure. Result: `all-changes` is written by both `recordChange` Function AND queue poller (duplicate writes). | Medium |
| 5 | `src/pages/DashboardHome.jsx` → `load()` | `fetchDriftEvents()` is defined in `api.js` but `DashboardHome` uses `fetchRecentChanges()` instead. `fetchDriftEvents` queries `drift-records` (severity-classified drift), while `fetchRecentChanges` queries `all-changes` (all ARM events including non-drifted ones). The KPI `totalChanges` reflects all ARM writes, not just detected drifts. | Medium |
| 6 | `adip-backend/express-api/.env` | A second `.env` file exists in `adip-backend/express-api/` alongside the root `.env`. If Express loads the local one first, it may override root values. | Critical |
| 7 | `.env` → `VITE_API_BASE_URL` | Points to `http://172.10.1.109:3001/api` (local network IP, not `localhost`). This will break for anyone not on that machine/network. | High |
| 8 | `.env` → `VITE_AZURE_CLIENT_ID` | Set to placeholder value `your-azure-app-client-id`. SSO won't work. | Low |
| 9 | `adip-backend/function-app` | Function App uses Node 20 (EOL April 2026, which is now). | Medium |

---

## Phase 6: Developer's Rationale (Key Architectural Decisions)

### Decision 1: Azure Blob Storage instead of Cosmos DB

Baselines, drift records, and genome snapshots are stored in Azure Blob Storage with deterministic key schemes, not Cosmos DB.

**Rationale:** Cosmos DB requires a minimum provisioned throughput of ~400 RU/s (~$25/month). Blob Storage costs fractions of a cent per GB. The access patterns don't require SQL queries — baselines are always fetched by known `resourceId` (O(1) blob GET by key), and drift history is fetched by timestamp prefix. The only sacrifice is ad-hoc querying, which is mitigated by writing lightweight index entities to Azure Table Storage alongside every blob write. Table Storage costs ~$0.045/GB stored + minimal transaction costs. The combined Blob+Table pattern gives near-zero idle cost with O(1) or indexed reads.

### Decision 2: Azure Table Storage as a Secondary Index

Every blob write in `blobService.js` is paired with a Table Storage `upsertEntity` call. `blobService.js` maintains `driftIndex`, `genomeIndex`, `changesIndex`, `liveStateCache` tables.

**Rationale:** Blob Storage's `listBlobsFlat()` is O(n) over the entire container. For large deployments with thousands of drift records, the fallback `_scanDriftRecords()` functions would be unacceptably slow. The Table provides `PartitionKey = subscriptionId` with OData filter capability, reducing queries to O(matching records). The upserts are `catch(() => {})` non-blocking — a Table write failure never breaks the primary blob write. This is a "best-effort index" pattern.

### Decision 3: adip-shared as a Local File-Based Package

Shared logic (`diff.js`, `severity.js`, `constants.js`, `blobHelpers.js`) lives in `adip-backend/shared/` referenced as `"adip-shared": "file:../shared"` in both `package.json` files.

**Rationale:** The `detectDrift` Function App and the Express API must produce identical diff and severity results. If they were separate implementations, a bug fix in one would not propagate to the other. A local `file:` reference avoids publishing to npm (inappropriate for internal code), avoids a monorepo workspace tool (adds complexity), and ensures the deployed Function App zip includes the shared code since `.funcignore` explicitly does NOT exclude `node_modules`.

### Decision 4: Socket.IO over Azure SignalR Service

Self-hosted Socket.IO on the Express server handles all WebSocket connections.

**Rationale:** Azure SignalR Service has a minimum cost of ~$50/month (Standard tier needed for >20 concurrent connections). For a platform targeting a single team or small enterprise group, self-hosted Socket.IO is free and sufficient. The code is specifically architected for easy replacement: `broadcastDriftEvent()` in `socketService.js` is a thin wrapper over `global.io.to(room).emit()`. Switching to Azure SignalR would require changing only this wrapper and the Socket.IO client URL — the room-based subscription model is compatible with SignalR hubs.

### Decision 5: global.io Instead of a Module Export

The Socket.IO server instance is stored on `global.io` in `app.js` rather than exported as a module.

**Rationale:** Express routes are loaded via `require('./routes/...')` in `app.js`. If `io` were a module export, routes would need to `require('../../app')` creating a circular dependency (`app.js` requires routes → routes require `app.js`). `global.io` breaks this cycle. `socketService.js` wraps the global access cleanly. This is a well-known Node.js pattern for shared stateful singletons.

### Decision 6: liveStateCache as a Proxy with Table Storage Persistence

`liveStateCache` in `queuePoller.js` is a JavaScript Proxy over an in-memory `_mem` object. The `set` trap asynchronously writes to `liveStateCache` Table Storage.

**Rationale:** The first event after an Express restart would have no previous state for diffing — resulting in events that show "N/A" for old values. By persisting to Table Storage, a restart recovers the last known state within the first poll cycle. The Proxy pattern means all existing code using `liveStateCache[id] = x` (legacy style) is automatically intercepted and persisted, without requiring callers to use an async API. The async write is fire-and-forget (`.catch(() => {})`), so Table Storage unavailability never blocks the real-time feed.

### Decision 7: Base64URL for Blob Keys

All blob keys are computed as `Buffer.from(resourceId).toString('base64url') + '.json'`.

**Rationale:** Azure ARM resource IDs contain forward slashes (`/`), which are reserved path separators in blob storage paths. Standard base64 produces `+`, `/`, `=` characters that are either reserved or require URL-encoding. `base64url` encoding substitutes `+`→`-`, `/`→`_`, and removes `=` padding, producing safe blob names without encoding. The transformation is deterministic — given the same `resourceId`, the key is always identical, enabling O(1) lookups without indexing.

### Decision 8: Dual-Path Event Deduplication

Two independent dedup mechanisms exist: `isDuplicate()` in `queuePoller.js` (prevents same queue event from being broadcast twice) and `_emittedEvents` Map in `app.js` `/internal/drift-event` handler (prevents double-emission when both the queue poller AND the Function App try to broadcast the same ARM event).

**Rationale:** Event Grid delivers to both the Storage Queue (→ queue poller path) and the Logic App (→ Function App → `/internal/drift-event`). Without dedup, a single ARM write would create two identical drift event rows in the frontend feed within seconds of each other. The queue poller dedup uses a time-bucket key (10s window) to also absorb rapid repeated events. The cross-path dedup uses `eventId + eventTime` as a 30-second window. Both use Map-based LRU-style pruning to prevent unbounded memory growth.

### Decision 9: isSubmittedRef Gate in Socket.IO Hook

`useDriftSocket.js` maintains `isSubmittedRef = useRef(isSubmitted)` and gates all incoming `resourceChange` events behind `if (!isSubmittedRef.current) return`.

**Rationale:** Without this gate, a user who has navigated to the Drift Scanner page but not yet clicked Submit would see live drift events in the feed for resources they haven't chosen. This creates confusion — the JSON tree is empty but the Activity Feed shows changes. The ref (not state) is used because Socket.IO event handlers form a closure over the initial value of `isSubmitted`. Using a ref that is updated via `useEffect(() => { isSubmittedRef.current = isSubmitted }, [isSubmitted])` ensures the handler always reads the current value without needing to re-subscribe.

---

## Phase 7: What's Missing from v1 (Summary of Additions)

1. **Phase 0: Azure Resource Inventory** — Complete mapping of all Azure resources, their purpose, connection strings, and how the code interacts with them.
2. **ARM Resource Types Monitored** — Full `API_VERSION_MAP` table with 35+ resource types.
3. **Child Resources** — Documented `CHILD_RESOURCES` map for Storage Accounts and App Services.
4. **Missing API Endpoints** — Added `/stats/today`, `/stats/chart`, `/changes/recent`, `/changes/count` which were implemented but not documented in v1.
5. **`monitorResources` Timer Function** — Added to Phase 2.9 (was missing entirely).
6. **Corrected Dead Code Flags** — Fixed flag #4 (queue poller DOES call `saveChangeRecord`), added flags #6-9 (duplicate `.env`, hardcoded IP, Node 20 EOL).
7. **Azure Function App — All 7 Functions** — v1 only mentioned `detectDrift`. v2 documents all 7: `detectDrift`, `aiOperations`, `monitorResources`, `scanSubscription`, `recordChange`, `seedBaseline`, `sendAlert`.
8. **Storage Queue Details** — Added producer/consumer/message format table.
9. **Event Grid Subscriptions** — Added table showing both Storage Queue and Logic App subscriptions.
10. **Logic Apps Workflow** — Detailed both `adip-logic-app` and `adip-drift-alert` flows.

---

*Azure Drift Intelligence Platform — ADIP v2.0 | CloudThat × Microsoft*
*Document generated: 2026-04-20 | For questions contact: ravi.d@cloudthat.com*
