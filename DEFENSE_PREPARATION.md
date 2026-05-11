# ADIP — Defense & Viva Preparation Guide

---

## PART 1: PROJECT UNDERSTANDING SUMMARY

### What ADIP Does (30-second pitch)
ADIP continuously monitors Azure infrastructure configurations, detects any deviation from a stored golden baseline, classifies severity, notifies administrators, and enables dependency-aware auto-remediation — including full VM stack reconstruction from snapshots. It's an autonomous infrastructure governance platform with AI-assisted analysis and enterprise approval workflows.

### Core Problem Solved
When teams manage Azure infrastructure, configurations drift — someone changes a firewall rule, modifies a tag, adjusts an SKU. Without tracking, environments become inconsistent, security degrades, and compliance is hard to prove. ADIP treats every Azure resource configuration as versioned state and enforces desired-state compliance.

### Architecture in One Paragraph
React SPA connects via REST + Socket.IO to a Node.js Express API. Azure Event Grid captures ARM resource changes → Storage Queue → Express queue poller processes events in real-time. The system diffs live ARM state against stored baselines, classifies severity, and either auto-remediates (with approval) or alerts. A dependency-aware deployment engine can reconstruct entire VM stacks. Azure OpenAI provides drift explanations and remediation planning. All state lives in Azure Blob + Table Storage.

---

## PART 2: COMPREHENSIVE QUESTION BANK WITH ANSWERS

---

### CATEGORY 1: PROJECT OVERVIEW

**Q1: What problem does ADIP solve that Azure Policy doesn't?**

Azure Policy is preventive (blocks non-compliant deployments) but doesn't detect post-deployment drift from manual changes, doesn't provide field-level diffs, doesn't offer rollback, and doesn't reconstruct deleted infrastructure. ADIP is detective + corrective — it finds what changed, explains why it matters, and fixes it.

**Q2: Why build this instead of using Azure Monitor + Alerts?**

Azure Monitor alerts on metrics/logs but doesn't compare current state against a desired baseline. It can't tell you "this NSG rule was removed" or "this VM's SKU changed from Standard_D2 to Standard_B1." ADIP does field-level configuration comparison with remediation capability.

**Q3: What are the key innovations?**

1. Dependency-aware infrastructure reconstruction (delete a VM, get it back with all networking)
2. Real-time field-level drift detection via Event Grid → Socket.IO pipeline
3. Configuration Genome (versioned snapshots with rollback)
4. AI-assisted remediation planning with deterministic execution
5. Multi-approval ticket system with HMAC-signed email tokens

**Q4: How many Azure services does this integrate with?**

12 services: ARM, Event Grid, Storage (Blob/Queue/Table), Functions, Logic Apps, Communication Services, OpenAI, Resource Graph, App Configuration, Application Insights, Key Vault, Policy SDK.

---

### CATEGORY 2: ARCHITECTURE & SYSTEM DESIGN

**Q5: Explain the complete data flow from a resource change to the user seeing it.**

1. User changes resource in Azure Portal
2. ARM fires ResourceWriteSuccess event
3. Event Grid routes to Storage Queue (`resource-changes`)
4. Express queue poller (5s interval) dequeues message
5. Poller fetches live ARM config, diffs against cached state
6. If drift detected: saves to Blob + Table, classifies severity
7. Emits to Socket.IO room (`subscriptionId:resourceGroup`)
8. Frontend `useDriftSocket` hook receives event, adds to feed
9. User sees change in Live Activity Feed within 5-10 seconds

**Q6: Why Express + Socket.IO instead of Azure Functions for everything?**

Socket.IO requires persistent WebSocket connections — Azure Functions (consumption plan) can't maintain long-lived connections. Express gives us: real-time bidirectional communication, in-memory caching, connection state management. Functions are used for event-triggered work (drift detection, scheduled tasks) where statelessness is fine.

**Q7: Why Storage Queue instead of Service Bus?**

Storage Queue is simpler, cheaper ($0.0004/10K operations vs Service Bus $0.05/million), and sufficient for our throughput (100-1000 events/day). We don't need Service Bus features like topics, sessions, or ordering guarantees. The queue is just a buffer between Event Grid and our poller.

**Q8: Why Table Storage instead of Cosmos DB?**

Cost. Table Storage is ~$0.045/GB/month vs Cosmos DB minimum ~$25/month. Our access patterns are simple (partition key + row key lookups, partition scans). We don't need global distribution, multi-model queries, or sub-10ms latency. Table Storage handles our 22 tables at negligible cost.

