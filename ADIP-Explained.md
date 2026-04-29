# ADIP — Full Plain-English Explanation
**Azure Drift Intelligence Platform | Every function, variable, and flow explained**

---

## What is ADIP?

ADIP watches your Azure infrastructure 24/7. When someone changes a resource — modifies a firewall rule, changes a tag, adjusts a VM size — ADIP detects it, records it, shows it on a dashboard, and lets you revert it. Think of it as "git for Azure infrastructure."

The system has three running parts:
1. **React frontend** — the dashboard you see in the browser (port 5173)
2. **Express API** — a Node.js server that talks to Azure on your behalf (port 3001)
3. **Azure Function App** — 7 serverless functions running in the cloud that handle events, drift detection, AI, and email

---

## Part 1: Azure Resources (What's Provisioned)

### Storage Account — `adipstore001`
One storage account does three jobs:

**Blob Storage** — stores JSON documents (like files in folders):
- `baselines/` — the "golden state" of each resource. When you say "this is correct", it's saved here. Key format: `base64url(resourceId).json`
- `drift-records/` — every time drift is detected, a record is saved here. Key: `timestamp_base64url(resourceId).json`
- `baseline-genome/` — version history of baselines (like git commits). Same key format as drift-records.
- `all-changes/` — every single ARM event (write or delete), regardless of whether drift was detected. Written by the `recordChange` Function.

**Table Storage** — stores lightweight index rows (like a database table, but simpler):
- `changesIndex` — one row per change event. Used to quickly query "show me all changes in the last 24 hours" without reading every blob.
- `driftIndex` — one row per drift detection. Used for `/api/drift-events` and stats.
- `genomeIndex` — one row per genome snapshot. Used for the Genome page.
- `monitorSessions` — one row per active monitoring session. The `monitorResources` Function reads this every minute.
- `liveStateCache` — stores the last known state of each resource. Used so that when Express restarts, it still knows what the resource looked like before the latest change.

**Storage Queue** — `resource-changes`:
- Azure Event Grid puts a message here every time an ARM resource changes.
- The Express queue poller reads this queue every 5 seconds.
- Message format: base64-encoded JSON array of Event Grid schema events.

### Function App — `adip-func-001`
Runs on a Consumption plan (you pay per execution, not per hour). Has 7 functions:

| Function | What it does |
|---|---|
| `recordChange` | Receives every ARM event from Event Grid. Writes to `all-changes` blob and `changesIndex` Table. |
| `detectDrift` | Called by Logic App when a change passes noise filters. Fetches live ARM config, compares to baseline, saves drift record, sends email. |
| `aiOperations` | Handles all AI requests (explain drift, re-classify severity, recommend fix, detect anomalies) via Azure OpenAI. |
| `monitorResources` | Runs every 1 minute. Reads `monitorSessions` Table, checks each active session's resource for drift. |
| `scanSubscription` | Runs every 1 hour. Scans every resource in the subscription that has a baseline. |
| `seedBaseline` | HTTP endpoint. Fetches live ARM config and saves it as the golden baseline. |
| `sendAlert` | Called by Logic App. Builds an HTML email with a diff table and Approve/Reject buttons, sends via ACS. |

### Logic Apps
Two Logic Apps act as routers:

**`adip-logic-app`** (Event Grid → detectDrift):
1. Event Grid sends it every ARM change event
2. It filters out noise: failed operations, read/list operations, deployment events
3. If the event passes, it calls `detectDrift` Function via HTTP POST

**`adip-drift-alert`** (Express → sendAlert):
1. Express calls this when remediation approval is needed
2. It checks severity (critical/high/medium only)
3. Calls `sendAlert` Function which emails the admin

### Azure OpenAI — `adip-openai`
GPT-4o deployment named `adip-gpt` in East US. Used for:
- Explaining drift in plain English
- Re-classifying severity with context
- Recommending remediation steps
- Detecting anomaly patterns across 50 recent drift records

