# ADIP — Low-Level Technical Documentation

## System Architecture Deep Dive

---

### 1. How does drift detection work end-to-end?

1. A user or automation modifies an Azure resource (Portal, CLI, Terraform, etc.)
2. Azure Resource Manager fires a `ResourceWriteSuccess` or `ResourceDeleteSuccess` event
3. Azure Event Grid receives the event and fans out to two subscribers:
   - **Storage Queue** (`resource-changes`) — for real-time dashboard feed
   - **Logic App** (`adip-logic-app`) — for drift analysis via Function App
4. The Express API **queue poller** (5s interval) dequeues messages:
   - Parses the event (base64 decode → JSON)
   - Deduplicates (100ms window)
   - Fetches live ARM config via `getResourceConfig()`
   - Compares against cached previous state
   - Computes field-level diff using `diffObjects()`
   - Classifies severity (deterministic rules)
   - Saves change record to Blob + Table Storage
   - Saves drift record if changes detected
   - Auto-saves genome snapshot
   - Emits `resourceChange` via Socket.IO to connected frontends
5. The frontend receives the event in real-time via `useDriftSocket` hook

---

### 2. How does the comparison engine work?

**Endpoint:** `POST /api/compare`

**Flow:**
```
Frontend sends: { subscriptionId, resourceGroupId, resourceId }
    ↓
Server fetches baseline from Blob Storage (baselines/{base64url(id)}.json)
    ↓
Server fetches live ARM config via Azure SDK (getResourceConfig)
    ↓
Both configs pass through strip() — removes VOLATILE fields:
  provisioningState, etag, changedTime, macAddress, ipAddress,
  dnsSettings, virtualMachine, primary, uniqueId, creationData, etc.
    ↓
diffObjects(stripped_baseline, stripped_live) computes:
  - modified fields (old → new value)
  - added fields (null → value)
  - removed fields (value → null)
  - array changes (matched by name, not position)
  - managed disks excluded entirely
    ↓
Suppression rules loaded from Table Storage — matching diffs filtered out
    ↓
classifySeverity(diffs) applies rules:
  - Critical: field deleted OR 3+ tag changes
  - High: networkAcls, accessPolicies, securityRules, sku, identity, encryption
  - Medium: >5 non-security fields changed
  - Low: 1-5 non-security changes
    ↓
Response: { differences[], severity, baselineState, liveState }
```

---

### 3. How does the deployment engine recreate infrastructure?

**File:** `services/deploymentEngine.js`

**Step 1 — Build Dependency Graph:**
```
For each resource, extract dependencies from:
  - VM → networkProfile.networkInterfaces[].id
  - NIC → ipConfigurations[].properties.subnet.id
  - NIC → networkSecurityGroup.id
  - VNet → subnets[].properties.networkSecurityGroup.id
  - VNet → subnets[].properties.routeTable.id
```

**Step 2 — Topological Sort:**
```
Resources sorted so no resource deploys before its dependencies.
Layer assignment:
  L1: Public IP, NSG (no dependencies)
  L2: Storage Account, VNet
  L3: NIC, SSH Key, Schedules
  L4: (reserved)
  L5: Virtual Machine
  L6: DevTestLab schedules (depend on VM)
```

**Step 3 — Sanitize Each Resource:**
```
Remove: provisioningState, vmId, resourceGuid, etag, systemData, timeCreated
VM-specific:
  - osDisk.createOption = 'FromImage' (was 'Attach')
  - delete osDisk.managedDisk (stale reference to old disk)
  - delete osDisk.name (Azure assigns new name)
  - delete osProfile.requireGuestProvisionSignal
Preserve: networkProfile.networkInterfaces[].id (NIC binding)
```

**Step 4 — Deploy Layer by Layer:**
```
For each resource (in sorted order):
  - Skip Microsoft.Compute/disks (VM creates its own)
  - Parse resource ID → extract provider, type, name
  - Resolve API version (static map or ARM provider lookup)
  - ARM PUT with retry (max 2 attempts, 2s/4s backoff)
  - On failure: mark as failed, add to failed set
  - Dependents of failed resources: marked "skipped"
```