**Q9: Explain the dependency-aware deployment engine.**

Resources have dependencies (VM needs NIC, NIC needs VNet). The engine:
1. Builds a dependency graph by scanning ARM references (subnet IDs, NIC IDs, NSG IDs)
2. Assigns layers: L1 (IP, NSG) → L2 (VNet, Storage) → L3 (NIC) → L5 (VM) → L6 (Schedules)
3. Topologically sorts resources
4. Deploys layer by layer with retry
5. If a resource fails, its dependents are marked "skipped"
6. VM-specific: sets osDisk.createOption=FromImage, removes stale managedDisk refs

**Q10: How does the system handle partial failures during remediation?**

Per-resource isolation. Each resource is deployed independently within its layer. If NIC creation fails, the VM (which depends on it) is marked "skipped" with reason. Other independent resources continue deploying. The deployment report shows exactly what succeeded, failed, and was skipped.

---

### CATEGORY 3: AZURE-SPECIFIC QUESTIONS

**Q11: How do you handle ARM API throttling?**

Three strategies:
1. 30-second response cache — same resource isn't fetched twice within 30s
2. Subscription/RG list cache (5 min) — reduces enumeration calls
3. Circuit breaker — after 10 consecutive ARM failures, stops calling for 30s
Result: reduced ARM calls by ~90% (from 17,000/day to ~1,700/day).

**Q12: Why DefaultAzureCredential instead of Service Principal directly?**

DefaultAzureCredential tries multiple auth methods in order: environment variables → managed identity → Azure CLI → Visual Studio. This means the same code works locally (CLI auth) and in production (managed identity) without code changes. Zero credential management in application code.

**Q13: How does Event Grid integration work?**

ARM resource changes fire events to an Event Grid Topic. The topic has two subscribers:
1. Storage Queue (for real-time feed) — simple, reliable buffer
2. Logic App (for drift analysis) — filters noise, calls Function App

The Logic App filters out read-only operations and system-generated events before triggering the `detectDrift` Function.

**Q14: Why Logic App as a filter instead of Event Grid filtering?**

Event Grid supports basic subject/type filtering but can't inspect event body content. The Logic App can filter by operation name, exclude specific resource types, check time-of-day, and apply complex conditions. It also provides visual debugging in the Azure Portal.

**Q15: How would you scale this to 1000+ resources across 50 subscriptions?**

1. Replace queue poller with Azure Functions Queue Trigger (auto-scales with queue depth)
2. Add Redis for distributed caching (ARM responses, session state)
3. Deploy Express to Container Apps with auto-scaling (1-5 replicas)
4. Use Resource Graph for bulk queries instead of per-resource ARM calls
5. Partition Table Storage by subscription (already done via PartitionKey)

---

### CATEGORY 4: AI & OPENAI QUESTIONS

**Q16: Where do you use AI vs deterministic logic, and why?**

Deterministic (zero cost, predictable):
- Severity classification (rule-based on field paths)
- Dependency ordering (topological sort)
- ARM sanitization (known volatile fields)
- Change categorization (keyword matching)

