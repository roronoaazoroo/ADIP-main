# ADIP — Complete File & Function Reference

---

## Backend: Routes (32 files)

### routes/auth.js
**Purpose:** User authentication with org-based multi-tenancy, email verification, JWT tokens
- `org/send-otp` — sends OTP to email
- `POST /api/auth/verify-otp` — verifies OTP code
- `POST /api/auth/create-org` — creates org + admin user
- `POST /api/auth/join-org` — joins org via invite code
- `POST /api/auth/login` — authenticates user, returns JWT
- `GET /api/auth/me` — returns current user from token

### routes/orgManagement.js
**Purpose:** Organization member management and notifications
- `adminsTable()` — returns Table client for orgAdmins
- `membersTable()` — returns Table client for orgMembers
- `notificationsTable()` — returns Table client for notifications
- `getUser()` — fetches user entity from members table
- `createNotification()` — creates a notification entity
- `notifyAllMembers()` — sends notification to all organizationsTable()` — returns Table client for organizations
- `orgAdminsTable()` — returns Table client for orgAdmins
- `orgMembersTable()` — returns Table client for orgMembers
- `generateAuthToken()` — generates JWT auth token with user claims
- `isEmailVerified()` — checks if a user's email is verified
- `POST /api/authembers
- `GET /api/org/members` — lists org members
- `POST /api/org/invite` — invites a new member
- `DELETE /api/org/members/:email` — removes a member
- `GET /api/org/notifications` — lists notifications for a user

### routes/approvalTickets.js
**Purpose:** Multi-approver ticket system for remediation approval workflows
- `ticketsTable()` — returns Table client for approvalTickets
- `getRequiredApprovals()` — calculates required approval count
- `POST /api/approval-tickets` — creates a new approval ticket
- `GET /api/approval-tickets` — lists tickets for a subscription
- `POST /api/approval-tickets/:id/vote` — casts approve/reject vote
- `GET /api/approval-tickets/:id` — gets ticket details

### routes/subscriptions.js
**Purpose:** Lists all Azure subscriptions accessible to the current credential
- `GET /api/subscriptions` — returns all Azure subscriptions (5-min cache)

### routes/resourceGroups.js
**Purpose:** Lists all resource groups in a subscription
- `GET /api/subscriptions/:subscriptionId/resource-groups` — returns RGs (5-min cache)

### routes/resources.js
**Purpose:** Lists all resources in a resource group
- `GET /api/subscriptions/:id/resource-groups/:rg/resources` — returns resources

### routes/configuration.js
**Purpose:** Fetches full live ARM configuration for a resource or resource group
- `GET /api/configuration` — fetches live ARM config via azureResourceService

### routes/compare.js
**Purpose:** Baseline vs live comparison with suppression rule filtering
- `loadSuppressionRules()` — loads suppression rules from Table Storage
- `isSuppressed()` — checks if a diff entry matches any suppression rule
- `buildSessionRowKey()` — builds unique row key for monitor sessions
- `runDriftCheck()` — performs full drift check
- `GET /api/compare` — runs drift comparison
- `POST /api/monitor/start` — starts a monitoring session
- `POST /api/monitor/stop` — stops a monitoring session

### routes/baseline.js
**Purpose:** CRUD for golden baselines
- `GET /api/baselines` — fetches active golden baseline
- `POST /api/baselines` — saves a new golden baseline

### routes/baselineUpload.js
**Purpose:** Accepts custom JSON golden baseline uploads
- `POST /api/baselines/upload` — accepts JSON as new golden baseline

### routes/baselineValidation.js
**Purpose:** Validates baseline completeness and dependency graph before remediation
- `POST /api/baseline/validate` — checks baseline integrity
- `POST /api/recovery/test` — runs destructive integration test

### routes/remediate.js
**Purpose:** Reverts resources to golden baseline via ARM PUT; handles RG-level deployments
- `POST /api/remediate` — reverts resource to baseline (with idempotency)
- `GET /api/policy/assignments` — lists policy assignments
- `GET /api/remediation-audit` — returns deployment audit log

