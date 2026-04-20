# ADIP — Technical Defense Document
## Azure Drift Intelligence Platform

---

## 1. Features Implemented

| # | Feature | What it does |
|---|---|---|
| 1 | Real-time change feed | Every ARM resource change appears in the Live Activity Feed within seconds |
| 2 | Field-level diff | Shows exactly which field changed, old value vs new value, who changed it |
| 3 | Rule-based severity classification | Classifies every drift as Critical / High / Medium / Low based on changed fields |
| 4 | AI security analysis | Azure OpenAI explains drift in plain English and can escalate severity with context |
| 5 | AI anomaly detection | Analyses last 50 drift records for off-hours activity, repeated actors, unusual patterns |
| 6 | AI remediation recommendation | Explains what reverting to baseline will do before the user confirms |
| 7 | Auto-remediation (low severity) | Instantly reverts resource to golden baseline via ARM PUT — no approval needed |
| 8 | Approval-gated remediation (high/critical) | Sends HTML email with Approve/Reject buttons; admin decision triggers ARM PUT or baseline update |
| 9 | Email alerts | HTML drift alert email via Azure Communication Services with diff table |
| 10 | Golden baseline management | Promote any config snapshot as the reference state; upload ARM template or raw JSON |
| 11 | Configuration Genome | Full versioned snapshot history — auto-saved on every change, manual save with labels, rollback to any point |
| 12 | Azure Policy compliance | Shows policy compliance state alongside drift data |
| 13 | Persistent change history | Every ARM event written to blob storage by a Function — survives system restarts |
| 14 | Dashboard KPIs | Total changes all-time, drifted resources, resource groups, subscriptions |
| 15 | 24-hour bar chart | Hourly drift volume for today |
| 16 | Recent Drift Events table | Last 24h changes from blob storage with filters: time, user, resource group, change type |
| 17 | Drift Scanner | Live resource config viewer, JSON tree, policy compliance, AI anomalies |
| 18 | Comparison Page | Side-by-side baseline vs live diff with remediation actions |
| 19 | Genome Page | Snapshot timeline with promote and rollback |
| 20 | Demo mode | Falls back to static data when backend is unreachable |
| 21 | Subscription scan | Timer Function scans all resources with baselines every hour |
| 22 | Monitor sessions | Timer Function checks active monitor sessions every minute |

---

## 2. Services Used, Why, and Alternatives

### 2.1 Azure Event Grid (System Topic)

**Used for:** Receiving ARM resource change events (ResourceWriteSuccess, ResourceDeleteSuccess) at subscription level.

**Why this service:**
- Native ARM integration — no polling, no SDK calls to detect changes. ARM publishes events automatically.
- Fan-out to multiple subscribers (queue, Logic App, Function) from a single event source.
- Guaranteed delivery with retry policy (up to 24 hours).
- System topics are free for ARM events; no custom topic publishing cost.

**Alternatives considered:**

| Alternative | Why not used |
|---|---|
| Azure Monitor Activity Log + Diagnostic Settings | Adds 1–5 minute latency. Not real-time. Requires Log Analytics workspace (cost). |
| ARM polling (periodic GET on all resources) | O(n) API calls every interval. Misses changes between polls. Rate-limited by ARM. |
| Azure Monitor Alerts | Designed for metric/log alerts, not config change detection. No field-level diff. |
| Azure Resource Graph change tracking | Read-only query API. Does not push events. Requires polling. |

---

### 2.2 Azure Storage Queue

**Used for:** Buffering Event Grid events for the queue poller → Socket.IO live feed.

**Why this service:**
- At-least-once delivery with visibility timeout — message stays in queue until explicitly deleted.
- Simple integration with Event Grid as a native subscriber type.
- Extremely low cost (fractions of a cent per million messages).
- Decouples event ingestion from processing — Express can restart without losing events.

**Alternatives considered:**

| Alternative | Why not used |
|---|---|
| Azure Service Bus Queue | Overkill for this use case. Adds cost. Sessions, dead-letter, transactions not needed. |
| Azure Service Bus Topic | Pub/sub with multiple subscribers — Event Grid already handles fan-out. Redundant. |
| Azure Event Hubs | Designed for high-throughput telemetry (millions/sec). Overkill. Adds cost and complexity. |
| Direct WebHook to Express | Express must be publicly reachable. Loses events if Express is down. No retry. |

