# ADIP Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           USER BROWSER                                          │
│                                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  Dashboard   │  │  Comparison  │  │  Analytics   │  │  Drift Scanner   │   │
│  │  - KPI cards │  │  - Live diff │  │  - Trends    │  │  - Live config   │   │
│  │  - Changes   │  │  - Remediate │  │  - Impact    │  │  - Dependency    │   │
│  │  - Top drift │  │  - Schedule  │  │  - Reports   │  │    Graph         │   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────────┘   │
│         │                 │                  │                  │               │
│  ┌──────┴─────────────────┴──────────────────┴──────────────────┴───────────┐  │
│  │              React 18 + Vite (port 5173)  ·  Socket.IO client            │  │
│  │              src/services/api.js  ·  socketSingleton.js                  │  │
│  └──────────────────────────────────┬────────────────────────────────────────┘  │
└─────────────────────────────────────┼───────────────────────────────────────────┘
                                      │ REST + WebSocket
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                     EXPRESS API  (Node.js, port 3001)                           │
│                                                                                 │
│  Routes:                                                                        │
│  /api/compare          /api/remediate        /api/genome/*                      │
│  /api/drift-impact     /api/attribution      /api/reports/*                     │
│  /api/cost-estimate    /api/cost-savings     /api/suppression-rules             │
│  /api/remediation-schedule                  /api/dependency-graph               │
│  /api/compliance-impact  /api/ai/*          /api/user-preferences               │
│                                                                                 │
│  Services:                                                                      │
│  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────────────────┐  │
│  │  queuePoller    │  │  alertService    │  │  policyEnforcementService    │  │
│  │  (5s interval)  │  │  (ACS email)     │  │  (Azure Policy SDK)          │  │
│  └────────┬────────┘  └──────────────────┘  └──────────────────────────────┘  │
│           │                                                                     │
│  ┌────────┴────────┐  ┌──────────────────┐  ┌──────────────────────────────┐  │
│  │  blobService    │  │  aiService       │  │  dependencyGraphService      │  │
│  │  (Blob+Table)   │  │  (Azure OpenAI)  │  │  (Resource Graph API)        │  │
│  └─────────────────┘  └──────────────────┘  └──────────────────────────────┘  │
│                                                                                 │
│  Socket.IO server  ·  Application Insights SDK                                 │
└──────────────────────────────┬──────────────────────────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────────────────┐
│  Azure Storage  │  │  Azure OpenAI   │  │       Azure Function App            │
│  (adipstore001) │  │  (adip-openai)  │  │       (adip-func-001)               │
│                 │  │  GPT-4o         │  │                                     │
│  Blob:          │  │  - explainDrift │  │  ┌─────────────┐ ┌───────────────┐  │
│  · baselines    │  │  - recommend    │  │  │ detectDrift │ │eventGridRouter│  │
│  · drift-records│  └─────────────────┘  │  │ (HTTP)      │ │(HTTP)         │  │
│  · baseline-    │                       │  └─────────────┘ └───────────────┘  │
│    genome       │  ┌─────────────────┐  │  ┌─────────────┐ ┌───────────────┐  │
│  · drift-reports│  │  Azure Comms    │  │  │ sendAlert   │ │driftAlertRouter│ │
│  · all-changes  │  │  (adip-comms)   │  │  │ (HTTP)      │ │(HTTP)         │  │
│                 │  │  ACS Email      │  │  └─────────────┘ └───────────────┘  │
│  Table:         │  └─────────────────┘  │  ┌─────────────┐ ┌───────────────┐  │
│  · changesIndex │                       │  │processSchedules│afterHoursAlert│  │
│  · driftIndex   │  ┌─────────────────┐  │  │(Timer 1min) │ │(Timer 19:00)  │  │
│  · genomeIndex  │  │  Azure Policy   │  │  └─────────────┘ └───────────────┘  │
│  · suppressionR │  │  (ARM SDK)      │  └─────────────────────────────────────┘
│  · remediationS │  │  Assignments    │
│  · policyAssign │  └─────────────────┘
│  · remediationSa│
│  · userPrefs    │  ┌─────────────────┐
│  · monitorSess  │  │  Azure Resource │
│                 │  │  Graph API      │
│  Queue:         │  │  (KQL queries)  │
│  · resource-    │  └─────────────────┘
│    changes      │
└─────────────────┘  ┌─────────────────┐
                     │  Azure App      │
                     │  Configuration  │
                     │  (adip-appconfig│
                     │  policyMap)     │
                     └─────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                         AZURE INFRASTRUCTURE                                    │
│                                                                                 │
│  ┌──────────────────┐         ┌──────────────────────────────────────────────┐ │
│  │  Azure Event     │         │           ARM (Azure Resource Manager)       │ │
│  │  Grid Topic      │         │                                              │ │
│  │  (adip-eg-topic) │         │  Any resource change in subscription         │ │
│  │                  │         │  (storage, VM, NSG, KeyVault, etc.)          │ │
│  │  Subscriptions:  │         └──────────────────────────────────────────────┘ │
│  │  · adip-sub-     │                          │                               │
│  │    changes       │◄─────────────────────────┘                               │
│  │    → Storage     │  ResourceWriteSuccess /                                  │
│  │    Queue         │  ResourceDeleteSuccess events                             │
│  │  · adip-sub-     │                                                          │
│  │    logic         │                                                          │
│  │    → eventGrid   │                                                          │
│  │    RouterFn      │                                                          │
│  └──────────────────┘                                                          │
└─────────────────────────────────────────────────────────────────────────────────┘

DATA FLOW — Drift Detection:
─────────────────────────────
ARM change → Event Grid → Storage Queue → queuePoller → changesIndex Table
                       → eventGridRouter Fn → detectDrift Fn → drift-records blob
                                                              → driftIndex Table
                                                              → Socket.IO → Browser

DATA FLOW — Remediation:
────────────────────────
User clicks "Apply Fix Now"
→ POST /api/remediate
→ ARM PUT (revert to baseline)
→ policyEnforcementService (create Azure Policy assignment)
→ recordRemediationSavings (cost delta → remediationSavings Table)

High/Critical: POST /api/remediate-request
→ ACS email (Approve/Reject links)
→ GET /api/remediate-decision?action=approve
→ ARM PUT + policy enforcement + savings recording
```
