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
- [Known Limitations](#known-limitations)

---

## Overview

ADIP continuously monitors Azure resource configurations, detects any deviation from a stored "golden baseline," classifies severity, notifies administrators, and enables one-click remediation or historical rollback — all in real time via a React dashboard.

**Core problem solved:** When teams manage Azure infrastructure, configurations drift — someone changes a firewall rule, modifies a tag, adjusts an SKU. Without a system to track these changes, environments become inconsistent, security posture degrades, and compliance is hard to prove. ADIP treats every Azure resource configuration as versioned state.

---

## Key Features

| Feature | Description |
|---|---|
| **Real-time change feed** | Any Azure resource change appears in the Live Activity feed via Event Grid → Storage Queue → Socket.IO |
| **Field-level diff** | Shows exactly what changed, who changed it, old value → new value |
| **Severity classification** | Critical / High / Medium / Low based on changed fields (rule-based + AI override) |
| **AI Security Analysis** | Azure OpenAI explains drift in plain English, re-classifies severity with context |
| **AI Anomaly Detection** | Analyses last 50 drift records for unusual patterns, off-hours activity, repeated actors |
| **Auto-remediation** | Low severity: instant ARM PUT revert. Critical/High/Medium: email approval flow |
| **Email alerts** | HTML email via Azure Communication Services with Approve/Reject buttons |
| **Golden baseline management** | Promote any config as the reference state via UI or API |
| **Configuration Genome** | Versioned snapshot history — auto-saved on every change, manual save with labels, rollback to any point |
| **Azure Policy compliance** | Shows policy compliance state alongside drift data |
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
[Azure Function: detectDrift]
  - Fetches live ARM config
  - Diffs against baseline blob
  - Writes drift record
  - Sends ACS email alert
  - POSTs to Express /internal/drift-event

[Azure OpenAI] ←── aiService.js (explain, re-classify, recommend, anomalies)
[Azure Communication Services] ←── alertService.js (HTML email with approve/reject)
[Azure Policy Insights] ←── policyService.js (compliance state)
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
│   ├── pages/
│   │   ├── LoginPage.jsx             # Local credential login (SSO-ready)
│   │   ├── DashboardPage.jsx         # Resource selection, JSON viewer, live feed
│   │   ├── ComparisonPage.jsx        # Baseline vs live diff, remediation
│   │   └── GenomePage.jsx            # Versioned snapshot timeline + rollback
│   ├── hooks/
│   │   ├── useDriftSocket.js         # Socket.IO real-time hook (gated behind Submit)
│   │   └── useAzureScope.js          # Subscription/RG/resource loader with demo fallback
│   ├── context/
│   │   └── DashboardContext.jsx      # Persistent dashboard state across navigation
│   ├── components/
│   │   ├── Sidebar.jsx               # Collapsible nav sidebar
│   │   ├── JsonTree.jsx              # Interactive collapsible JSON tree viewer
│   │   ├── MicrosoftLogo.jsx         # Microsoft 4-square logo component
│   │   └── CloudThatLogo.jsx         # CloudThat brand logo component
│   └── services/
│       ├── api.js                    # All frontend REST API calls
│       └── auth.js                   # SSO configuration (MSAL-ready)
│
├── adip-backend/
│   ├── express-api/                  # Node.js Express API (port 3001)
│   │   └── src/
│   │       ├── app.js                # Server entry, Socket.IO, queue poller start
│   │       ├── routes/
│   │       │   ├── subscriptions.js
│   │       │   ├── resourceGroups.js
│   │       │   ├── resources.js
│   │       │   ├── configuration.js
│   │       │   ├── scan.js
│   │       │   ├── drift.js
│   │       │   ├── baseline.js
│   │       │   ├── baselineUpload.js # ARM template + raw JSON upload
│   │       │   ├── compare.js        # Manual drift check + AI analysis
│   │       │   ├── remediate.js      # Low-severity auto-remediate via ARM PUT
│   │       │   ├── remediateRequest.js # Email approval flow for high/critical
│   │       │   ├── remediateDecision.js # Approve/Reject handler (email link)
│   │       │   ├── genome.js         # Snapshot CRUD, promote, rollback
│   │       │   ├── seed.js           # Seed live config as golden baseline
│   │       │   ├── policy.js         # Azure Policy compliance query
│   │       │   └── ai.js             # AI explain, severity, recommend, anomalies
│   │       └── services/
│   │           ├── azureResourceService.js  # ARM SDK, child resources, API versioning
│   │           ├── blobService.js           # Blob Storage CRUD (baselines, drift, genome)
│   │           ├── queuePoller.js           # Storage Queue → diff → Socket.IO
│   │           ├── alertService.js          # HTML email via ACS with diff table
│   │           ├── aiService.js             # Azure OpenAI integration
│   │           ├── policyService.js         # Policy Insights client
│   │           └── signalrService.js        # Socket.IO broadcast helper
│   │
│   ├── function-app/                 # Azure Function (detectDrift)
│   │   └── detectDrift/
│   │       ├── index.js              # Core drift detection + email + Socket.IO notify
│   │       └── function.json         # HTTP trigger binding (authLevel: function)
│   │
│   └── logic-app/
│       ├── workflow.json             # Event Grid → filter → Function App
│       └── alert-workflow.json       # Drift alert → Express /alert/email
│
├── scripts/
│   └── sync-env.cjs                  # Validates root .env exists and is configured
│
├── .env.example                      # Single root env template (all variables)
├── .gitignore                        # Excludes .env files and node_modules
├── index.html
├── vite.config.js
├── package.json                      # Frontend deps + npm scripts
└── README.md
```

---

## Quick Start

### 1. Clone and install all dependencies

```bash
# Clone the repository
git clone <repo-url>
cd ADIP-main

# Install all dependencies (frontend + Express API + Function App)
npm run install:all
```

Or manually:

```bash
# Frontend
npm install

# Express API backend
cd adip-backend/express-api
npm install

# Function App
cd ../function-app
npm install
```

### 2. Configure environment variables

```bash
# Single root .env file drives everything
cp .env.example .env
```

Open `.env` and fill in all Azure resource values. See the [Environment Variables Reference](#environment-variables-reference) section below for where to find each value.

> **Note:** The Express API loads from root `.env` via `require('dotenv').config({ path: '../../.env' })`. The Function App does the same. Vite reads `VITE_*` variables automatically. You only need **one `.env` file** at the project root.

### 3. Authenticate with Azure

```bash
az login
# Select the subscription containing your Azure resources
az account set --subscription "<your-subscription-id>"
```

### 4. Run locally

```bash
# Terminal 1 — Express API (port 3001)
cd adip-backend/express-api
npm start

# Terminal 2 — Frontend (port 5173)
# From project root:
npm run dev
```

Open [http://localhost:5173](http://localhost:5173)

### 5. (Optional) Run Express API in dev mode with auto-reload

```bash
cd adip-backend/express-api
npm run dev   # uses nodemon
```

---

## Environment Variables Reference

All variables live in the **root `.env` file**.

```env
# ── Server ────────────────────────────────────────────────────────────────────
PORT=3001

# ── Azure Storage (Blob + Queue) ──────────────────────────────────────────────
# Azure Portal → Storage Account → Security + networking → Access keys → Connection string
STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=<account>;AccountKey=<key>;EndpointSuffix=core.windows.net
STORAGE_QUEUE_NAME=resource-changes
QUEUE_POLL_INTERVAL_MS=5000

# ── Azure Identity ────────────────────────────────────────────────────────────
# Azure Portal → Subscriptions → your subscription → Subscription ID
AZURE_SUBSCRIPTION_ID=<your-subscription-id>
# Azure Portal → Azure Active Directory → Overview → Tenant ID
AZURE_TENANT_ID=<your-tenant-id>

# ── Azure Function App ────────────────────────────────────────────────────────
FUNCTION_APP_URL=https://<your-func>.azurewebsites.net/api

# ── Express API URLs (used in email approval links + Function App callback) ───
EXPRESS_API_URL=http://localhost:3001          # Set to App Service URL when deployed
EXPRESS_PUBLIC_URL=http://localhost:3001       # Must be publicly reachable for email links

# ── Azure Event Grid ──────────────────────────────────────────────────────────
EVENTGRID_TOPIC_ENDPOINT=https://<your-eg-topic>.eventgrid.azure.net/api/events
EVENTGRID_TOPIC_KEY=<your-eventgrid-key>

# ── Drift Alert Logic App ─────────────────────────────────────────────────────
ALERT_LOGIC_APP_URL=https://prod-xx.westus2.logic.azure.com/workflows/...

# ── Azure Communication Services (Email Alerts) ───────────────────────────────
# Azure Portal → Communication Services → Keys → Connection string
COMMS_CONNECTION_STRING=endpoint=https://<your-comms>.communication.azure.com/;accesskey=<key>
# Azure Portal → Email Communication Services → Domains → MailFrom address
SENDER_ADDRESS=DoNotReply@<your-domain>.azurecomm.net
ALERT_RECIPIENT_EMAIL=admin@yourcompany.com   # Comma-separated for multiple recipients

# ── Azure OpenAI ──────────────────────────────────────────────────────────────
# Azure Portal → Azure OpenAI → Keys and Endpoint
AZURE_OPENAI_ENDPOINT=https://<your-openai>.openai.azure.com/
AZURE_OPENAI_KEY=<your-openai-key>
AZURE_OPENAI_DEPLOYMENT=adip-gpt              # Must match deployment name in Azure OpenAI Studio

# ── Frontend (Vite reads these automatically) ─────────────────────────────────
VITE_API_BASE_URL=http://localhost:3001/api   # Change to App Service URL when deployed
VITE_SOCKET_URL=http://localhost:3001         # Without /api suffix
VITE_AZURE_CLIENT_ID=                         # Azure AD App Registration client ID (leave empty for local login)
VITE_AZURE_TENANT_ID=<your-tenant-id>         # Required only when SSO is enabled
```

---

## Running Locally

### Full setup from scratch

```bash
git clone <repo>
cd ADIP-main

npm run install:all          # installs frontend + Express API + Function App deps
cp .env.example .env         # copy environment template
# → fill in all Azure values in .env

az login                     # authenticate with Azure CLI

# Terminal 1
cd adip-backend/express-api
npm start                    # starts Express on port 3001 + Socket.IO + queue poller

# Terminal 2 (from project root)
npm run dev                  # starts Vite dev server on port 5173
```

### Available npm scripts (root `package.json`)

| Script | What it does |
|---|---|
| `npm run install:all` | Installs deps for frontend, Express API, and Function App |
| `npm run env:sync` | Validates `.env` exists and is non-empty |
| `npm run dev` | Starts Vite frontend dev server |
| `npm run dev:api` | Starts Express API with nodemon |
| `npm run build` | Builds frontend for production |
| `npm run deploy:func` | Deploys Function App to Azure |

---

## Azure Resources Required

| Resource | Name (example) | Purpose |
|---|---|---|
| Storage Account | `adipstore001` | Blob containers (baselines, drift-records, baseline-genome) + Storage Queue |
| Storage Queue | `resource-changes` | Buffers Event Grid change events for the queue poller |
| Azure Function App | `adip-func-001` | Serverless drift detection (Node 20, Linux Consumption) |
| Event Grid Topic | `adip-eg-topic` | Receives ARM resource change events |
| Logic App | `adip-logic-app` | Routes Event Grid → Function App (with noise filtering) |
| Logic App | `adip-drift-alert` | Forwards drift alerts → Express `/alert/email` |
| Azure Communication Services | `adip-comms` | Sends HTML email alerts with Approve/Reject buttons |
| Azure OpenAI | `adip-openai` | GPT-4o deployment for AI analysis features |
| (Optional) Azure Policy | — | Read-only policy compliance display |

### Storage Blob Containers (created in `adipstore001`)

| Container | Key format | Written by |
|---|---|---|
| `baselines` | `base64url(resourceId).json` | POST /baselines, genome promote, remediation reject |
| `drift-records` | `timestamp_base64url(resourceId).json` | detectDrift Function, POST /compare |
| `baseline-genome` | `timestamp_base64url(resourceId).json` | Queue poller (auto), POST /genome/save |
| `drift-history` | — | Reserved for future use |

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

After deploying, update the Logic App's `Call_DetectDrift_Function` action URL with the new function key:

```
https://adip-func-001.azurewebsites.net/api/detectDrift?code=<YOUR_FUNCTION_KEY>
```

Also set these Application Settings on the Function App in Azure Portal:
- `STORAGE_CONNECTION_STRING`
- `COMMS_CONNECTION_STRING`
- `SENDER_ADDRESS`
- `ALERT_RECIPIENT_EMAIL`
- `EXPRESS_API_URL` (set to your deployed Express App Service URL)
- `EXPRESS_PUBLIC_URL`

---

## Login Credentials (Local)

The app uses a hardcoded dummy user list for local development. SSO via Azure AD is supported when `VITE_AZURE_CLIENT_ID` is configured.

| Username | Password | Display Name |
|---|---|---|
| `admin` | `Admin@123` | Admin User |
| `saksham` | `Saksham@123` | Saksham Midha |
| `demo` | `Demo@123` | Demo User |

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
POST /scan/start
```

### Baseline Management

```
GET  /baselines?subscriptionId=&resourceId=
POST /baselines
POST /baselines/upload        # Accepts raw ARM config or ARM template export
POST /seed-baseline           # Seeds golden baseline from current live config
```

### Drift Detection

```
POST /compare
GET  /drift-events?subscriptionId=&resourceGroup=&severity=&limit=
```

### Monitoring

```
POST /monitor/start
POST /monitor/stop
POST /cache-state             # Seeds in-memory liveStateCache (called after Submit)
```

### Remediation

```
POST /remediate               # Low severity: immediate ARM PUT revert
POST /remediate-request       # High/critical: sends approval email
GET  /remediate-decision?action=approve|reject&token=<base64url>
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
```

### Policy & Alerts

```
GET  /policy/compliance?subscriptionId=&resourceGroupId=&resourceId=
POST /alert/email             # Internal: called by Logic App
POST /internal/drift-event    # Internal: called by Function App → Socket.IO
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
| 5 | `liveStateCache` is in-memory | Persist to Azure Table Storage (partially wired in `queuePoller.js`) |
| 6 | Function App uses Node 20 (EOL April 2026) | Upgrade to Node 24 in Function App settings |
| 7 | Genome rollback applies without diff preview | Show diff before applying, similar to Comparison Page |
| 8 | Email approval token is unsigned | Sign with HMAC-SHA256 using a secret key for production |
| 9 | CORS allows all origins | Restrict to frontend domain in production |
| 10 | Live feed broken when "All resources" selected | Empty string vs null socket room (fix pending) |

---

## Technology Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite 6, React Router v6, Socket.IO client, Recharts |
| Backend | Node.js 18+, Express 4, Socket.IO 4, deep-diff |
| Azure SDK | `@azure/arm-resources`, `@azure/arm-subscriptions`, `@azure/arm-policyinsights`, `@azure/storage-blob`, `@azure/storage-queue`, `@azure/data-tables`, `@azure/communication-email`, `@azure/openai`, `@azure/identity` |
| Serverless | Azure Functions v4 (Node 20, HTTP trigger) |
| Storage | Azure Blob Storage (JSON documents), Azure Storage Queue |
| Eventing | Azure Event Grid (ResourceWriteSuccess/DeleteSuccess) |
| Orchestration | Azure Logic Apps |
| AI | Azure OpenAI (GPT-4o, temperature 0.3) |
| Email | Azure Communication Services |
| Auth | Azure DefaultAzureCredential (CLI locally, Managed Identity in cloud) |

---

*Azure Drift Intelligence Platform — ADIP v2.0 | CloudThat × Microsoft*