---

### 2.3 Azure Blob Storage

**Used for:** Storing baselines, drift records, genome snapshots, and all-changes history as JSON documents.

**Why this service:**
- Schema-free JSON storage — resource configs vary wildly in structure. No schema migration needed.
- Immutable audit trail — blobs are append-only by design (new key per record).
- Extremely low cost for JSON documents (fractions of a cent per GB).
- Already required for queue storage — same account, no extra resource.
- Blob names encode timestamp + resourceId — enables time-range filtering without a database.

**Alternatives considered:**

| Alternative | Why not used |
|---|---|
| Azure Cosmos DB | Significantly higher cost. SQL/NoSQL query capability not needed for this access pattern. |
| Azure SQL Database | Requires schema. Resource configs are deeply nested JSON — poor fit for relational model. |
| Azure Table Storage (for full records) | 1 MB entity limit. Resource configs can exceed this. Used only for lightweight indexes. |
| Azure Data Lake Storage | Designed for analytics workloads. No direct SDK for document read/write patterns. |

---

### 2.4 Azure Table Storage

**Used for:** Lightweight indexes (driftIndex, changesIndex, genomeIndex, liveStateCache, monitorSessions, userPreferences) to avoid full blob container scans.

**Why this service:**
- O(1) lookup by PartitionKey + RowKey — avoids scanning all blobs to find records for a subscription.
- Same storage account as blobs — no extra resource, no extra cost.
- Supports OData filter queries (PartitionKey, date range, resourceGroup).
- Serverless — no provisioning, no connection pool management.

**Alternatives considered:**

| Alternative | Why not used |
|---|---|
| Azure Cosmos DB Table API | Drop-in compatible but costs more. No benefit at this scale. |
| Redis Cache (Azure Cache for Redis) | In-memory only — data lost on restart. Adds cost. Overkill for index queries. |
| Azure SQL | Requires schema, connection pool, provisioned compute. Overkill for key-value index. |

---

### 2.5 Azure Functions (Consumption Plan)

**Used for:** detectDrift (drift detection + email), recordChange (permanent change logging), monitorResources (timer), scanSubscription (timer), sendAlert (email), aiOperations (AI features), seedBaseline.

**Why this service:**
- Event-driven — scales to zero when idle. No cost when no changes are happening.
- HTTP trigger integrates directly with Event Grid WebHook subscription.
- Timer trigger replaces in-memory setInterval — survives restarts, works even when Express is down.
- Consumption plan — pay only per execution. Ideal for infrequent drift events.
- Isolates heavy operations (ARM fetch, diff, email) from the Express API request cycle.

**Alternatives considered:**

| Alternative | Why not used |
|---|---|
| Azure Container Apps | Overkill. Requires container image, registry, more configuration. Higher baseline cost. |
| Azure App Service (always-on) | Costs money even when idle. Functions scale to zero. |
| Logic Apps (for drift detection) | Low-code, but limited ability to run custom diff logic, call npm packages, or do field-level comparison. |
| Running everything in Express | Express must be always-on and publicly reachable. Single point of failure. No scale-out. |

---

### 2.6 Azure Logic Apps

**Used for:** Two workflows — (1) routing Event Grid events to detectDrift Function with noise filtering, (2) forwarding drift alerts from Function to Express `/alert/email`.

**Why this service:**
- Visual workflow — easy to add conditions (filter noise: skip read/list operations) without code.
- Native Event Grid connector — no custom WebHook validation code needed in the workflow.
- Built-in retry and error handling.
- Separates orchestration logic from application code.

**Alternatives considered:**

| Alternative | Why not used |
|---|---|
| Direct Event Grid → Function | Used for recordChange. For detectDrift, Logic App adds noise filtering that would otherwise be in Function code. |
| Azure Durable Functions | Overkill for a simple filter-and-forward pattern. |
| Azure API Management | Designed for API gateway, not event routing. |

---

### 2.7 Azure Communication Services (Email)