### Azure Communication Services — `adip-comms`
Sends HTML emails. The sender address is `DoNotReply@d8515e4e-...azurecomm.net`. Used only for drift alert emails with Approve/Reject links.

---

## Part 2: Express API — Entry Point (`app.js`)

`app.js` is the first file that runs when you do `npm start` in the Express folder.

```
require('dotenv').config(...)   ← loads .env file from project root
```

**What it sets up:**
1. Creates an Express app
2. Wraps it in an HTTP server (needed for Socket.IO)
3. Creates a Socket.IO server on top of the HTTP server
4. Stores the Socket.IO instance as `global.io` — this is intentional (explained in Decision 5 below)
5. Registers all route files under `/api`
6. Starts the queue poller when the server starts listening

**Socket.IO room logic:**
When a browser connects and sends a `subscribe` event with `{subscriptionId, resourceGroup, resourceId}`:
- It joins room `subscriptionId:resourceGroup` (e.g. `8f461bb6...:rg-adip`)
- If a specific resource is selected, it also joins `subscriptionId:resourceGroup:resourcename`
- This means events are only sent to browsers watching the right scope

**`/internal/drift-event` endpoint:**
- Called by the `detectDrift` Function App (not the browser)
- Receives a drift event, emits it to the correct Socket.IO room
- Has dedup logic: `_emittedEvents` Map stores `eventId:eventTime` for 30 seconds. If the same event arrives twice (once from queue poller, once from Function App), the second one is dropped.

**`global._markEmitted(event)`:**
- A function stored on the global object
- Called by the queue poller after it emits an event
- Pre-registers the event in `_emittedEvents` so `/internal/drift-event` won't double-emit it

---

## Part 3: Queue Poller (`queuePoller.js`)

This is the real-time engine. It runs as a `setInterval` loop every 5 seconds inside the Express process.

### Variables

**`_queueClient`** — cached Azure Storage Queue client. Created once, reused. Lazy-initialized by `getQueueClient()`.

**`_mem`** — plain JavaScript object `{}`. Acts as an in-memory cache of the last known state of each resource. Key = resourceId, value = stripped ARM config JSON.

**`_tableClient`** — cached Azure Table Storage client for the `liveStateCache` table.

**`liveStateCache`** — a JavaScript Proxy wrapping `_mem`. When you write `liveStateCache[resourceId] = state`, the Proxy intercepts it, writes to `_mem` immediately (synchronous), and also fires `cacheSet()` asynchronously to persist to Table Storage. This means if Express restarts, the cache is recovered from Table Storage on the next read.

**`_dedup`** — a Map used for deduplication. Key = `resourceId:operationName:timeBucket`. Prevents the same event from being processed twice within a 10ms window.

### Functions

**`getQueueClient()`**
Creates and caches the Azure Storage Queue client. Uses `STORAGE_CONNECTION_STRING` from `.env`. Returns the same client on every call (singleton pattern).

**`getTableClient()`**
Same pattern for the `liveStateCache` Table Storage client.

**`cacheKey(resourceId)`**
Converts a resourceId (which contains `/` slashes) to a safe Table Storage row key by base64-encoding it and replacing unsafe characters.

**`cacheGet(resourceId)`**
1. Checks `_mem` first (fast, in-memory)
2. If not found, queries Table Storage
3. Parses the stored JSON and returns it
4. Returns `null` if nothing found

**`cacheSet(resourceId, state)`**
1. Writes to `_mem` immediately
2. Asynchronously upserts to Table Storage (fire-and-forget, failure is non-fatal)

**`isDuplicate(event)`**
- Computes a time bucket: `Math.floor(eventTime / 100)` — groups events within the same 100ms window
- Key = `resourceId:operationName:bucket`
- If key exists in `_dedup` Map → it's a duplicate, return true
- Otherwise add to Map, prune entries older than 60 seconds, return false