AI (adds value humans can't replicate):
- Drift explanation in plain English
- Remediation risk assessment
- Anomaly detection across patterns
- Infrastructure summary for executives

**Q17: How do you prevent AI hallucinations from causing bad remediations?**

AI never executes anything. It only explains and recommends. All actual remediation uses deterministic ARM PUT operations from stored baselines. The AI's role is advisory — it helps humans understand drift, not decide what to deploy.

**Q18: How do you optimize AI token usage?**

1. ARM summarization before sending (strip volatile fields, cap at 15 properties per resource)
2. Response caching (5-min TTL — same question returns cached answer)
3. Circuit breaker (stops calling after 3 failures)
4. Deterministic categorization replaced per-event AI calls (saved ~$30/month)
5. User input truncated to 8000 chars

**Q19: Why Azure OpenAI instead of direct OpenAI API?**

Data residency — Azure OpenAI keeps data within Azure's compliance boundary. Enterprise customers require this for SOC2/ISO compliance. Also: private endpoints, managed identity auth, no data used for model training.

---

### CATEGORY 5: SECURITY QUESTIONS

**Q20: How are remediation approvals secured?**

HMAC-SHA256 signed tokens with 48-hour expiry. The token contains `{resourceId, subscriptionId, exp}` + signature. On click, the server recomputes the HMAC and uses timing-safe comparison. Tampered or expired tokens are rejected. One-time use via idempotency keys.

**Q21: What prevents unauthorized remediation?**

Four layers:
1. JWT auth middleware on all remediation endpoints
2. Role-based access (only admin/approver can approve)
3. Multi-approval requirement (configurable 1-5 approvers)
4. Idempotency keys prevent replay attacks

**Q22: How do you handle secrets?**

Development: `.env` file (gitignored). Production: Azure Key Vault with Managed Identity access. The `keyVault.js` module tries Key Vault first, falls back to env vars. JWT secret is required in production (app fails to start without it).

**Q23: What are the remaining security gaps?**

Honest answer: OData injection is fixed in auth routes but not all Table Storage queries across the codebase. Socket.IO connections don't validate auth tokens (server-side). Rate limiting is per-IP, not per-user. These are documented for future hardening.

---

### CATEGORY 6: SCALABILITY & PERFORMANCE

**Q24: What's the most expensive operation in the system?**

ARM API calls. Each `getResourceConfig()` for an RG makes N+1 calls (1 list + N individual resource GETs). With 15 resources in rg-adip, that's 16 ARM calls per comparison. The 30s cache reduces this to 2 calls/minute instead of 12.

**Q25: How does the 30s ARM cache work?**

`shared/armCache.js` stores responses in a Map with timestamps. Before any ARM call, `getCached(sub, rg, resourceId)` checks if a response exists and is <30s old. After remediation, `invalidateCache()` forces fresh fetch. Cache auto-prunes when size exceeds 200 entries.

**Q26: What happens if 1000 events arrive in 1 second?**

The queue poller has backpressure protection — if the previous batch is still processing, the next poll cycle is skipped. Messages stay safely in the queue (Storage Queue has 7-day retention). The poller processes up to 32 messages per cycle sequentially. At scale, the Azure Functions Queue Trigger would auto-scale to handle bursts.

---

### CATEGORY 7: RELIABILITY & FAILURE HANDLING

**Q27: What happens if the Express server crashes mid-remediation?**

The deployment engine processes resources sequentially. If it crashes after deploying 3 of 5 resources, the 3 deployed resources remain (ARM PUT is idempotent). On restart, the same remediation can be re-triggered — idempotency keys prevent double-execution of already-completed operations. The partially-deployed state is valid (each resource is independent).

**Q28: What happens if Azure OpenAI is down?**

Circuit breaker opens after 3 failures (60s reset). All AI features gracefully degrade — `explainDrift()` returns null, UI shows "AI analysis unavailable." Drift detection, comparison, and remediation continue working (they're deterministic). The system is fully functional without AI.

**Q29: How do you handle the "deleted resource that can't be recreated" case?**

Some resources can't be recreated via ARM PUT (e.g., a disk with specific data). The deployment engine skips `Microsoft.Compute/disks` entirely — the VM creates a fresh disk from its image reference. For truly unrecoverable resources, the deployment report marks them as "failed" with the ARM error message, and the user is informed.

---

### CATEGORY 8: "WHY NOT X?" QUESTIONS

**Q30: Why not Terraform for remediation instead of ARM PUT?**

Terraform requires state files, plan/apply cycles, and HCL definitions. Our remediation is immediate (single ARM PUT from stored JSON baseline). We don't need Terraform's planning — we already know the desired state (the baseline). ARM PUT is atomic, idempotent, and requires no additional tooling.

**Q31: Why not Kubernetes instead of Container Apps?**

Container Apps is Kubernetes under the hood but fully managed — no cluster management, no node pools, no RBAC configuration, no ingress controllers. For a single API service, AKS is massive overkill. Container Apps gives us auto-scaling, managed TLS, and health probes with zero Kubernetes expertise required.

**Q32: Why not Redis from the start?**

YAGNI. In-memory caching works perfectly for a single-instance deployment. Redis adds operational complexity ($13+/month minimum) and a network dependency. The architecture is Redis-ready (cache interface is abstracted) but we don't need it until we scale to multiple instances.

**Q33: Why not GraphQL instead of REST?**

Our API has clear resource boundaries (subscriptions, RGs, resources, baselines, genomes). REST maps naturally. GraphQL adds complexity (schema definition, resolvers, N+1 query problems) without benefit — our frontend makes specific, well-defined calls, not flexible queries.

---

## PART 3: WEAKNESS DEFENSE GUIDE

| Weakness | Why It Exists | Professional Defense |
|---|---|---|
| Plaintext passwords (legacy) | Rapid prototyping, bcrypt was added later | "We implemented bcrypt with automatic migration — existing users upgrade transparently on next login. Production would enforce password policy." |
| Single-process architecture | Sufficient for current scale | "The architecture is designed for extraction — queue poller, scheduler, and API are logically separated. Container Apps + Functions deployment is ready." |
| No CI/CD pipeline | Focus on features over DevOps | "The Dockerfile, Bicep templates, and deploy.sh are ready. Adding GitHub Actions is a straightforward next step." |
| In-memory caches | Simpler than Redis for single instance | "Cache interface is abstracted behind getCached/setCache. Swapping to Redis requires changing one file, not the entire codebase." |
| Full table scans in auth | Table Storage lacks secondary indexes | "Login is infrequent (once per session). For production scale, we'd migrate auth to Azure AD/MSAL (already prepared) or use email as RowKey." |

---

## PART 4: DEMO SCRIPT

### Ideal Demo Flow (15 minutes)

**Minutes 1-2: Context**
"ADIP solves infrastructure drift — when Azure resources change unexpectedly, we detect it in real-time, explain what happened, and can automatically fix it."

**Minutes 3-5: Live Drift Detection**
1. Show DriftScanner with rg-adip selected
2. Add a tag to a resource in Azure Portal (in another tab)
3. Show the Live Feed updating in real-time (5-10s)
4. "Event Grid captures the change, our queue poller processes it, Socket.IO pushes to the browser."

**Minutes 6-8: Comparison & AI**
1. Navigate to ComparisonPage
2. Show field-level diff (tag added)
3. Toggle CTO view — show AI Infrastructure Summary
4. "The AI explains drift in plain English for executives."

**Minutes 9-11: Remediation**
1. Click "Request Remediation"
2. Show ticket created in notification panel
3. Approve the ticket
4. Show tag removed from Azure
5. "Dependency-aware engine handles complex scenarios — we've proven it can reconstruct entire VM stacks."

**Minutes 12-13: Genome & History**
1. Show GenomePage with snapshot timeline
2. "Every change is versioned. You can rollback to any point in time."

**Minutes 14-15: Architecture**
1. Show the architecture diagram
2. Mention: 118 features, 12 Azure services, 95 source files, 350+ functions
3. "Production-ready with security hardening, circuit breakers, telemetry, and Container Apps deployment."

### Backup Plan (if Azure is slow/down)
- Demo mode is built in — falls back to static data when backend is unreachable
- Pre-record a video of the live drift detection flow
- Have screenshots of successful destructive recovery test results

---

## PART 5: RAPID-FIRE VIVA (50 Questions)

### Beginner
1. What is infrastructure drift? → Config changes from desired state
2. What is ARM? → Azure Resource Manager, the deployment/management layer
3. What is Event Grid? → Pub/sub event routing service
4. What is Socket.IO? → Real-time bidirectional WebSocket library
5. What is JWT? → JSON Web Token for stateless authentication

### Intermediate
6. Why topological sort for deployment? → Ensures dependencies deploy before dependents
7. What's a circuit breaker? → Stops calling failing services to prevent cascade
8. Why HMAC over plain JWT for approval tokens? → Simpler, no key rotation needed for short-lived tokens
9. What's idempotency? → Same operation executed multiple times produces same result
10. Why strip volatile fields? → They change on every read (etag, timestamps) and aren't real drift

### Advanced
11. How does the diff engine handle array reordering? → Matches by name/id, not position
12. Why exclude managed disks from comparison? → Name changes on every VM recreation
13. How does VM sanitization work? → createOption=FromImage, remove managedDisk ref, remove osProfile.requireGuestProvisionSignal
14. What's the deployment layer ordering? → L1:IP/NSG → L2:VNet/Storage → L3:NIC → L5:VM → L6:Schedules
15. How does reconnect re-subscription work? → activeScopes Set tracks rooms, re-emits all on socket reconnect

### Brutal Panel Mode
16. Your queue poller is single-threaded. What happens at 10,000 events/minute? → Queue buffers (7-day retention), poller processes 32/cycle. At scale, Azure Functions Queue Trigger auto-scales.
17. Table Storage has no secondary indexes. How do you query by email? → Full scan (acceptable for auth frequency). Production uses Azure AD.
18. Your ARM cache is in-memory. What happens with 3 replicas? → Each has independent cache (acceptable — ARM calls are idempotent). Redis solves this for true multi-instance.
19. What if someone intercepts an approval email? → HMAC signature prevents tampering, 48h expiry limits window, idempotency prevents replay.
20. Your diff engine is O(n²) for arrays. Does it scale? → Arrays are typically <50 items (resources in an RG). For 1000+ resources, we'd use Resource Graph for bulk comparison.

---

## PART 6: TOP 20 HARDEST QUESTIONS

1. How would you implement multi-region disaster recovery for ADIP itself?
2. What's your strategy if ARM API versions change and break your sanitization logic?
3. How do you guarantee exactly-once remediation in a distributed system?
4. What happens if two approvers click "approve" simultaneously?
5. How would you handle circular dependencies in the deployment graph?
6. Your baseline could be months old — how do you prevent remediating to a broken state?
7. What's your testing strategy for the deployment engine without actually deploying to Azure?
8. How do you handle Azure resources that don't support ARM PUT (e.g., some legacy resources)?
9. If Event Grid has an outage, how long until you detect drift?
10. How would you implement rollback of a failed remediation?
11. Your AI prompt includes ARM JSON — what if it contains secrets (connection strings in app settings)?
12. How do you handle eventual consistency between Table Storage writes and reads?
13. What's your strategy for handling Azure subscription migrations (resource IDs change)?
14. How would you implement canary remediation (fix one resource, verify, then fix the rest)?
15. Your Socket.IO is single-server. How do you scale WebSockets horizontally?
16. What happens if the baseline blob is corrupted or deleted?
17. How do you handle resources that take 30+ minutes to deploy (e.g., Azure SQL)?
18. Your severity classification is rule-based. What if a "low" change is actually critical in context?
19. How would you implement drift detection for resources ADIP doesn't have baselines for?
20. What's your data retention strategy and how do you handle GDPR deletion requests?

### Ideal Answers for Top 5 Hardest:

**#1 Multi-region DR:** Deploy to paired regions (e.g., Central US + East US 2). Blob Storage uses GRS replication. Table Storage uses GZRS. Express API deploys to both regions behind Traffic Manager. Socket.IO uses Redis adapter for cross-region pub/sub.

**#3 Exactly-once remediation:** Idempotency keys in Table Storage. Before executing, check if key exists. After success, write key. ARM PUT is inherently idempotent (same payload = same result). The ticket system ensures only one approval triggers execution.

**#4 Simultaneous approvals:** The approval endpoint increments `approvalCount` atomically using Table Storage ETag-based optimistic concurrency. If two writes conflict, one gets 412 Precondition Failed and retries. The threshold check happens after the write, so only the write that crosses the threshold triggers remediation.

**#6 Stale baseline:** This is a real risk. Mitigation: genome snapshots provide a timeline — users can see when the baseline was last updated. Future improvement: baseline freshness warning (if >30 days old, show alert before remediation). The comparison page always shows the full diff so users see exactly what will change.

**#15 WebSocket scaling:** Redis adapter for Socket.IO (`@socket.io/redis-adapter`). Each Express instance connects to Redis pub/sub. When one instance emits to a room, Redis broadcasts to all instances. Container Apps handles the sticky sessions for WebSocket upgrade.

---

## PART 7: STUDY ROADMAP

### Must Know (will definitely be asked)
- Event Grid architecture and event types
- ARM API structure (resource IDs, providers, API versions)
- Socket.IO rooms and namespaces
- JWT structure and verification
- Topological sort algorithm
- Circuit breaker pattern
- Idempotency in distributed systems
- Azure Managed Identity
- React Context + useMemo optimization
- HMAC-SHA256

### Should Know (likely to be asked)
- Azure Table Storage partition strategy
- Blob Storage access tiers
- Container Apps vs AKS vs App Service
- Durable Functions orchestration patterns
- Application Insights distributed tracing
- Express middleware chain
- React.lazy code splitting
- WebSocket vs SSE vs long polling
- Azure RBAC role definitions
- Key Vault secret rotation

### Nice to Know (impressive if you mention)
- W3C Trace Context propagation
- Azure Resource Graph query language (KQL)
- ARM template deployment modes (Complete vs Incremental)
- Event Grid dead-lettering
- Storage Queue poison message handling
- Azure Front Door for global load balancing
- Bicep vs ARM template tradeoffs
- OpenAI token counting (tiktoken)

---

*Preparation complete. You should be able to defend any aspect of this project confidently.*