### routes/remediateDecision.js
**Purpose:** Email-based approve/reject flow with HMAC-signed tokens
- `verifyApprovalToken()` — verifies HMAC approval token
- `generateApprovalToken()` — generates signed token for email links
- `html()` — generates HTML confirmation page
- `GET /api/remediate-decision` — handles approve/reject from email

### routes/remediateRequest.js
**Purpose:** Sends drift approval email without applying remediation
- `POST /api/remediate-request` — sends drift alert email

### routes/remediationSchedule.js
**Purpose:** CRUD for scheduled remediation with maintenance windows
- `sendScheduleApprovalEmail()` — sends approval email for schedules
- `POST /api/remediation-schedules` — creates schedule
- `GET /api/remediation-schedules` — lists schedules
- `DELETE /api/remediation-schedules/:id` — cancels schedule
- `POST /api/remediation-schedules/:id/approve` — approves schedule
- `POST /api/remediation-schedules/:id/execute` — triggers execution

### routes/drift.js
**Purpose:** Drift event queries, change history, stats, and chart data
- `GET /api/drift-events` — queries drift records with filters
- `GET /api/changes/recent` — returns changes from last 24h
- `GET /api/changes/count` — returns total change count
- `GET /api/stats/today` — returns rolling 24h stats
- `GET /api/stats/chart` — returns bucketed counts for bar chart
- `GET /api/changes/details` — returns full change record

### routes/driftImpact.js
**Purpose:** Aggregates drift data for Impact Analysis page
- `riskLevel()` — derives risk level from severity counts
- `humanReadable()` — formats resource ID into readable name
- `GET /api/drift-impact` — returns dailyVolume, severityTotals, topResources

### routes/driftRiskTimeline.js
**Purpose:** Drift risk timeline and resource-level prediction data
- `getExistingNames()` — fetches existing resource names from ARM
- `getDriftIndexRows()` — queries driftIndex table
- `GET /api/drift-risk-timeline` — returns risk timeline data

### routes/rgPrediction.js
**Purpose:** Resource group drift risk prediction using Table Storage aggregation
- `GET /api/rg-prediction` — returns drift risk predictions per RG (5-min cache)

### routes/ai.js
**Purpose:** Proxy routes forwarding AI requests to Azure Function App
- `buildAiFunctionUrl()` — constructs Azure Function URL
- `POST /api/ai/explain` — AI drift explanation
- `POST /api/ai/reclassify` — AI severity reclassification
- `POST /api/ai/anomalies` — AI anomaly detection

### routes/armAnalyzer.js
**Purpose:** AI-powered ARM template analysis and summarization
- `cleanForAI()` — strips verbose fields for AI consumption
- `summarizeArm()` — summarizes ARM config to reduce tokens
- `POST /api/arm-analyze` — AI infrastructure summary

### routes/chat.js
**Purpose:** Azure OpenAI-powered chatbot for drift Q&A
- `POST /api/chat` — sends conversation to OpenAI with drift context

### routes/costEstimate.js
**Purpose:** Cost impact analysis using Azure Retail Prices API
- `fetchPrice()` — fetches price from Azure Retail Prices API
- `calculateCostDelta()` — calculates monthly cost delta
- `recordRemediationSavings()` — records cost savings after remediation
- `POST /api/cost-estimate` — calculates cost delta
- `GET /api/cost-savings` — returns total savings

### routes/dependencyGraph.js
**Purpose:** Resource dependency graph endpoint
- `GET /api/dependency-graph` — returns { nodes[], links[] } for visualization

### routes/attribution.js
**Purpose:** Per-user drift causation ranking
- `isHumanCaller()` — filters out system callers
- `GET /api/attribution` — returns per-user drift ranking