**`parseMessage(msg)`**
Takes a raw queue message (base64-encoded JSON) and extracts:
- `eventId` — unique ID from Event Grid
- `eventType` — e.g. `Microsoft.Resources.ResourceWriteSuccess`
- `eventTime` — ISO timestamp
- `resourceId` — ARM resource URI, normalized to parent (strips child paths like `/blobServices/default`)
- `subscriptionId` — extracted from position 2 of the resourceId path
- `resourceGroup` — extracted from position 4 of the resourceId path
- `operationName` — what operation was performed
- `caller` — who made the change. Tries multiple claim paths in order: `claims.name`, `claims.unique_name`, `claims.upn`, first+last name combination, `event.data.caller`

**`enrichWithDiff(event)`**
The most important function in the queue poller. Takes a parsed event and adds diff information:
1. Calls `getResourceConfig()` to fetch the current live ARM config
2. Calls `resolveIdentity()` to get a human-readable name for the caller
3. Checks `liveStateCache` for the previous state. If not found, tries to load the baseline blob.
4. Runs `diffObjects(previous, current)` to get field-level changes
5. Updates `liveStateCache` with the new current state
6. Returns the enriched event with `liveState`, `changes[]`, `changeCount`, `hasPrevious`

**`startQueuePoller()`**
The main loop. Called once when Express starts.
- Reads `QUEUE_POLL_INTERVAL_MS` from env (default 5000ms = 5 seconds)
- Every interval:
  1. Calls `client.receiveMessages({ numberOfMessages: 32, visibilityTimeout: 300 })` — fetches up to 32 messages, hides them from other consumers for 300 seconds
  2. For each message: parse → dedup check → enrich with diff → delete from queue → save to `all-changes` blob → emit to Socket.IO rooms
  3. Emits to 3 rooms: subscription-level, RG-level, resource-level
  4. Calls `global._markEmitted()` to pre-register the event so `/internal/drift-event` won't double-emit

---

## Part 4: Blob Service (`blobService.js`)

Handles all reads and writes to Azure Blob Storage and Table Storage.

### Key functions

**`blobKey(resourceId)`** — converts a resourceId to a safe blob filename using base64url encoding. Example: `/subscriptions/8f46.../resourceGroups/rg-adip/providers/Microsoft.Storage/storageAccounts/adipstore001` → `L3N1YnNjcmlwdGlvbnMv...json`

**`saveBaseline(data)`** — writes a JSON document to `baselines/blobKey.json`. This is the golden state.

**`getBaseline(subscriptionId, resourceId)`** — reads the baseline blob. Returns null if not found.

**`saveDriftRecord(data)`** — writes to `drift-records/timestamp_blobKey.json` AND upserts a row in `driftIndex` Table.

**`saveChangeRecord(data)`** — writes to `all-changes/timestamp_blobKey.json` AND upserts a row in `changesIndex` Table. Called by both `recordChange` Function and queue poller.

**`getRecentChanges(subscriptionId, options)`** — queries `changesIndex` Table with OData filter, then fetches the full blob for each matching row. Returns array of change objects.

**`saveGenomeSnapshot(data)`** — writes to `baseline-genome/timestamp_blobKey.json` AND upserts in `genomeIndex` Table.

---

## Part 5: Azure Resource Service (`azureResourceService.js`)

Handles all ARM (Azure Resource Manager) API calls.

**`getApiVersion(provider, type)`** — looks up the API version for a resource type:
1. Checks `API_VERSION_MAP` in `constants.js` first (fast, hardcoded)
2. If not found, calls `armClient.providers.get(provider)` to ask ARM what API versions are available
3. Picks the latest stable version (one without "preview" in the name)
4. Caches the result in `providerApiVersionCache` Map

**`getResourceConfig(subscriptionId, resourceGroup, resourceId)`** — fetches the live ARM config for a resource. Parses the resourceId to extract provider, type, name. Calls `armClient.resources.get()`.