**Step 5 — Delete Extra Resources:**
```
After deployment, compare live vs baseline:
  - Resources in live but NOT in baseline → ARM DELETE
  - Delete order: VM first → NIC → IP → NSG → VNet (reverse dependency)
  - Managed disks excluded from deletion
```

---

### 4. How does the approval ticket system work?

**Create ticket:** `POST /api/tickets`
```
1. Validate user has requestor/admin role (JWT)
2. Load org preferences (requiredApprovals: 1-5)
3. Check per-resource approval overrides
4. Create ticket entity in approvalTickets table
5. Notify all org members via notifications table
6. Emit Socket.IO event for real-time UI update
7. Start 48h timeout (escalation) / 96h auto-reject
```

**Approve:** `POST /api/tickets/:id/approve`
```
1. Validate user has approver/admin role (live table check, not JWT)
2. Increment approvalCount on ticket
3. If approvalCount >= requiredApprovals:
   - Call POST /api/remediate internally
   - Update ticket status to 'approved'
   - Notify all members
4. Else: notify that approval recorded, waiting for more
```

**Timeout handling:** (60s interval in app.js)
```
- Scan all tickets with status 'pending'
- If age > 48h: escalate (notify admins)
- If age > 96h: auto-reject
```

---

### 5. How does the ARM cache work?

**File:** `shared/armCache.js`

```
Singleton credential: DefaultAzureCredential (created once)
Client cache: Map<subscriptionId, ResourceManagementClient>
Response cache: Map<"sub|rg|resourceId", { data, timestamp }>
TTL: 30 seconds

Flow:
  getResourceConfig() called →
    getCached(sub, rg, id) → if hit and <30s old → return cached
    else → fetch from Azure ARM → setCache() → return fresh

Invalidation:
  After remediation → invalidateCache(sub, rg, id)
  Ensures next comparison sees fresh state
```

---

### 6. How does the diff engine handle arrays?

**File:** `shared/diff.js`

```
When comparing arrays:
  1. If items have .name or .id → match by name (not position)
     - Prevents false diffs from Azure returning resources in different order
     - For each matched pair: recurse into diffObjects()
     - Unmatched in live: reported as "added"
     - Unmatched in baseline: reported as "removed"
  2. Filter out Microsoft.Compute/disks entirely
     - Disk names change on every VM recreation
     - Comparing them is meaningless
  3. Generic arrays (no name/id): compare as sorted JSON strings
```

---

### 7. How does the volatile field stripping work?

**File:** `shared/constants.js` → VOLATILE array

```
Fields stripped BEFORE diff comparison:
  provisioningState, etag, changedTime, createdTime, lastModifiedAt,
  systemData, resourceGuid, _ts, _etag, _rid, _self,
  azureFilesIdentityBasedAuthentication,
  macAddress, primary, virtualMachine, internalDomainNameSuffix,
  ipAddress, dnsSettings,
  LastOwnershipUpdateTime, uniqueId, creationData, timeCreated,
  diskSizeBytes, diskState, tier

Why: These fields are Azure-assigned and change on every resource recreation.
     They don't represent meaningful configuration drift.
```

**Frontend also filters** (defense in depth):
```javascript
const VOLATILE_PATHS = ['macAddress', 'dnsSettings', 'internalDomainNameSuffix',
  'ipAddress', 'primary', 'virtualMachine', 'LastOwnershipUpdateTime',
  'uniqueId', 'creationData', 'timeCreated', 'diskSizeBytes', 'diskState', 'tier']

// Also filters: array-changed/added/removed types, disk-related paths
```

---

### 8. How does authentication work?