### routes/reports.js
**Purpose:** Drift report generation, storage, and email delivery
- `POST /api/reports/generate` — generates and saves report
- `GET /api/reports` — lists saved reports
- `GET /api/reports/view` — returns report HTML
- `DELETE /api/reports` — deletes a report

### routes/suppressionRules.js
**Purpose:** CRUD for drift suppression rules
- `GET /api/suppression-rules` — lists rules
- `POST /api/suppression-rules` — creates rule
- `DELETE /api/suppression-rules/:rowKey` — deletes rule

### routes/userPreferences.js
**Purpose:** Per-user settings persistence
- `GET /api/user-preferences` — fetches preferences
- `POST /api/user-preferences` — saves preferences

### routes/recommendations.js
**Purpose:** Intent-based AI recommendations for aggregated drift
- `POST /api/recommendations` — generates prioritized AI recommendations

### routes/manualGuide.js
**Purpose:** AI-generated step-by-step manual fix guide
- `POST /api/manual-guide` — generates portal + CLI instructions

### routes/recover.js
**Purpose:** Full resource group recovery from baseline
- `POST /api/recover` — recovers RG from baseline with dependency ordering

---

## Backend: Services (15 files)

### services/blobService.js
**Purpose:** Core storage layer — blob CRUD, drift records, genome snapshots, change records
- `getBlobService()` — returns BlobServiceClient singleton
- `container()` — returns/creates blob container client
- `tableClient()` — returns/creates Table client
- `blobKey()` / `driftKey()` / `rowKey()` — key generators
- `readBlob()` / `writeBlob()` — blob read/write
- `getBaseline()` / `saveBaseline()` — golden baseline CRUD
- `saveDriftRecord()` / `getDriftRecords()` / `getDriftHistory()` — drift records
- `saveGenomeSnapshot()` / `listGenomeSnapshots()` / `getGenomeSnapshot()` / `deleteGenomeSnapshot()` — genome CRUD
- `saveChangeRecord()` / `getRecentChanges()` / `getTotalChangesCount()` — change records
- `saveDailySnapshot()` / `savePreDeletionSnapshot()` — scheduled snapshots

### services/azureResourceService.js
**Purpose:** Azure ARM client — fetches subscriptions, RGs, resources, full configs
- `getApiVersion()` — resolves ARM API version for resource type
- `listSubscriptions()` / `listResourceGroups()` / `listResources()` — ARM listing
- `fetchStorageChildItems()` — fetches storage child resources
- `getResourceConfig()` — fetches full live ARM config (with 30s cache)

### services/deploymentEngine.js
**Purpose:** Dependency-aware ARM deployment engine for RG-level remediation
- `getLayer()` — determines deployment priority for resource type
- `sanitizeResource()` — strips read-only fields for ARM PUT
- `buildDependencyGraph()` — builds dependency graph between resources
- `extractDependencies()` — extracts dependency IDs from resource
- `topologicalSort()` — sorts resources by dependency order
- `deployResources()` — deploys resources in order (main entry point)
- `audit()` / `getAuditLog()` — deployment audit logging
- `FLAGS` — feature flags (enableAutoRemediation, maxRetries)

### services/aiOrchestrator.js
**Purpose:** Centralized AI orchestration with caching, circuit breaker, telemetry
- `callAI()` — core AI call with timeout, retry, circuit breaker
- `explainDrift()` — cached drift explanation
- `planRemediation()` — AI remediation planning
- `detectAnomalies()` — AI anomaly detection
- `summarizeInfrastructure()` — AI infrastructure summary
- `getHealthStatus()` — AI service health status

### services/aiService.js
**Purpose:** Azure OpenAI integration (legacy, used by compare.js)
- `callAzureOpenAI()` — makes authenticated OpenAI call
- `explainDrift()` — plain-English drift explanation
- `reclassifySeverity()` — AI severity reclassification
- `getRemediationRecommendation()` — remediation recommendation