**Used for:** Sending HTML drift alert emails with Approve/Reject buttons and field-level diff tables.

**Why this service:**
- Managed email sending — no SMTP server to maintain.
- Supports HTML email with custom templates.
- Integrates with Azure AD domain verification.
- Pay-per-email pricing — very low cost for alert volumes.

**Alternatives considered:**

| Alternative | Why not used |
|---|---|
| SendGrid | Third-party dependency. Requires separate account. ACS is native Azure. |
| Azure Logic Apps email connector | Uses Office 365 connector — requires user OAuth token, not suitable for system alerts. |
| SMTP via Outlook/Gmail | Requires credential management, rate limits, not production-grade. |
| Azure Notification Hubs | Designed for push notifications to mobile apps, not email. |

---

### 2.8 Azure OpenAI (GPT-4o)

**Used for:** Four AI features — explain drift in plain English, re-classify severity with context, recommend remediation action, detect anomalies across recent drift history.

**Why this service:**
- Data residency — stays within Azure tenant. No data sent to external OpenAI endpoints.
- Same Azure billing — no separate OpenAI account.
- GPT-4o deployment — strong reasoning for security context analysis.
- Low temperature (0.3) — consistent, deterministic outputs for severity classification.

**Alternatives considered:**

| Alternative | Why not used |
|---|---|
| OpenAI API (external) | Data leaves Azure tenant. Separate billing. Compliance concern for infrastructure data. |
| Azure AI Language (text analytics) | Pre-built models for sentiment/NER — not suitable for security reasoning and severity classification. |
| Rule-only classification (no AI) | Already implemented as the base layer. AI adds context-awareness that rules cannot. |
| Azure Machine Learning custom model | Requires training data, MLOps pipeline. Overkill vs. prompt engineering on GPT-4o. |

---

### 2.9 Azure Resource Manager (ARM) SDK

**Used for:** Fetching live resource configurations, applying remediation (ARM PUT), reading resource metadata.

**Why this service:**
- The only authoritative source of truth for Azure resource configuration.
- DefaultAzureCredential — works with Azure CLI locally, Managed Identity in cloud. No credential management.
- ARM PUT is the correct way to revert resource state — same as Terraform apply or Portal edit.

**Alternatives considered:**

| Alternative | Why not used |
|---|---|
| Azure Resource Graph | Read-only. Cannot write/revert. Query latency (eventual consistency). |
| Azure REST API (raw HTTP) | ARM SDK wraps this. No benefit to using raw HTTP. |
| Terraform / Bicep | Requires state file management. Not suitable for runtime remediation triggered by a button click. |

---

### 2.10 Azure Policy Insights SDK

**Used for:** Displaying policy compliance state alongside drift data on the Comparison Page.

**Why this service:**
- Native API for querying compliance state per resource.
- Read-only — no risk of modifying policy assignments.
- Adds compliance context to drift analysis without requiring a separate compliance tool.

**Alternatives considered:**

| Alternative | Why not used |
|---|---|
| Azure Security Center / Defender for Cloud API | Broader security posture data, but heavier API, requires Defender plan. |
| Manual policy check in UI | Would require users to navigate to Azure Portal separately. |

---

### 2.11 Node.js + Express

**Used for:** REST API server, Socket.IO real-time events, queue poller, business logic orchestration.

**Why this service:**
- JavaScript throughout — same language as React frontend and Azure Functions. Single skill set.
- Socket.IO — mature, battle-tested real-time library. Works with Express natively.
- Rich Azure SDK ecosystem for Node.js — all Azure SDKs have first-class Node support.
- Fast iteration — no compile step.

**Alternatives considered:**

| Alternative | Why not used |
|---|---|
| Azure API Management + Functions only | No persistent WebSocket support. Socket.IO requires a long-lived server. |
| Python (FastAPI) | Different language from frontend. Azure SDKs for Python are less mature for some services. |
| .NET (ASP.NET Core) | Heavier stack. Compile step. Team skill set is JavaScript. |
| Azure SignalR Service | Could replace Socket.IO. Adds cost. Socket.IO on Express is sufficient for this scale. |

---

### 2.12 React + Vite

**Used for:** Frontend SPA — dashboard, drift scanner, comparison, genome pages.