**`getChildResources(subscriptionId, resourceGroup, resourceId, type)`** — for storage accounts and App Services, fetches child configs (e.g. blob service settings, web config).

---

## Part 6: Shared Modules (`adip-backend/shared/`)

These are used by BOTH the Express API and the Function App, ensuring identical behavior.

**`diff.js`**:
- `strip(obj)` — removes VOLATILE fields (etag, provisioningState, changedTime, etc.) from an ARM config before comparing. Without this, every resource would show as "drifted" because etags change on every read.
- `diffObjects(baseline, live)` — compares two stripped configs field by field. Returns array of `{path, oldValue, newValue, type}` objects.

**`severity.js`**:
- `classifySeverity(changes)` — takes the diff array and returns a severity level:
  - Critical: any field deleted, or 3+ tag changes
  - High: change to security-sensitive paths (networkAcls, accessPolicies, securityRules, sku, location, identity, encryption)
  - Medium: more than 5 fields changed
  - Low: 1–5 non-security changes

**`constants.js`**:
- `VOLATILE` — array of field names to strip before diffing (etag, changedTime, provisioningState, etc.)
- `CRITICAL_PATHS` — array of JSON paths that trigger High severity
- `API_VERSION_MAP` — object mapping resource type names to ARM API versions. Example: `storageaccounts: '2023-01-01'`

**`blobHelpers.js`**:
- `blobKey(resourceId)` — base64url encode
- `driftKey(resourceId)` — timestamp + base64url encode
- `readBlob(container, key)` — download and parse JSON blob
- `writeBlob(container, key, data)` — serialize and upload JSON blob

---

## Part 7: Azure Functions

### `recordChange/index.js`
**Trigger:** HTTP webhook from Event Grid (every ARM write/delete)

What it does:
1. Receives the Event Grid event payload
2. Filters out noise: failed status, read/list operations, deployment events
3. Extracts resourceId, caller, subscriptionId, resourceGroup from the event
4. Calls `saveChangeRecord()` to write to `all-changes` blob and `changesIndex` Table
5. Returns 200 OK

This function runs independently of Express. Even if Express is down, changes are still recorded.

### `detectDrift/index.js`
**Trigger:** HTTP POST from `adip-logic-app` Logic App

What it does:
1. Receives the ARM event (already filtered by Logic App)
2. Parses resourceId to get provider, type, name
3. Looks up API version (checks `API_VERSION_MAP`, falls back to `armClient.providers.get()`)
4. Calls `armClient.resources.get()` to fetch live config
5. Calls `readBlob(baselineCtr, blobKey(resourceId))` to get the baseline
6. Runs `strip()` on both, then `diffObjects(baseline, live)`
7. Calls `classifySeverity(changes)` to get severity level
8. Writes drift record to `drift-records` blob and `driftIndex` Table
9. POSTs to `EXPRESS_API_URL/internal/drift-event` to push to Socket.IO
10. Sends email via ACS if severity is high/critical

### `monitorResources/index.js`
**Trigger:** Timer — every 1 minute

What it does:
1. Queries `monitorSessions` Table for all entities where `active = true`
2. For each session, checks if enough time has passed since `lastCheckedAt` (respects `intervalMs`)
3. For sessions that are due: calls `runDriftCheck(context, session)`
4. `runDriftCheck` fetches live ARM config, diffs against baseline, saves drift record if changes found
5. Updates `lastCheckedAt` for all checked sessions

**`intervalMs`** — stored per session in Table Storage. If you set a 10-minute interval, the function still runs every minute but skips sessions that were checked less than 10 minutes ago.

### `aiOperations/index.js`
**Trigger:** HTTP POST from Express `/api/ai/*` routes

Handles 4 operations based on `req.body.operation`:
- `explain` — sends drift changes to GPT-4o, asks for plain-English explanation
- `severity` — asks GPT-4o to re-evaluate severity with context (can only escalate, never reduce)
- `recommend` — asks GPT-4o for remediation steps
- `anomalies` — fetches last 50 drift records from `driftIndex`, sends to GPT-4o to find patterns