### services/queuePoller.js
**Purpose:** Polls Storage Queue for change events, enriches with diff, broadcasts via Socket.IO
- `parseMessage()` — parses queue message into structured event
- `isDuplicate()` — deduplication check
- `enrichWithDiff()` — enriches event with baseline diff
- `categorizeChangeLocal()` — deterministic change categorization
- `startQueuePoller()` — starts the polling loop

### services/alertService.js
**Purpose:** Drift alert emails via Azure Communication Services
- `sendDriftAlertEmail()` — sends HTML email with approve/reject buttons

### services/socketService.js
**Purpose:** Socket.IO event broadcasting
- `broadcastDriftEvent()` — broadcasts drift event to all clients

### services/reportService.js
**Purpose:** Drift report generation, storage, and email delivery
- `aggregateReportData()` — aggregates drift data for report
- `buildHtmlReport()` — builds HTML report
- `generateAndSaveReport()` — generates, saves, optionally emails
- `listSavedReports()` — lists saved reports

### services/dependencyGraphService.js
**Purpose:** Resource Graph API visualization
- `buildDependencyGraph()` — builds { nodes[], links[] } from Resource Graph

### services/remediationScheduleService.js
**Purpose:** Scheduled remediation with maintenance windows
- `createSchedule()` / `listSchedules()` / `cancelSchedule()` — CRUD
- `executeSchedule()` — executes scheduled remediation
- `processDueSchedules()` — processes all due schedules

### services/policyEnforcementService.js
**Purpose:** Azure Policy assignment after remediation
- `findMatchingPolicies()` — finds policies matching changed fields
- `enforcePolicesForDrift()` — creates Azure Policy assignments

### services/storageChildService.js
**Purpose:** Reconciles storage account child resources
- `reconcileStorageChildren()` — reconciles containers/queues/tables/shares

### services/genomeScheduler.js
**Purpose:** Scheduled genome operations — daily snapshots, cleanup
- `createDailySnapshots()` — creates daily genome snapshots
- `cleanupExpiredGenomes()` — removes expired snapshots
- `createInactivitySnapshots()` — snapshots for inactive resources

### services/otpService.js
**Purpose:** OTP generation and verification
- `generateOtp()` — generates OTP, sends via email
- `verifyOtp()` — verifies OTP code

---

## Backend: Shared Utilities (13 files)

### shared/armCache.js
**Purpose:** Singleton ARM clients + 30s response cache
- `getArmClient()` — returns cached ResourceManagementClient
- `getCached()` / `setCache()` / `invalidateCache()` — cache operations
- `armCall()` — ARM call with circuit breaker

### shared/armUtils.js
**Purpose:** ARM resource sanitization
- `stripVolatileFields()` — removes read-only fields from ARM resources

### shared/circuitBreaker.js
**Purpose:** Circuit breaker pattern for external services
- `CircuitBreaker` class — CLOSED/OPEN/HALF_OPEN state machine
- `breakers.openai` — OpenAI breaker (threshold: 3, reset: 60s)
- `breakers.arm` — ARM breaker (threshold: 10, reset: 30s)

### shared/idempotency.js
**Purpose:** Prevents duplicate remediation execution
- `isDuplicate()` — checks if operation already executed
- `markExecuted()` — records successful execution
- `idempotencyMiddleware()` — Express middleware

### shared/sanitize.js
**Purpose:** OData query injection prevention
- `odataEscape()` — escapes single quotes
- `odataFilter()` — builds safe OData filter

### shared/telemetry.js
**Purpose:** Application Insights integration
- `init()` — initializes Application Insights
- `trackRemediation()` / `trackArmCall()` / `trackAiCall()` / `trackDeployment()` / `trackQueueMessage()` — event tracking
- `trackMetric()` / `trackError()` — custom metrics/errors

### shared/keyVault.js
**Purpose:** Azure Key Vault secret retrieval
- `getSecret()` — fetches secret (cached, falls back to env var)
- `initSecrets()` — pre-loads all required secrets