**Why this service:**
- Vite — fastest dev server and build tool for React. HMR in milliseconds.
- React — component model fits the dashboard's complex state (filters, real-time feed, JSON tree).
- React Router v6 — client-side navigation without page reloads.
- Recharts — lightweight charting library, no heavy dependencies.

**Alternatives considered:**

| Alternative | Why not used |
|---|---|
| Next.js | SSR not needed — all data is user-specific and real-time. Adds complexity. |
| Angular | Heavier framework. Longer bootstrap time. Team preference for React. |
| Vue.js | Viable alternative. React chosen for ecosystem size and team familiarity. |
| Azure Static Web Apps | Deployment target, not a framework. Could be used for hosting. |

---

## 3. Architecture Approach

### Approach used: Event-driven fan-out with dual processing paths

```
ARM Change
    │
    ▼
Event Grid System Topic
    │
    ├── Storage Queue ──► Queue Poller ──► Socket.IO ──► Live Feed (UI)
    │
    ├── Logic App ──► detectDrift Function ──► Diff + Severity + Email
    │
    └── recordChange Function ──► all-changes Blob + changesIndex Table
```

**Why this approach:**

1. **Separation of concerns** — real-time display (queue path), drift analysis (Logic App path), and permanent audit log (recordChange path) are independent. Failure in one does not affect others.

2. **Resilience** — the queue buffers events if Express is down. The Function writes to blob even if Express is unreachable. No single point of failure.

3. **Scale to zero** — Functions on Consumption plan cost nothing when idle. The queue poller only runs when Express is running.

4. **Persistent history independent of uptime** — recordChange Function writes directly to blob storage. The 24h change history is always available even if the system was offline for hours.

5. **No polling** — ARM changes are pushed via Event Grid. No periodic ARM API calls. No rate limit risk.

### Alternative approaches considered:

| Approach | Why not used |
|---|---|
| Single path: Event Grid → Function → everything | Creates a monolithic Function. Tight coupling between real-time display and drift analysis. Harder to maintain. |
| Polling-only (periodic ARM scan) | Misses changes between polls. High ARM API call volume. Latency proportional to poll interval. |
| Azure Monitor + Log Analytics | 1–5 minute latency. Requires Log Analytics workspace (cost). No field-level diff capability. |
| Terraform state drift detection | Requires Terraform state file. Only works for Terraform-managed resources. Not real-time. |
| Azure Automation + Runbooks | PowerShell-based. No real-time eventing. Harder to integrate with React frontend. |
| Full serverless (no Express) | Socket.IO requires a persistent server. Azure SignalR Service could replace it but adds cost and complexity. |

---

## 4. Data Flow Detail

### Change detection flow
1. User/automation changes Azure resource in Portal or CLI
2. ARM fires `ResourceWriteSuccess` to Event Grid system topic
3. Event Grid delivers to three subscribers simultaneously:
   - **Storage Queue** → Express queue poller (5s interval) → diff against cached state → Socket.IO → Live Activity Feed
   - **Logic App** → noise filter (skip reads/lists) → detectDrift Function → fetch live ARM config → diff against baseline blob → classify severity → save drift record → send email alert → POST to Express `/internal/drift-event` → Socket.IO
   - **recordChange Function** → write to `all-changes` blob + `changesIndex` Table (permanent audit log)

### Remediation flow
1. User clicks Remediate on Comparison Page
2. Express checks severity:
   - Low: immediate ARM PUT with baseline config → done
   - Medium/High/Critical: generate HMAC token → send HTML email with Approve/Reject links
3. Admin clicks Approve → Express fetches baseline → ARM PUT → resource reverted
4. Admin clicks Reject → current live state promoted as new baseline

### Genome (versioned snapshots) flow
1. Queue poller auto-saves genome snapshot on every detected change
2. User can manually save with a label
3. User can promote any snapshot to golden baseline
4. User can rollback resource to any snapshot via ARM PUT

---

## 5. Potential Questions and Answers

### Architecture & Design

**Q: Why use both a Logic App and a direct Event Grid → Function subscription? Isn't that redundant?**