**Login flow:**
```
POST /api/auth/login { email, password }
  → Search orgAdmins table (full scan by email)
  → If not found: search orgMembers table
  → Compare password:
    1. Try bcrypt.compare(password, hash)
    2. If bcrypt fails (legacy plaintext): direct string compare
    3. If plaintext matches: auto-migrate to bcrypt hash
  → Generate JWT: { userId, orgId, role, email, name } signed with JWT_SECRET
  → Return token + user info
```

**Token validation (authMiddleware):**
```
Every protected request:
  → Extract Bearer token from Authorization header
  → jwt.verify(token, SECRET)
  → Attach decoded payload to req.user
  → If invalid/expired: 401
```

**Role hierarchy:**
```
admin     → full access (create tickets, approve, remediate, manage org)
approver  → can approve tickets, view all data
requestor → can create tickets, view own data
```

---

### 9. How does the genome (snapshot) system work?

**Auto-save triggers:**
```
1. Every change event (queue poller) → saves current live state
2. Daily at 7 PM (genomeScheduler) → saves all monitored resources
3. After remediation → saves post-remediation state
```

**Storage:**
```
Container: baseline-genome
Key format: {timestamp}_{base64url(resourceId)}.json
Index: genomeIndex table (partitionKey=sub, rowKey=base64url(blobKey))
```

**Retention:**
```
- expiresAt field on each snapshot
- Daily cleanup removes expired snapshots
- Default retention: 30 days (configurable per org)
```

**Rollback:**
```
POST /api/genome/rollback { snapshotId }
  → Load snapshot from blob
  → ARM PUT to revert resource to snapshot state
  → Save new genome snapshot (post-rollback)
```

---

### 10. How does the notification system work?

**Storage:** `notifications` table in Azure Table Storage

**Creation:**
```
notifyAllMembers(orgId, message, type):
  → Query orgAdmins table (all for orgId)
  → Query orgMembers table (all for orgId)
  → Create notification entity for EACH member
  → Emit Socket.IO event for real-time bell update
```

**Delivery:**
```
Frontend polls GET /api/org/notifications every 15 seconds
  → Returns unread notifications for current user
  → Red badge shows unread count
  → NotificationPanel shows 3 tabs: Approvals, Activity, My Requests
```

---

### 11. How does the circuit breaker protect external calls?

**File:** `shared/circuitBreaker.js`

```
States: CLOSED → OPEN → HALF_OPEN → CLOSED

CLOSED (normal):
  - All calls pass through
  - On failure: increment failure counter
  - If failures >= threshold: transition to OPEN

OPEN (blocking):
  - All calls immediately rejected with error
  - After resetTimeout: transition to HALF_OPEN

HALF_OPEN (testing):
  - Next call passes through
  - If success: reset to CLOSED
  - If failure: back to OPEN

Configured breakers:
  openai: threshold=3, reset=60s
  arm:    threshold=10, reset=30s
```

---

### 12. How does idempotency prevent double execution?

**File:** `shared/idempotency.js`

```
Before remediation:
  1. Extract idempotency key (X-Idempotency-Key header OR ticketId)
  2. Check idempotencyKeys table: does this key exist?
  3. If exists and <24h old: return 409 Conflict
  4. If not: proceed with remediation
  5. After success: markExecuted(key) → write to table

This prevents:
  - Double-click on remediate button
  - Retry storms from approval system
  - Duplicate queue messages triggering same remediation
```

---

### 13. How does the frontend filter volatile diffs?

**File:** `src/pages/ComparisonPage.jsx`

```javascript
const filterVolatile = (diffs) => diffs.filter(d => {
  const combined = path + ' ' + JSON.stringify(oldValue) + ' ' + JSON.stringify(newValue)

  // Skip managed disk diffs (name changes on recreation)
  if (combined.includes('Microsoft.Compute/disks') ||
      combined.includes('OsDisk') || combined.includes('_disk')) return false

  // Skip array positional changes
  if (d.type === 'array-changed' || d.type === 'array-added' ||
      d.type === 'array-removed') return false

  // Skip volatile field paths
  return !VOLATILE_PATHS.some(v => combined.includes(v))
})
```