### shared/severity.js
**Purpose:** Drift severity classification (re-export)
- `classifySeverity()` — Critical/High/Medium/Low based on field rules

### shared/diff.js
**Purpose:** Deep diff engine (re-export)
- `diffObjects()` — computes field-level differences
- `strip()` — removes volatile fields
- `normalize()` — normalizes for comparison

### shared/constants.js
**Purpose:** Shared constants (re-export)
- `VOLATILE` — volatile field names to ignore
- `CRITICAL_PATHS` — security-critical ARM paths
- `API_VERSION_MAP` — resource type → API version

### shared/complianceMap.js
**Purpose:** CIS/NIST/ISO 27001 compliance mapping
- `mapDiffToControls()` — maps diffs to compliance controls

### shared/identity.js
**Purpose:** Caller identity normalization
- `resolveIdentity()` — normalizes caller identity string

### shared/policyMap.json
**Purpose:** ARM property → Azure Policy definition mapping (static data)

---

## Backend: Middleware (2 files)

### middleware/authMiddleware.js
**Purpose:** JWT authentication and role-based authorization
- `authMiddleware()` — verifies JWT, attaches req.user
- `requireRole(...roles)` — restricts access to specified roles
- `optionalAuth()` — attaches user if present, doesn't block

### middleware/msalAuth.js
**Purpose:** Azure AD / MSAL token validation for enterprise SSO
- `msalAuth()` — validates Azure AD Bearer tokens
- `mapAzureAdRole()` — maps Azure AD roles to ADIP roles

---

## Frontend: Pages (7 files)

### pages/LoginPage.jsx
**Purpose:** Login form with OTP verification, org creation/join flows
- `LoginPage` — renders auth UI

### pages/DashboardHome.jsx
**Purpose:** Main dashboard with KPI cards, charts, live change table
- `DashboardHome` — main dashboard page
- `FilterDropdown` — reusable filter dropdown
- `KpiCard` — single KPI metric card
- `DonutChart` — SVG donut for drift ratio
- `BarChart` — hourly drift volume chart

### pages/DriftScanner.jsx
**Purpose:** Multi-scope scanner with live feed, config viewer, dependency graph
- `DriftScanner` — full scanner page

### pages/ComparisonPage.jsx
**Purpose:** Baseline vs live diff with remediation, AI analysis, cost badges
- `ComparisonPage` — field-level diff table + remediation
- `CostDeltaBadge` — inline cost impact badge
- `classifySeverity()` — client-side severity classification
- `formatDifferences()` — normalizes diff output
- `normaliseState()` — strips volatile fields
- `filterVolatile()` — filters volatile diffs from display

### pages/GenomePage.jsx
**Purpose:** Versioned snapshot timeline with rollback
- `GenomePage` — genome timeline + snapshot management
- `RequestHistory` — change history sub-component

### pages/AnalyticsPage.jsx
**Purpose:** Tabbed analytics (Impact, Cost, Attribution, Reports, Predictions)
- `AnalyticsPage` — tab container

### pages/SettingsPage.jsx
**Purpose:** User preferences (theme, notifications, suppression rules)
- `SettingsPage` — multi-section settings
- `ToggleSwitch` / `SettingRow` / `SectionCard` — UI components

---

## Frontend: Components (22 files)

### components/NavBar.jsx
**Purpose:** Top navigation with page links, notifications, user menu
- `NavBar` — top navigation bar

### components/ScopeSelector.jsx
**Purpose:** Subscription → RG → resource hierarchical selection
- `ScopeSelector` — scope selection UI

### components/MultiSelectDropdown.jsx
**Purpose:** Reusable searchable checkbox dropdown
- `MultiSelectDropdown` — generic multi-select

### components/LiveActivityFeed.jsx
**Purpose:** Real-time Socket.IO event feed
- `LiveActivityFeed` — scrollable event list

### components/JsonTree.jsx
**Purpose:** Interactive collapsible JSON tree viewer
- `JsonTree` — recursive JSON tree