### `scanSubscription/index.js`
**Trigger:** Timer — every 1 hour

What it does:
1. Lists all resource groups in the subscription
2. For each RG (5 at a time in parallel), lists all resources
3. For each resource, checks if a baseline blob exists
4. If baseline exists, fetches live config, diffs, saves drift record if changed

### `seedBaseline/index.js`
**Trigger:** HTTP POST (called by Express `/api/seed-baseline`)

What it does:
1. Receives `{subscriptionId, resourceGroupId, resourceId}`
2. Fetches live ARM config
3. Saves it as the golden baseline blob

### `sendAlert/index.js`
**Trigger:** HTTP POST from `adip-drift-alert` Logic App

What it does:
1. Receives drift event with changes array
2. Builds an HTML email with a formatted diff table showing old → new values
3. Adds Approve/Reject buttons linking to `EXPRESS_PUBLIC_URL/api/remediate-decision?action=approve|reject&token=...`
4. The token is a base64url-encoded JSON object containing the full remediation context
5. Sends via Azure Communication Services SDK

---

## Part 8: Frontend

### `useDriftSocket.js` (React Hook)
Manages the Socket.IO connection. Used by `DriftScanner.jsx`.

**Variables:**
- `socketRef` — React ref holding the Socket.IO client instance. Using a ref (not state) means changing the socket doesn't trigger a re-render.
- `isSubmittedRef` — ref that mirrors the `isSubmitted` prop. Used inside the Socket.IO event handler because handlers form a closure — they capture the value at creation time. A ref always gives the current value.
- `mountedRef` — ref set to false when the component unmounts. Prevents state updates after unmount (which would cause React warnings).

**`connectSocket()`:**
1. Disconnects any existing socket
2. Creates new `io(SOCKET_URL)` connection
3. On `connect`: emits `subscribe` with current scope
4. On `resourceChange`: checks `isSubmittedRef` (gate), checks scope match, calls `addEvent()`
5. On scope change (useEffect dependency): re-emits `subscribe` without reconnecting

**`addEvent(event)`:**
- Deduplicates using `event.eventId || event.resourceId + event.eventTime`
- Prepends `_clientId` (random ID) and `_receivedAt` timestamp
- Caps the array at 200 events (oldest dropped)

### `useAzureScope.js` (React Hook)
Loads subscriptions, resource groups, and resources. Has demo mode fallback.

**`isDemoMode`** — boolean state. Set to true when `fetchSubscriptions()` fails (Express is down). When true, all dropdowns show hardcoded demo data instead of real Azure data.

**`fetchRGs(subscriptionId)`** — called when user selects a subscription. Calls `/api/subscriptions/:id/resource-groups`.

**`fetchResources(subscriptionId, resourceGroupId)`** — called when user selects a resource group.

### `DashboardContext.jsx`
Stores the selected subscription, resource group, resource, and config data in React Context AND in `sessionStorage`. This means if you navigate from DriftScanner to ComparisonPage and back, your selections are preserved.

**`ctxSub`, `ctxRG`, `ctxRes`** — the selected subscription/RG/resource IDs
**`configData`** — the last fetched ARM config JSON
**`isSubmitted`** — whether the user has clicked Submit on DriftScanner

### `DashboardHome.jsx`
The main dashboard page.

**`load()`** — called on mount and every 30 seconds:
1. Fetches subscriptions → picks first one as `activeSub`
2. Fetches resource groups for `activeSub`
3. Fetches resources for first 10 RGs concurrently
4. Fetches `stats/today` for KPI cards
5. Fetches `changes/recent` for the table

**`navigateToComparison(ev)`** — called when a table row is clicked:
1. Tries to fetch current live config for the resource
2. Navigates to `/comparison` passing `{subscriptionId, resourceGroupId, resourceId, liveState}` as React Router state