Applied at 3 points:
1. Server response (`result.differences`)
2. Client-side recalculation (5s poll)
3. Post-remediation recompare

---

### 14. How does the CTO vs Dev view work?

**Context:** `ViewModeContext.jsx` — stores `viewMode: 'cto' | 'dev'`

**Toggle:** `ViewModeToggle.jsx` in NavBar

**Per-page behavior:**

| Page | CTO View | Dev View |
|------|----------|----------|
| DashboardHome | English sentences with changeSummary | Raw event table |
| DriftScanner | Expandable resource accordion (all properties) | JSON tree + live feed |
| ComparisonPage | AI Infrastructure Summary (cards) | Field-level diff table |
| GenomePage | Readable snapshot info | JSON tree |

---

### 15. How does multi-scope selection work?

**Components:** `ScopeSelector.jsx` + `MultiSelectDropdown.jsx`

```
Flow:
  1. User selects subscription (single select)
  2. Resource groups load → multi-select checkboxes
  3. Resources load for selected RGs → multi-select checkboxes
  4. Selected scopes stored in DashboardContext (sessionStorage)
  5. useDriftSocket subscribes to Socket.IO rooms for each scope
  6. Events filtered client-side by scope match
```

**Scope format:**
```javascript
{ subscriptionId, resourceGroupId, resourceId }
// resourceId = null means RG-level scope
```

---

### 16. How does the HMAC approval token work?

**Generation (sendAlert Function App):**
```javascript
const payload = { resourceId, resourceGroup, subscriptionId, exp: now + 48h }
const signature = HMAC-SHA256(APPROVAL_SECRET, JSON.stringify(payload))
const token = base64url({ ...payload, signature })
// Embedded in email: /api/remediate-decision?action=approve&token={token}
```

**Verification (remediateDecision.js):**
```javascript
const { signature, ...payload } = JSON.parse(base64url_decode(token))
const expected = HMAC-SHA256(APPROVAL_SECRET, JSON.stringify(payload))
timingSafeEqual(signature, expected) // prevents timing attacks
if (payload.exp < Date.now()) throw 'expired'
```

---

### 17. How does the health endpoint work?

**Endpoint:** `GET /api/health`

```json
{
  "status": "healthy | degraded",
  "api": "healthy",
  "uptime": 3600,
  "timestamp": "2026-05-08T10:00:00Z",
  "storage": "healthy | unhealthy",
  "ai": { "openai": { "state": "CLOSED", "failures": 0 }, "cacheSize": 12 },
  "circuitBreakers": {
    "openai": { "state": "CLOSED", "failures": 0 },
    "arm": { "state": "CLOSED", "failures": 0 }
  }
}
```

Returns 503 if storage is unhealthy (Container Apps marks instance as not ready).

---

### 18. How does code splitting work in the frontend?

**File:** `App.jsx`

```javascript
const DriftScanner = lazy(() => import('./pages/DriftScanner'))
const ComparisonPage = lazy(() => import('./pages/ComparisonPage'))
// ... all pages lazy-loaded

<Suspense fallback={<PageLoader />}>
  <Routes>...</Routes>
</Suspense>
```

**Result:** 11 separate JS chunks. Main bundle: 171KB. Pages load on-demand.

---

### 19. How does the queue poller categorize changes without AI?

**Before (expensive):** OpenAI call per event (~500ms, $0.01 each)

**After (deterministic):**
```javascript
function categorizeChangeLocal(paths) {
  const joined = paths.join(' ').toLowerCase()
  if (joined.includes('networkacl') || joined.includes('securityrule')) return 'Security'
  if (joined.includes('sku') || joined.includes('capacity')) return 'Scaling'
  if (joined.includes('tag')) return 'Tags'
  if (joined.includes('identity') || joined.includes('rbac')) return 'Identity'
  if (joined.includes('network') || joined.includes('subnet')) return 'Networking'
  if (joined.includes('encryption') || joined.includes('key')) return 'Encryption'
  return 'Configuration'
}
```