### components/DependencyGraph.jsx
**Purpose:** Force-directed resource dependency visualization
- `DependencyGraph` — ReactFlow graph
- `ResourceDetailPanel` — side panel for resource details
- `ResourceNode` — custom graph node

### components/DriftImpactDashboard.jsx
**Purpose:** Daily volume chart, severity pie, expandable rows
- `DriftImpactDashboard` — drift impact analytics

### components/CostImpactDashboard.jsx
**Purpose:** Cost delta badges, savings tracking
- `CostImpactDashboard` — cost savings view

### components/ReportsDashboard.jsx
**Purpose:** Report generation, storage, email, download
- `ReportsDashboard` — report management UI

### components/RgDriftPrediction.jsx
**Purpose:** RG-level drift risk prediction
- `RgDriftPrediction` — risk scores and prediction table

### components/DriftForecastChart.jsx
**Purpose:** Resource-level drift forecast chart
- `DriftForecastChart` — SVG line chart with forecast

### components/TopChangers.jsx
**Purpose:** Top drift-causing users widget
- `TopChangers` — ranked user list

### components/SuppressionRules.jsx
**Purpose:** Suppression rule management
- `SuppressionRules` — CRUD interface

### components/ScheduleRemediationModal.jsx
**Purpose:** Schedule remediation with maintenance windows
- `ScheduleRemediationModal` — schedule form modal

### components/AzureChatbot.jsx
**Purpose:** AI chatbot for drift Q&A
- `AzureChatbot` — chat interface

### components/GenomeHistory.jsx
**Purpose:** Snapshot timeline with category grouping
- `GenomeHistory` — timeline with rollback/promote

### components/GenomeCtoView.jsx
**Purpose:** CTO-level genome summary
- `GenomeCtoView` — executive config health summary

### components/GenomeBestConfigs.jsx
**Purpose:** Best configuration recommendations
- `GenomeBestConfigs` — recommended baselines list

### components/AggregatedDriftView.jsx
**Purpose:** Aggregated drift summary across fields
- `AggregatedDriftView` — grouped drift with severity

### components/ArmInfrastructureSummary.jsx
**Purpose:** AI infrastructure summary panel
- `ArmInfrastructureSummary` — visual ARM state summary

### components/ManualFixGuide.jsx
**Purpose:** AI-generated manual fix instructions
- `ManualFixGuide` — step-by-step remediation guide

### components/NotificationPanel.jsx
**Purpose:** Slide-out notification panel
- `NotificationPanel` — notification list with tabs

### components/OrgMembersPanel.jsx
**Purpose:** Organization members management
- `OrgMembersPanel` — member list with role management

### components/ViewModeToggle.jsx
**Purpose:** CTO/Engineer view toggle
- `ViewModeToggle` — toggle switch

### components/ErrorBoundary.jsx
**Purpose:** React error boundary
- `ErrorBoundary` — catches render errors, shows retry UI

---

## Frontend: Context (2 files)

### context/DashboardContext.jsx
**Purpose:** Global dashboard state (scope, events, scan state)
- `DashboardProvider` — context provider
- `useDashboard()` — hook to consume context
- `usePersisted()` — sessionStorage-backed state

### context/ViewModeContext.jsx
**Purpose:** CTO/Engineer view mode
- `ViewModeProvider` — context provider
- `useViewMode()` — hook returning mode + toggle

---

## Frontend: Hooks (3 files)

### hooks/useAzureScope.js
**Purpose:** Fetches Azure subscription/RG/resource hierarchy
- `useAzureScope()` — loads subscriptions, RGs, resources

### hooks/useDriftSocket.js
**Purpose:** Socket.IO connection for real-time drift events
- `useDriftSocket()` — connects, subscribes, returns events

### hooks/useVisiblePolling.js
**Purpose:** Polling that pauses when tab is hidden
- `useVisiblePolling()` — visibility-aware polling with backoff

