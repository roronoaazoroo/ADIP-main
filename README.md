# Azure Drift Intelligence Platform (ADIP)

Real-time Azure infrastructure drift detection, comparison, versioned snapshot management, and auto-remediation platform built on Microsoft Azure PaaS services.

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Project Structure](#project-structure)
- [Quick Start](#quick-start)
- [Environment Variables Reference](#environment-variables-reference)
- [Running Locally](#running-locally)
- [Azure Resources Required](#azure-resources-required)
- [Deploying the Function App](#deploying-the-function-app)
- [Login Credentials (Local)](#login-credentials-local)
- [API Endpoints Reference](#api-endpoints-reference)
- [Severity Classification](#severity-classification)
- [Known Limitations](#known-limitations)
- [Technology Stack](#technology-stack)

---

## Overview

ADIP continuously monitors Azure resource configurations, detects any deviation from a stored "golden baseline," classifies severity, notifies administrators, and enables one-click remediation or historical rollback — all in real time via a React dashboard.

**Core problem solved:** When teams manage Azure infrastructure, configurations drift — someone changes a firewall rule, modifies a tag, adjusts an SKU. Without a system to track these changes, environments become inconsistent, security posture degrades, and compliance is hard to prove. ADIP treats every Azure resource configuration as versioned state.

---

## Key Features

| Feature | Description |
|---|---|
| **Multi-scope monitoring** | Select multiple resource groups and resources simultaneously via searchable multi-select dropdowns; monitor all in parallel |
| **Real-time change feed** | Any Azure resource change appears in the Live Activity feed via Event Grid → Storage Queue → Socket.IO |
| **Field-level diff** | Shows exactly what changed, who changed it, old value → new value |
| **Severity classification** | Critical / High / Medium / Low based on changed fields (rule-based + AI override) |
| **AI Security Analysis** | Azure OpenAI explains drift in plain English, re-classifies severity with context |
| **AI Anomaly Detection** | Analyses last 50 drift records for unusual patterns, off-hours activity, repeated actors |
| **AI Chatbot** | Azure OpenAI-powered chatbot for drift Q&A and recommendations |
| **Auto-remediation** | Low severity: instant ARM PUT revert. Critical/High/Medium: email approval flow |
| **Smart Remediation Scheduling** | Maintenance windows, auto-approval rules, 48h escalation, email approval for high/critical |
| **Email alerts** | HTML email via Azure Communication Services with Approve/Reject buttons |
| **Golden baseline management** | Promote any config as the reference state via UI or API |
| **Configuration Genome** | Versioned snapshot history — auto-saved on every change, manual save with labels, rollback to any point |
| **Dependency Graph** | Resource Graph API visualization with colored dots per type, severity-differentiated drift rings |
| **Drift Impact Analytics** | Daily volume chart, severity pie chart, expandable resource/RG rows |
| **Drift Prediction & Forecasting** | RG-level and resource-level drift risk prediction with forecast charts |
| **Cost Impact Analysis** | Cost delta badges on diff rows, cost savings tracking, Cost Impact tab on Analytics |
| **Compliance Mapping** | CIS/NIST/ISO 27001 inline badges on diff rows |
| **Policy as Code Enforcement** | Azure Policy assignments after remediation |
| **Change Attribution** | Per-user drift causation ranking |
| **Drift Suppression Rules** | Table Storage-backed client+server-side filtering |
| **Drift Reports** | Generate, save, email, and download PDF drift reports |
| **User Preferences** | Per-user settings persisted in Table Storage |
| **Live ARM refresh** | Comparison page polls every 5s, diff updates silently |
| **User activity filtering** | Filter live feed by Azure AD user identity |
| **CSV export** | Download full activity log |
| **Demo mode** | Falls back to static demo data when backend is unreachable |

---

## Architecture

```
[User Browser]
      │
      ▼
[React Frontend (Vite, port 5173)]
      │  REST + Socket.IO
      ▼
[Node.js Express API (port 3001)]
      │
      ├──────────────────────────────────────────┐
      │                                          │
      ▼                                          ▼
[Azure Blob Storage]                    [Azure Storage Queue]
  baselines/                                     │
  drift-records/                         [Queue Poller (5s)]
  baseline-genome/                               │
                                                 ▼
                                        [Socket.IO → Frontend]

[Azure Table Storage]
  changesIndex, driftIndex, genomeIndex,
  monitorSessions, suppressionRules,
  remediationSchedules, policyAssignments,
  remediationSavings, userPreferences

[Azure Resource Manager]
      │ ResourceWriteSuccess / ResourceDeleteSuccess
      ▼
[Azure Event Grid Topic]
      │
      ├──────────────────────────────────────────┐
      │                                          │
      ▼                                          ▼
[Logic App: adip-logic-app]           [Storage Queue: resource-changes]
  (filters noise, calls Function)
      │
      ▼
[Azure Function App]
  detectDrift         — Core drift detection + email + Socket.IO notify
  aiOperations        — AI-powered analysis operations
  eventGridRouter     — Event Grid event routing
  driftAlertRouter    — Drift alert routing
  scanSubscription    — Full subscription scan
  monitorResources    — Resource monitoring
  recordChange        — Change recording
  sendAlert           — Alert email dispatch
  seedBaseline        — Baseline seeding
  processSchedules    — Scheduled remediation processing
  afterHoursAlert     — Off-hours drift alerting

[Azure OpenAI] ←── aiService.js (explain, re-classify, recommend, anomalies, chat)
[Azure Communication Services] ←── alertService.js (HTML email with approve/reject)
[Azure Resource Graph API] ←── dependencyGraphService.js (resource dependencies)
[Azure App Configuration] ←── Feature flags and runtime config
[Application Insights] ←── Telemetry and monitoring
[Azure Policy SDK] ←── policyEnforcementService.js (policy assignments)
[Azure Retail Prices API] ←── costEstimate.js (cost impact)
```

### Complete Data Flow

1. User or automation changes an Azure resource in Portal/CLI
2. ARM fires a change event to **Azure Event Grid**
3. Event Grid fans out to two subscribers:
   - **Storage Queue** (`resource-changes`) → Express API queue poller → Socket.IO → Live Activity feed
   - **Logic App** (`adip-logic-app`) → filters noise → calls **Azure Function** `detectDrift`
4. `detectDrift` fetches live config, diffs against baseline blob, saves drift record, sends email
5. Frontend receives real-time updates via Socket.IO without page refresh
6. User navigates to Comparison Page to see field-level diff and trigger remediation

---

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Node.js | 18+ | Frontend, Express API, Function App |
| Azure CLI | Latest | Authentication (`az login`) — Contributor access required |
| Azure Functions Core Tools | v4 | Deploy and run Function App locally |

```bash
# Install Azure Functions Core Tools
npm install -g azure-functions-core-tools@4
```

---

## Project Structure

```
ADIP-main/
├── src/                              # React frontend (Vite)
│   ├── App.jsx                       # Root component with React Router
│   ├── main.jsx                      # Vite entry point
│   ├── index.css                     # Global styles
│   ├── dark-theme.css                # Dark theme variables
│   ├── assets/
│   │   ├── ct-logo.png               # CloudThat logo
│   │   └── ct-logo-x-ms.png          # CloudThat × Microsoft logo
│   ├── pages/
│   │   ├── LoginPage.jsx             # Local credential login (SSO-ready)
│   │   ├── DashboardHome.jsx         # KPI cards, hourly chart, live change table
│   │   ├── DriftScanner.jsx          # Multi-scope scanner with live feed, config viewer, dependency graph
│   │   ├── ComparisonPage.jsx        # Baseline vs live diff, remediation, AI analysis
│   │   ├── GenomePage.jsx            # Versioned snapshot timeline + rollback
│   │   ├── AnalyticsPage.jsx         # Drift Impact, Cost Impact, Change Attribution, Reports, Predictions
│   │   └── SettingsPage.jsx          # User preferences (theme, notifications, suppression rules)
│   ├── components/
│   │   ├── NavBar.jsx                # Top navigation bar with page routing
│   │   ├── ScopeSelector.jsx         # Subscription + multi-select RG + multi-select resource dropdowns
│   │   ├── MultiSelectDropdown.jsx   # Reusable searchable checkbox dropdown
│   │   ├── LiveActivityFeed.jsx      # Real-time Socket.IO event feed
│   │   ├── JsonTree.jsx              # Interactive collapsible JSON tree viewer
│   │   ├── DependencyGraph.jsx       # Resource Graph API force-directed visualization
│   │   ├── DriftImpactDashboard.jsx  # Daily volume chart, severity pie, expandable rows
│   │   ├── CostImpactDashboard.jsx   # Cost delta badges, savings tracking
│   │   ├── ChangeAttribution.jsx     # Per-user drift causation ranking
│   │   ├── TopChangers.jsx           # Top drift-causing users widget
│   │   ├── ReportsDashboard.jsx      # Generate, save, email, download PDF reports
│   │   ├── RgDriftPrediction.jsx     # Resource group drift risk prediction
│   │   ├── ResourceDriftPrediction.jsx # Individual resource drift prediction
│   │   ├── DriftPredictionCard.jsx   # Drift prediction card UI
│   │   ├── DriftForecastChart.jsx    # Drift forecast chart (Recharts)
│   │   ├── SuppressionRules.jsx      # Drift suppression rules management
│   │   ├── GenomeHistory.jsx         # Genome event timeline (created/promoted/rolledBack/deleted)
│   │   ├── ScheduleRemediationModal.jsx # Maintenance window + auto-approval scheduling
│   │   └── AzureChatbot.jsx          # Azure OpenAI-powered drift Q&A chatbot
│   ├── hooks/
│   │   ├── useDriftSocket.js         # Socket.IO hook — accepts single or multi-scope, filters events
│   │   └── useAzureScope.js          # Subscription/RG/resource loader with demo fallback
│   ├── context/
│   │   └── DashboardContext.jsx      # Persistent state (sessionStorage) — scopes, selections, events
│   ├── services/
│   │   ├── api.js                    # All frontend REST API calls
│   │   ├── auth.js                   # SSO configuration (MSAL-ready)
│   │   ├── socketSingleton.js        # Socket.IO singleton instance
│   │   ├── rgPredictionApi.js        # Resource group prediction API calls
│   │   └── driftPredictionApi.js     # Drift prediction API calls
│   └── utils/
│       ├── complianceMap.js          # CIS/NIST/ISO 27001 field → control mapping
│       └── azureIcons.js             # Azure resource type → icon/color mapping
│
├── adip-backend/
│   ├── shared/                       # Shared modules across Express API and Function App
│   │   ├── severity.js               # Severity classification rules
│   │   ├── diff.js                   # Deep diff utilities
│   │   ├── blobHelpers.js            # Blob Storage helpers
│   │   └── constants.js              # Shared constants
│   │
│   ├── express-api/                  # Node.js Express API (port 3001)
│   │   └── src/
│   │       ├── app.js                # Server entry, Socket.IO, queue poller, table init
│   │       ├── routes/
│   │       │   ├── subscriptions.js      # GET /subscriptions
│   │       │   ├── resourceGroups.js     # GET /subscriptions/:id/resource-groups
│   │       │   ├── resources.js          # GET /subscriptions/:id/resource-groups/:rg/resources
│   │       │   ├── configuration.js      # GET /configuration
│   │       │   ├── baseline.js           # GET/POST /baselines
│   │       │   ├── baselineUpload.js     # POST /baselines/upload (ARM template + raw JSON)
│   │       │   ├── compare.js            # POST /compare (server-side diff + suppression)
│   │       │   ├── drift.js              # GET /drift-events
│   │       │   ├── remediate.js          # POST /remediate (low-severity ARM PUT)
│   │       │   ├── remediateRequest.js   # POST /remediate-request (email approval)
│   │       │   ├── remediateDecision.js  # GET /remediate-decision (approve/reject)
│   │       │   ├── remediationSchedule.js # Maintenance windows + auto-approval
│   │       │   ├── genome.js             # Snapshot CRUD, promote, rollback
│   │       │   ├── seed.js               # POST /seed-baseline
│   │       │   ├── ai.js                 # AI explain, severity, recommend, anomalies
│   │       │   ├── chat.js               # POST /chat (AI chatbot)
│   │       │   ├── attribution.js        # GET /attribution (per-user drift ranking)
│   │       │   ├── costEstimate.js       # GET /cost-estimate (Azure Retail Prices API)
│   │       │   ├── driftImpact.js        # GET /drift-impact (analytics data)
│   │       │   ├── driftRiskTimeline.js  # GET /drift-risk-timeline
│   │       │   ├── dependencyGraph.js    # GET /dependency-graph (Resource Graph API)
│   │       │   ├── reports.js            # POST /reports (generate/save/email/download)
│   │       │   ├── suppressionRules.js   # CRUD /suppression-rules (Table Storage)
│   │       │   ├── userPreferences.js    # CRUD /user-preferences (Table Storage)
│   │       │   └── rgPrediction.js       # GET /rg-prediction (drift risk prediction)
│   │       ├── services/
│   │       │   ├── azureResourceService.js      # ARM SDK, child resources, API versioning
│   │       │   ├── blobService.js               # Blob Storage CRUD (baselines, drift, genome)
│   │       │   ├── queuePoller.js               # Storage Queue → diff → Socket.IO
│   │       │   ├── alertService.js              # HTML email via ACS with diff table
│   │       │   ├── aiService.js                 # Azure OpenAI integration (GPT-4o)
│   │       │   ├── socketService.js             # Socket.IO broadcast helper
│   │       │   ├── reportService.js             # PDF report generation
│   │       │   ├── dependencyGraphService.js    # Resource Graph API queries
│   │       │   ├── policyEnforcementService.js  # Azure Policy assignment after remediation
│   │       │   ├── remediationScheduleService.js # Schedule processing + escalation
│   │       │   └── storageChildService.js       # Storage account child resource handling
│   │       └── shared/
│   │           ├── armUtils.js           # ARM template utilities + volatile field stripping
│   │           ├── complianceMap.js       # Server-side compliance mapping
│   │           ├── constants.js          # API constants
│   │           ├── diff.js               # Deep diff utilities
│   │           ├── identity.js           # Azure DefaultAzureCredential wrapper
│   │           ├── policyMap.json        # Policy → compliance control mapping
│   │           └── severity.js           # Severity classification rules
│   │
│   ├── function-app/                 # Azure Functions v4 (Node 20)
│   │   ├── host.json                 # Function App host configuration
│   │   ├── shared/                   # Shared modules for functions
│   │   │   ├── severity.js
│   │   │   ├── diff.js
│   │   │   ├── constants.js
│   │   │   └── blobHelpers.js
│   │   ├── detectDrift/              # Core drift detection + email + Socket.IO notify
│   │   ├── aiOperations/             # AI-powered analysis operations
│   │   ├── eventGridRouter/          # Event Grid event routing
│   │   ├── driftAlertRouter/         # Drift alert routing
│   │   ├── scanSubscription/         # Full subscription scan
│   │   ├── monitorResources/         # Resource monitoring
│   │   ├── recordChange/             # Change recording
│   │   ├── sendAlert/                # Alert email dispatch
│   │   ├── seedBaseline/             # Baseline seeding
│   │   ├── processSchedules/         # Scheduled remediation processing
│   │   ├── afterHoursAlert/          # Off-hours drift alerting
│   │   └── tests/                    # Function unit tests
│   │
│   └── logic-app/
│       ├── workflow.json             # Event Grid → filter → Function App
│       └── alert-workflow.json       # Drift alert → Express /alert/email
│
├── scripts/
│   └── sync-env.cjs                  # Validates root .env exists and is configured
│
├── .env.example                      # Single root env template (all variables)
├── index.html
├── vite.config.js
├── package.json                      # Frontend deps + npm scripts
└── README.md
```

---

## Quick Start

### 1. Clone and install all dependencies

```bash
git clone <repo-url>
cd ADIP-main

# Install all dependencies (frontend + Express API + Function App)
npm run install:all
```

Or manually:

```bash
npm install                              # Frontend
cd adip-backend/express-api && npm install  # Express API
cd ../function-app && npm install           # Function App
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in all Azure resource values. See the [Environment Variables Reference](#environment-variables-reference) section below.

> **Note:** The Express API loads from root `.env` via `require('dotenv').config({ path: '../../.env' })`. The Function App does the same. Vite reads `VITE_*` variables automatically. You only need **one `.env` file** at the project root.

### 3. Authenticate with Azure

```bash
az login
az account set --subscription "<your-subscription-id>"
```

### 4. Run locally

```bash
# Terminal 1 — Express API (port 3001)
cd adip-backend/express-api
npm start

# Terminal 2 — Frontend (port 5173)
npm run dev
```

Open [http://localhost:5173](http://localhost:5173)

---

## Environment Variables Reference

All variables live in the **root `.env` file**.

```env
# ── Server ────────────────────────────────────────────────────────────────────
PORT=3001

# ── Azure Storage (Blob + Queue + Table) ──────────────────────────────────────
STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=<account>;AccountKey=<key>;EndpointSuffix=core.windows.net
STORAGE_QUEUE_NAME=resource-changes
QUEUE_POLL_INTERVAL_MS=5000

# ── Azure Identity ────────────────────────────────────────────────────────────
AZURE_SUBSCRIPTION_ID=<your-subscription-id>
AZURE_TENANT_ID=<your-tenant-id>

# ── Azure Function App ────────────────────────────────────────────────────────
FUNCTION_APP_URL=https://<your-func>.azurewebsites.net/api

# ── Express API URLs ──────────────────────────────────────────────────────────
EXPRESS_API_URL=http://localhost:3001
EXPRESS_PUBLIC_URL=http://localhost:3001

# ── Azure Event Grid ──────────────────────────────────────────────────────────
EVENTGRID_TOPIC_ENDPOINT=https://<your-eg-topic>.eventgrid.azure.net/api/events
EVENTGRID_TOPIC_KEY=<your-eventgrid-key>

# ── Drift Alert Logic App ─────────────────────────────────────────────────────
ALERT_LOGIC_APP_URL=https://prod-xx.westus2.logic.azure.com/workflows/...

# ── Azure Communication Services (Email Alerts) ───────────────────────────────
COMMS_CONNECTION_STRING=endpoint=https://<your-comms>.communication.azure.com/;accesskey=<key>
SENDER_ADDRESS=DoNotReply@<your-domain>.azurecomm.net
ALERT_RECIPIENT_EMAIL=admin@yourcompany.com

# ── Azure OpenAI ──────────────────────────────────────────────────────────────
AZURE_OPENAI_ENDPOINT=https://<your-openai>.openai.azure.com/
AZURE_OPENAI_KEY=<your-openai-key>
AZURE_OPENAI_DEPLOYMENT=adip-gpt

# ── Azure App Configuration ───────────────────────────────────────────────────
APP_CONFIG_CONNECTION_STRING=Endpoint=https://<your-appconfig>.azconfig.io;...

# ── Application Insights ──────────────────────────────────────────────────────
APPLICATIONINSIGHTS_CONNECTION_STRING=InstrumentationKey=<key>;...

# ── Frontend (Vite reads these automatically) ─────────────────────────────────
VITE_API_BASE_URL=http://localhost:3001/api
VITE_SOCKET_URL=http://localhost:3001
VITE_AZURE_CLIENT_ID=
VITE_AZURE_TENANT_ID=<your-tenant-id>
VITE_AZURE_SUBSCRIPTION_ID=<your-subscription-id>
```

---

## Running Locally

### Full setup from scratch

```bash
git clone <repo>
cd ADIP-main
npm run install:all
cp .env.example .env
# → fill in all Azure values in .env

az login

# Terminal 1
cd adip-backend/express-api
npm start                    # Express on port 3001 + Socket.IO + queue poller

# Terminal 2 (from project root)
npm run dev                  # Vite dev server on port 5173
```

### Available npm scripts (root `package.json`)

| Script | What it does |
|---|---|
| `npm run setup` | Installs all deps + validates .env |
| `npm run install:all` | Installs deps for frontend, Express API, and Function App |
| `npm run env:sync` | Validates `.env` exists and is non-empty |
| `npm run dev` | Starts Vite frontend dev server |
| `npm run dev:api` | Starts Express API |
| `npm run build` | Builds frontend for production |
| `npm run deploy:func` | Deploys Function App to Azure |

---

## Azure Resources Required

| Resource | Name (example) | Purpose |
|---|---|---|
| Storage Account | `adipstore001` | Blob containers + Storage Queue + Table Storage (9 tables) |
| Storage Queue | `resource-changes` | Buffers Event Grid change events for the queue poller |
| Azure Function App | `adip-func-001` | Serverless drift detection (Node 20, Linux Consumption) |
| Event Grid Topic | `adip-eg-topic` | Receives ARM resource change events |
| Logic App | `adip-logic-app` | Routes Event Grid → Function App (with noise filtering) |
| Logic App | `adip-drift-alert` | Forwards drift alerts → Express `/alert/email` |
| Azure Communication Services | `adip-comms` | Sends HTML email alerts with Approve/Reject buttons |
| Azure OpenAI | `adip-openai` | GPT-4o deployment for AI analysis features |
| Azure App Configuration | `adip-appconfig` | Feature flags and runtime config |
| Application Insights | `adip-insights` | Telemetry and monitoring |
| Azure Resource Graph | — | Dependency graph queries |
| Azure Policy | — | Policy assignments after remediation |

### Storage Blob Containers

| Container | Key format | Written by |
|---|---|---|
| `baselines` | `base64url(resourceId).json` | POST /baselines, genome promote, remediation reject |
| `drift-records` | `timestamp_base64url(resourceId).json` | detectDrift Function, POST /compare |
| `baseline-genome` | `timestamp_base64url(resourceId).json` | Queue poller (auto), POST /genome/save |

### Azure Table Storage Tables (auto-created by `ensureTables()`)

| Table | Purpose |
|---|---|
| `changesIndex` | Change event index |
| `driftIndex` | Drift detection records |
| `genomeIndex` | Genome snapshot metadata |
| `monitorSessions` | Active monitoring sessions |
| `suppressionRules` | Drift suppression rules |
| `remediationSchedules` | Scheduled remediation windows |
| `policyAssignments` | Policy enforcement records |
| `remediationSavings` | Cost savings from remediations |
| `userPreferences` | Per-user settings |

### Required RBAC Permissions

The identity running the Express API and Function App needs:
- **Reader** on the subscription (fetch resource configs)
- **Contributor** on the resource group being monitored (ARM PUT for remediation)
- Storage Account access via connection string (no RBAC needed when using connection string)

---

## Deploying the Function App

```bash
cd adip-backend/function-app
npm run deploy
# Runs: func azure functionapp publish adip-func-001 --javascript
```

After deploying, update the Logic App's `Call_DetectDrift_Function` action URL with the new function key.

Set these Application Settings on the Function App in Azure Portal:
- `STORAGE_CONNECTION_STRING`
- `COMMS_CONNECTION_STRING`
- `SENDER_ADDRESS`
- `ALERT_RECIPIENT_EMAIL`
- `EXPRESS_API_URL` (set to your deployed Express App Service URL)
- `EXPRESS_PUBLIC_URL`

---

## Login Credentials (Local)

The app uses a hardcoded user list for local development. SSO via Azure AD is supported when `VITE_AZURE_CLIENT_ID` is configured.

| Username | Password | Display Name | Email |
|---|---|---|---|
| `saksham` | `Admin@123` | Saksham Midha | saksham@cloudthat.com |
| `rounak` | `Admin@123` | Rounak Chandrakar | rounak@cloudthat.com |
| `ravi` | `Admin@123` | Ravi Davadra | ravi@cloudthat.com |

> **Production:** Replace `DUMMY_USERS` in `LoginPage.jsx` with MSAL SSO. The `auth.js` service and `VITE_AZURE_CLIENT_ID` env var are already wired up — install `@azure/msal-browser` and uncomment the MSAL code to enable it.

---

## API Endpoints Reference

All endpoints are prefixed with `/api` and served by Express on port 3001.

### Subscriptions & Resources

```
GET  /subscriptions
GET  /subscriptions/:id/resource-groups
GET  /subscriptions/:id/resource-groups/:rg/resources
GET  /configuration?subscriptionId=&resourceGroupId=&resourceId=
```

### Baseline Management

```
GET  /baselines?subscriptionId=&resourceId=
POST /baselines
POST /baselines/upload        # Accepts raw ARM config or ARM template export
POST /seed-baseline           # Seeds golden baseline from current live config
```

### Drift Detection & Comparison

```
POST /compare                 # Server-side diff with suppression rules applied
GET  /drift-events?subscriptionId=&resourceGroup=&severity=&limit=
GET  /drift-impact?subscriptionId=&resourceGroup=
GET  /drift-risk-timeline?subscriptionId=&resourceGroup=
```

### Monitoring

```
POST /monitor/start
POST /monitor/stop
POST /cache-state
```

### Remediation

```
POST /remediate               # Low severity: immediate ARM PUT revert
POST /remediate-request       # High/critical: sends approval email
GET  /remediate-decision?action=approve|reject&token=<base64url>
```

### Remediation Scheduling

```
GET    /remediation-schedules?subscriptionId=&resourceGroup=
POST   /remediation-schedules
PUT    /remediation-schedules/:id
DELETE /remediation-schedules/:id
```

### Configuration Genome

```
GET  /genome?subscriptionId=&resourceId=&limit=
POST /genome/save             # Save current live config as snapshot
POST /genome/promote          # Promote snapshot to golden baseline
POST /genome/rollback         # Revert resource to snapshot via ARM PUT
```

### AI Features

```
POST /ai/explain              # Plain-English drift explanation
POST /ai/severity             # AI severity re-classification
POST /ai/recommend            # Remediation recommendation
GET  /ai/anomalies?subscriptionId=
POST /chat                    # AI chatbot Q&A
```

### Analytics & Reporting

```
GET  /attribution?subscriptionId=&resourceGroup=
GET  /cost-estimate?resourceId=&field=
GET  /dependency-graph?subscriptionId=&resourceGroup=
GET  /rg-prediction?subscriptionId=&resourceGroup=
POST /reports                 # Generate, save, email, download PDF
```

### Suppression Rules & User Preferences

```
GET    /suppression-rules?subscriptionId=
POST   /suppression-rules
DELETE /suppression-rules/:partitionKey/:rowKey
GET    /user-preferences/:username
PUT    /user-preferences/:username
```

### Internal Endpoints

```
POST /alert/email             # Called by Logic App
POST /internal/drift-event    # Called by Function App → Socket.IO
```

---

## Severity Classification

| Level | Condition |
|---|---|
| **Critical** | Any field deleted, OR 3+ tag changes in one event |
| **High** | Change to `properties.networkAcls`, `properties.accessPolicies`, `properties.securityRules`, `sku`, `location`, `identity`, or `properties.encryption` |
| **Medium** | More than 5 fields changed (none security-sensitive) |
| **Low** | 1–5 non-security field changes |

After rule-based classification, Azure OpenAI may **escalate** severity if context warrants it (e.g., changing a tag on a production Key Vault during off-hours). AI never reduces severity.

### Remediation behaviour by severity

| Severity | Action on "Remediate" click |
|---|---|
| **Low** | Immediately applies ARM PUT (no approval needed) |
| **Medium / High / Critical** | Sends approval email to `ALERT_RECIPIENT_EMAIL`; admin clicks Approve/Reject link |
| **Reject** | Accepts current live state as the new golden baseline |

---

## Known Limitations

| # | Issue | Fix |
|---|---|---|
| 1 | Local auth uses hardcoded passwords | Implement MSAL SSO via `VITE_AZURE_CLIENT_ID` |
| 2 | Express API is localhost-only | Deploy to Azure App Service; update `EXPRESS_PUBLIC_URL` |
| 3 | Blob listing is O(n) for drift history | Add Azure Cognitive Search or migrate to Table Storage |
| 4 | No auth on `/api/*` endpoints | Add JWT middleware after implementing MSAL |
| 5 | Genome rollback applies without diff preview | Show diff before applying, similar to Comparison Page |
| 6 | Email approval token is unsigned | Sign with HMAC-SHA256 using a secret key for production |
| 7 | CORS allows all origins | Restrict to frontend domain in production |
| 8 | RG-level comparison/genome not yet supported | Dropdown shows "under development" for RG-only scopes |

---

## Technology Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite 6, React Router v6, Socket.IO client, Recharts, react-force-graph-2d |
| Backend | Node.js 18+, Express 4, Socket.IO 4, deep-diff |
| Azure SDK | `@azure/arm-resources`, `@azure/arm-subscriptions`, `@azure/arm-policy`, `@azure/storage-blob`, `@azure/storage-queue`, `@azure/data-tables`, `@azure/communication-email`, `@azure/openai`, `@azure/identity`, `@azure/arm-resourcegraph` |
| Serverless | Azure Functions v4 (Node 20, HTTP trigger) |
| Storage | Azure Blob Storage (JSON documents), Azure Storage Queue, Azure Table Storage (9 tables) |
| Eventing | Azure Event Grid (ResourceWriteSuccess/DeleteSuccess) |
| Orchestration | Azure Logic Apps |
| AI | Azure OpenAI (GPT-4o, temperature 0.3) |
| Email | Azure Communication Services |
| Config | Azure App Configuration |
| Telemetry | Application Insights |
| Auth | Azure DefaultAzureCredential (CLI locally, Managed Identity in cloud) |

---

*Azure Drift Intelligence Platform — ADIP v3.0 | CloudThat × Microsoft*