They serve different purposes. The Logic App path handles drift detection — it adds noise filtering (skip read/list operations) and calls detectDrift which does the heavy work (ARM fetch, diff, email). The direct recordChange subscription is a lightweight audit logger — it just writes the raw event to blob storage. Combining them would create a monolithic Function that does too much.

---

**Q: Why not use Azure Monitor Activity Log instead of Event Grid?**

Activity Log has 1–5 minute latency and requires a Log Analytics workspace. Event Grid delivers in under 30 seconds with no additional infrastructure. For real-time drift detection, latency matters — a security-sensitive change (firewall rule deletion) should trigger an alert in seconds, not minutes.

---

**Q: Why store configs as JSON blobs instead of a database?**

Azure resource configurations are deeply nested, schema-less JSON objects. A storage account config has different fields than a VM config or a Key Vault config. A relational database would require either a single `jsonb` column (losing query capability) or a complex schema that changes every time Azure adds a new resource type. Blob storage stores the exact ARM response with no transformation, no schema migration, and no data loss.

---

**Q: Why use Table Storage for indexes instead of Cosmos DB?**

Table Storage is sufficient for the access patterns used: lookup by PartitionKey (subscriptionId) + optional filter on resourceGroup, severity, or date. Cosmos DB would add cost with no benefit at this scale. The same storage account is already used for blobs and queues — no extra resource needed.

---

**Q: What happens if the recordChange Function is down when a change occurs?**

Event Grid retries delivery for up to 24 hours with exponential backoff. If the Function recovers within 24 hours, all missed events will be delivered. If it stays down longer, those events are lost from the permanent log (though they may still appear in the queue path for the live feed).

---

**Q: Why is the Express API not deployed to Azure App Service?**

It is running locally in the current demo environment. The architecture supports deployment to App Service — `EXPRESS_API_URL` and `EXPRESS_PUBLIC_URL` environment variables are designed to be updated to the App Service URL. The email approval links and Function callbacks use these variables. Deployment to App Service is a configuration change, not a code change.

---

**Q: Why use Socket.IO instead of Azure SignalR Service?**

Socket.IO on Express is sufficient for the expected user count (small team monitoring their Azure subscription). Azure SignalR Service would add cost and require changes to the connection management code. The architecture can be migrated to SignalR Service by replacing the Socket.IO server with the SignalR SDK — the frontend client code would change minimally.

---

**Q: How does the system handle duplicate events from Event Grid?**

Event Grid guarantees at-least-once delivery, meaning duplicates are possible. The frontend deduplicates by `eventId` in the `addEvent` function. The queue poller processes messages sequentially (not in parallel) to avoid race conditions on the state cache. The `changesIndex` Table uses `upsertEntity` (Replace mode) — duplicate events with the same blob key overwrite rather than create duplicate entries.

---

### Security

**Q: The Express API has no authentication on `/api/*` endpoints. Is this a security risk?**

Yes, and it is documented as a known limitation. In the current demo, the API is localhost-only. For production, JWT middleware should be added after implementing MSAL SSO. The `VITE_AZURE_CLIENT_ID` environment variable and `auth.js` service are already wired up for MSAL — installing `@azure/msal-browser` and uncommenting the MSAL code enables SSO.

---

**Q: The email approval token is not signed. Can it be forged?**

Yes, and it is documented as a known limitation. The token is base64url-encoded JSON containing the resourceId and action. For production, it should be signed with HMAC-SHA256 using a secret key stored in Azure Key Vault. The current implementation is acceptable for a demo/internal tool where email access is already controlled.

---

**Q: How are Azure credentials managed?**

`DefaultAzureCredential` is used throughout. Locally, it uses the Azure CLI token (`az login`). In Azure (Functions, App Service), it uses Managed Identity — no credentials stored in code or environment variables. Storage account access uses a connection string (key-based) stored in environment variables, which is acceptable for a demo. For production, Managed Identity with RBAC on the storage account is the recommended approach.

---

**Q: CORS allows all origins. Is this a risk?**

Yes, documented as a known limitation. For production, CORS should be restricted to the frontend domain. The current setting is appropriate for local development where the frontend and backend run on different ports.

---

### Scalability & Cost

**Q: What is the estimated monthly cost of this architecture?**