---

## Frontend: Services (5 files)

### services/api.js
**Purpose:** Central API client with all REST endpoint functions
- `apiRequest()` — base fetch wrapper with auth
- 60+ exported functions for every API endpoint

### services/authService.js
**Purpose:** Authentication service (OTP, org, login)
- `sendOtp()` / `verifyOtp()` / `createOrganization()` / `joinOrganization()` / `loginUser()`
- `getAuthToken()` / `getCurrentUser()` / `logoutUser()` / `isAuthenticated()`
- `fetchOrgMembers()` / `updateMemberRole()` / `fetchNotifications()`

### services/socketSingleton.js
**Purpose:** Singleton Socket.IO connection
- `getSocket()` — returns/creates socket instance
- `onResourceChange()` — registers change listener
- `subscribeScope()` — subscribes to scope room
- `isConnected()` — connection status

### services/rgPredictionApi.js
**Purpose:** RG drift prediction API client
- `fetchRgPrediction()` — POST /ai/predict-rg

### services/driftPredictionApi.js
**Purpose:** Resource drift prediction API client
- `fetchDriftPrediction()` / `fetchDriftRecommendations()` / `fetchRgRecommendations()`

---

## Frontend: Utils (2 files)

### utils/azureIcons.js
**Purpose:** ARM resource type → icon URL mapping
- `getAzureIconUrl()` — returns SVG icon URL for resource type

### utils/complianceMap.js
**Purpose:** Client-side CIS/NIST/ISO compliance mapping
- `getControlsForPath()` — returns compliance controls for a diff path

---

## Function App (12 functions)

### function-app/detectDrift/index.js
**Purpose:** Core drift detection (HTTP trigger from Logic App)

### function-app/aiOperations/index.js
**Purpose:** AI operations (explain, reclassify, recommend, anomalies, predict)

### function-app/eventGridRouter/index.js
**Purpose:** Event Grid event routing

### function-app/driftAlertRouter/index.js
**Purpose:** Drift alert routing

### function-app/scanSubscription/index.js
**Purpose:** Full subscription scan

### function-app/monitorResources/index.js
**Purpose:** Resource monitoring

### function-app/recordChange/index.js
**Purpose:** Change recording

### function-app/sendAlert/index.js
**Purpose:** Email dispatch with HMAC-signed approve/reject links

### function-app/processSchedules/index.js
**Purpose:** Scheduled remediation processing (timer)

### function-app/afterHoursAlert/index.js
**Purpose:** Off-hours drift alerting (timer)

### function-app/queueProcessor/index.js
**Purpose:** Storage Queue trigger for resource-changes (replaces poller)

### function-app/genomeTimer/index.js
**Purpose:** Daily genome snapshots at 7 PM UTC (timer)

### function-app/remediationOrchestrator/index.js
**Purpose:** Durable Functions orchestrator for approval + remediation workflow

---

## Infrastructure (4 files)

### infra/container-app.bicep
**Purpose:** Azure Container Apps deployment (auto-scale, health probes, managed TLS)

### infra/keyvault.bicep
**Purpose:** Azure Key Vault with RBAC for Container App

### infra/deploy.sh
**Purpose:** One-command deployment script

### Dockerfile
**Purpose:** Production container image (Node 20 Alpine)

---

## Tests (4 files)

### tests/unit/security.test.cjs
**Purpose:** Security hardening validation (bcrypt, JWT, HMAC, OData, auth middleware)

### tests/unit/resilience.test.cjs
**Purpose:** Reliability validation (circuit breaker, cache, deployment engine, diff engine)

### tests/integration/full-platform-test.cjs
**Purpose:** Full platform test (43 tests across all services)

### tests/integration/destructive-recovery.cjs
**Purpose:** Destructive VM stack recovery test (delete → remediate → validate Azure state)

---

*Total: ~95 source files | ~350 exported functions | 32 API routes | 12 Azure Functions*