Zero cost, <1ms, same accuracy for categorization purposes.

---

### 20. What tables exist in Azure Table Storage?

| Table | Partition Key | Purpose |
|-------|--------------|---------|
| organizations | orgId | Org metadata, invite codes, settings |
| orgAdmins | orgId | Admin users (email, passwordHash, role) |
| orgMembers | orgId | Member users |
| changesIndex | subscriptionId | Change event index (all events) |
| driftIndex | subscriptionId | Drift records (only when drift detected) |
| genomeIndex | subscriptionId | Genome snapshot metadata |
| genomeDailyIndex | subscriptionId | Daily genome snapshots |
| genomePreDeletionIndex | subscriptionId | Pre-deletion snapshots |
| monitorSessions | subscriptionId | Active monitoring sessions |
| suppressionRules | subscriptionId | Drift suppression rules |
| remediationSchedules | subscriptionId | Scheduled maintenance windows |
| policyAssignments | subscriptionId | Azure Policy records |
| remediationSavings | subscriptionId | Cost savings from remediations |
| userPreferences | username | Per-user settings |
| notifications | orgId | User notifications |
| approvalTickets | orgId | Remediation approval tickets |
| approvalOverrides | orgId | Per-resource approval count overrides |
| otpCodes | email | OTP verification codes |
| liveStateCache | subscriptionId | Cached live ARM state |
| idempotencyKeys | 'idem' | Idempotency deduplication |
| remediationAudit | ticketId | Remediation audit trail |

---

### 21. What blob containers exist?

| Container | Key Format | Content |
|-----------|-----------|---------|
| baselines | `{base64url(resourceId)}.json` | Golden baseline configs |
| drift-records | `{timestamp}_{base64url(resourceId)}.json` | Drift detection records |
| all-changes | `{timestamp}_{base64url(resourceId)}.json` | All change events |
| baseline-genome | `{timestamp}_{base64url(resourceId)}.json` | Versioned snapshots |
| genome-daily | `daily_{date}_{base64url(rg)}.json` | Daily genome snapshots |
| genome-pre-deletion | `{timestamp}_{base64url(resourceId)}.json` | Pre-deletion backups |
| drift-reports | `{reportId}.json` | Generated PDF reports |

---

### 22. What are the API rate limits?

| Endpoint Group | Limit | Window |
|---|---|---|
| Auth (login, OTP, create-org) | 20 requests | 15 minutes |
| Remediation (/remediate, /recover) | 5 requests | 1 minute |
| General API (all other) | 100 requests | 1 minute |

---

### 23. What environment variables are required?

**Critical (app won't function without):**
- `STORAGE_CONNECTION_STRING` — Azure Storage (Blob + Queue + Table)
- `AZURE_SUBSCRIPTION_ID` — Target subscription

**Security:**
- `JWT_SECRET` — JWT signing (required in production)
- `APPROVAL_SECRET` — HMAC token signing
- `CORS_ORIGIN` — Allowed frontend origin

**Azure Services:**
- `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_KEY` — AI features
- `COMMS_CONNECTION_STRING` + `SENDER_ADDRESS` — Email alerts
- `AZURE_OPENAI_DEPLOYMENT` — Model deployment name

**Optional (production):**
- `KEY_VAULT_URL` — Azure Key Vault for secrets
- `AZURE_AD_CLIENT_ID` — MSAL enterprise SSO
- `APPLICATIONINSIGHTS_CONNECTION_STRING` — Telemetry
- `ENABLE_AUTO_REMEDIATION` — Feature flag (default: true)
- `REMEDIATION_MAX_RETRIES` — Retry count (default: 2)

---

*ADIP v4.0 — Low-Level Technical Documentation*