**`BarChart` component** — owns its own mode state (`24h`/`7d`/`30d`). On mount and mode change, calls `fetchChartStats(subscriptionId, mode)`. Renders bars proportional to `count/max`.

**`DonutChart` component** — shows `changed` resources vs `total` resources today. `changed` = unique resources with at least one ARM event today (from `changesIndex`). `total` = total resources in the subscription.

**`FilterDropdown` component** — a reusable dropdown for filter options. Uses `useRef` + `document.addEventListener('mousedown')` to close when clicking outside.

**`pendingFilters` vs `appliedFilters`** — filters are two-stage. `pendingFilters` updates as you check boxes. `appliedFilters` only updates when you click Apply. `load()` uses `appliedFilters`, so the table doesn't refresh on every checkbox click.

### `DriftScanner.jsx`
The resource monitoring page.

**`handleSubmit()`:**
1. Fetches ARM config for selected resource
2. Sets `isSubmitted = true` (this unblocks the Socket.IO event handler)
3. Calls `POST /api/cache-state` for each resource (seeds the diff cache)
4. Calls `POST /api/monitor/start` (creates a session in `monitorSessions` Table)
5. Starts a 5-second interval to auto-refresh the JSON tree

**`handleStop()`:**
1. Clears the refresh interval
2. Calls `POST /api/monitor/stop` (marks session as inactive in Table)
3. Resets all state

### `ComparisonPage.jsx`
Shows baseline vs live config side by side.

**On load:**
1. Fetches baseline blob
2. Runs `deepDiff(normaliseState(baseline), normaliseState(live))` — `normaliseState` strips VOLATILE fields
3. Maps raw diff to structured format with path, oldValue, newValue
4. Calls `classifySeverity(diffs)` for the severity badge
5. Calls `fetchAiExplanation()` non-blocking (shows when ready)

**Remediation:**
- Low severity → `POST /api/remediate` → ARM PUT immediately
- Medium/High/Critical → `POST /api/remediate-request` → Logic App → `sendAlert` Function → email with Approve/Reject links

### `GenomePage.jsx`
Version history for a resource.

**Snapshot list** — fetched from `GET /api/genome`. Each snapshot has a timestamp, optional label, and the full ARM config at that point in time.

**"Set as Baseline"** — copies the snapshot's `resourceState` to `baselines/blobKey.json`, overwriting the golden baseline.

**"Rollback"** — reads the snapshot, strips VOLATILE fields, calls ARM PUT to revert the resource to that state. For RG-level snapshots, iterates all resources and PUTs each one.

---

## Part 9: API Endpoints — What Each One Does

### Stats & Changes
- `GET /api/stats/today?subscriptionId=` — queries `changesIndex` Table for today (since midnight). Returns `totalChanges` (all ARM events today), `totalDrifted` (unique resources changed), `allTimeTotal`.
- `GET /api/stats/chart?subscriptionId=&mode=24h|7d|30d` — same table, bucketed by hour or day. Returns `{buckets: [{label, count}]}`.
- `GET /api/changes/recent` — queries `changesIndex` Table, fetches full blobs. Supports filters: `resourceGroup`, `caller`, `changeType`, `hours`.
- `GET /api/changes/count` — total count from `changesIndex`.

### Drift
- `GET /api/drift-events` — queries `driftIndex` Table (severity-classified drift only, not all ARM events).
- `POST /api/compare` — manual drift check. Takes `liveState` from request body, diffs against baseline blob, returns changes and severity.

### Monitoring
- `POST /api/monitor/start` — creates a row in `monitorSessions` Table with `active: true`, `intervalMs`, `lastCheckedAt: null`.
- `POST /api/monitor/stop` — updates the row to `active: false`.
- `POST /api/cache-state` — writes `{resourceId, state}` to `liveStateCache` (in-memory + Table Storage).