At low usage (small team, one Azure subscription monitored):
- Azure Functions Consumption: ~$0 (1 million free executions/month)
- Azure Storage (blobs + queues + tables): ~$1–2/month
- Event Grid: ~$0 (system topic ARM events are free)
- Azure Communication Services: ~$0.0025/email
- Azure OpenAI: ~$0.01–0.10/query depending on token count
- Logic Apps: ~$0.000025/action execution

Total: under $5/month for a small team.

---

**Q: How does the system scale if monitoring hundreds of subscriptions?**

The current architecture uses a single Event Grid system topic per subscription. For multiple subscriptions, each would need its own system topic and set of subscriptions. The Express API and Functions are stateless — they scale horizontally. The main bottleneck would be the queue poller (single-threaded by design to avoid race conditions) — this could be replaced with multiple competing consumers using Service Bus sessions.

---

**Q: Blob listing is O(n) for drift history. How would you fix this at scale?**

The Table Storage index already solves this — `getDriftHistory` queries the `driftIndex` table first (O(log n) by PartitionKey) and only fetches the matching blobs. The O(n) fallback (`_scanDriftHistory`) is only used if Table Storage is unavailable. At large scale, Azure Cognitive Search could be added on top of the blob container for full-text search across drift records.

---

### Reliability & Operations

**Q: What happens if the Express API restarts? Is state lost?**

The `liveStateCache` (used for diffing queue events) is persisted to Azure Table Storage (`liveStateCache` table) and loaded back on restart. The queue poller resumes from where it left off — messages stay in the queue until processed. Drift records, baselines, and genome snapshots are in blob storage — fully persistent. Monitor sessions are stored in the `monitorSessions` Table — the `monitorResources` Timer Function checks them every minute regardless of Express uptime.

---

**Q: What happens if the detectDrift Function fails mid-execution?**

The Logic App has built-in retry policy. If the Function returns a non-2xx response, the Logic App retries. The Function itself is idempotent for drift record writes — it uses a timestamp-based blob key, so a retry creates a new record rather than overwriting. Email sending is not idempotent (could send duplicate alerts on retry), but this is acceptable for a demo.

---

**Q: How do you know a baseline is still valid after a legitimate change?**

The system does not automatically update baselines. A legitimate change requires a human decision: either (1) click Reject on the remediation email (which promotes the current live state as the new baseline), or (2) manually promote a genome snapshot. This is intentional — the system treats all deviations as drift until a human approves them. This is the correct behavior for a compliance and security tool.

---

**Q: Why is the Function App on Node 20 which reaches EOL in April 2026?**

This is documented as a known limitation. The fix is to update the Node version in Azure Function App settings from Node 20 to Node 22 or 24. No code changes are required — the Azure Functions v4 runtime supports Node 22+.

---

### Approach Justification

**Q: Why build a custom drift detection system instead of using Azure Policy or Defender for Cloud?**

Azure Policy enforces rules at deployment time and flags non-compliant resources, but it does not show field-level diffs, does not track who made a change, does not store historical snapshots, and does not support one-click revert to a specific previous state. Defender for Cloud provides security recommendations but is not a configuration versioning system. ADIP fills the gap between "something changed" (Event Grid) and "here is exactly what changed, who changed it, how severe it is, and how to revert it" — with a full audit trail.

---

**Q: Why not use Terraform or Pulumi for drift detection?**

Terraform drift detection (`terraform plan`) only works for resources managed by that specific Terraform state file. Resources created via Portal, CLI, ARM templates, or other tools are invisible to Terraform. ADIP monitors all resources in a subscription regardless of how they were created. Additionally, Terraform requires running a plan command — it is not event-driven and cannot send real-time alerts.

---

**Q: Why use a Logic App for noise filtering instead of doing it in the Function?**

The Logic App provides a visual, auditable workflow that non-developers can inspect and modify. The noise filtering logic (skip read/list operations, skip failed operations, skip deployment resources) is business logic that may need adjustment — having it in a Logic App makes it accessible without a code deployment. The Function focuses on the technical work (ARM fetch, diff, email).

---

*ADIP v2.0 — CloudThat × Microsoft*