### Remediation
- `POST /api/remediate` — fetches baseline, strips VOLATILE, calls `armClient.resources.beginCreateOrUpdateAndWait()` (ARM PUT).
- `POST /api/remediate-request` — POSTs to `ALERT_LOGIC_APP_URL`. Logic App calls `sendAlert` Function. Returns immediately.
- `GET /api/remediate-decision?action=approve|reject&token=` — decodes token, either ARM PUT (approve) or saves live state as new baseline (reject). Returns HTML page.

### AI (all proxy to `aiOperations` Function)
- `POST /api/ai/explain` — plain-English explanation of the drift
- `POST /api/ai/severity` — AI severity re-classification (can only escalate)
- `POST /api/ai/recommend` — remediation recommendation
- `GET /api/ai/anomalies` — pattern detection across last 50 drift records

---

## Part 10: Key Design Decisions Explained Simply

**Why Blob + Table instead of a database?**
A database like Cosmos DB costs ~$25/month minimum even when idle. Blob Storage + Table Storage costs almost nothing when idle. The pattern is: Table = fast index for queries, Blob = full document storage. You query the Table to find which blobs you need, then fetch only those blobs.

**Why `global.io`?**
If Socket.IO were exported as a module, routes would need to import `app.js`, and `app.js` imports routes — circular dependency. `global.io` breaks the cycle cleanly.

**Why `adip-shared` as a local package?**
The Express API and the Function App both need to compute diffs and severity. If they had separate implementations, a bug fix in one wouldn't fix the other. The `file:../shared` reference means both use identical code, and the Function App deployment zip includes it automatically.

**Why `isSubmittedRef` instead of `isSubmitted` state in the socket handler?**
Socket.IO event handlers are created once and form a closure. If you use `isSubmitted` state directly, the handler always sees the value from when it was created (always `false`). A `useRef` always gives the current value because refs are mutable objects, not captured values.

**Why base64url for blob keys?**
ARM resource IDs contain `/` slashes. Blob Storage interprets slashes as folder separators. base64url encoding converts the entire resourceId to a flat string with no special characters, making it a safe, deterministic blob filename.

**Why `visibilityTimeout: 300` on queue messages?**
When you receive a queue message, it becomes invisible to other consumers for the timeout duration. If you don't delete it within that time, it reappears. `enrichWithDiff` makes 2–3 ARM API calls which can take several seconds. 300 seconds gives plenty of buffer before the message reappears and gets processed twice.

---

## Part 11: Dead Code & Known Issues

| # | What | Why it matters |
|---|---|---|
| 1 | `auth.js` exports SSO functions but `LoginPage.jsx` never imports it | SSO is documented but unreachable. To enable: install `@azure/msal-browser`, import `auth.js` in LoginPage, uncomment MSAL code. |
| 2 | `fetchDriftEvents` in `api.js` is defined but DashboardHome uses `fetchRecentChanges` instead | `fetchDriftEvents` queries `drift-records` (only baseline-compared drift). `fetchRecentChanges` queries `all-changes` (every ARM event). The dashboard intentionally shows all changes. |
| 3 | `VITE_API_BASE_URL` points to `172.10.1.109:3001` | This is a local network IP. Anyone else running the project needs to change this to `localhost:3001`. |
| 4 | Node 20 EOL | Azure Functions Node 20 reaches end-of-life April 2026. Should be upgraded to Node 22 or 24 in Function App settings. |
| 5 | Email approval token is unsigned | The token in Approve/Reject links is just base64url-encoded JSON. Anyone who intercepts the email link can approve/reject. Production fix: sign with HMAC-SHA256. |
| 6 | `liveStateCache` is in-memory + Table Storage | If Table Storage is unavailable, the cache is memory-only and lost on restart. Non-fatal but means first event after restart shows no diff. |

---

*ADIP-Explained.md — Plain-English Architecture Reference | Generated 2026-04-20*
