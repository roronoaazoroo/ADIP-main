#Feature 1

## Best Feature to Implement: Scheduled Compliance Reports



Why this wins:

- Uses 3 services you already have deployed: scanSubscription Function, ACS email, driftIndex Table

- Zero new Azure resources needed

- Adds tangible enterprise value (auditors, managers want PDF/email reports)

- Minimal new code — one new Function + one new frontend page

- Completely decoupled from existing features — zero risk of breaking anything


### Architecture



Azure Logic App (weekly timer trigger)

&#x20; → POST /api/reports/generate (Express)

&#x20; → Query driftIndex + changesIndex Tables

&#x20; → Build HTML report

&#x20; → Send via ACS email (already configured)

&#x20; → Save report blob to new 'compliance-reports' container

&#x20; → Return report URL



Frontend: new "Reports" page

&#x20; → Lists saved reports from blob storage

&#x20; → Download / view in browser

&#x20; → Manual "Generate Now" button





Why Logic App for the timer instead of a Function timer?

You already have Logic Apps deployed. A Logic App timer trigger with a single HTTP action requires zero code — just configure the

schedule and point it at Express. No new Function deployment needed.



### Backend approach (Express route — routes/reports.js)



POST /api/reports/generate

&#x20; 1. Query changesIndex — total changes this week

&#x20; 2. Query driftIndex — drift by severity (critical/high/medium/low)

&#x20; 3. Query driftIndex — top 5 most-drifted resources

&#x20; 4. Build HTML report (inline, no template engine needed)

&#x20; 5. writeBlob('compliance-reports', weekKey, htmlReport)

&#x20; 6. Send via ACS EmailClient (already in alertService pattern)

&#x20; 7. Return { reportUrl, stats }



GET /api/reports

&#x20; → listBlobsFlat('compliance-reports')

&#x20; → Return list of reports with dates



GET /api/reports/:key

&#x20; → readBlob('compliance-reports', key)

&#x20; → Return HTML content





Follows guidelines:

\- Single responsibility: reportService.js owns report generation logic

\- No new dependencies: uses existing blobService, alertService patterns

\- Environment config: REPORT\_RECIPIENT\_EMAIL, REPORT\_SCHEDULE

\- Idempotent: same week key overwrites previous report for that week


### Frontend approach (new ReportsPage.jsx)



Reports page:

&#x20; - List of past reports (date, stats summary, download link)

&#x20; - "Generate Report Now" button → POST /api/reports/generate

&#x20; - Inline HTML viewer (iframe or dangerouslySetInnerHTML)

&#x20; - Filter by date range





No new npm packages needed — uses existing fetchRecentChanges pattern.




### What the report contains



Weekly Azure Drift Intelligence Report

Period: Apr 21 – Apr 27, 2026



Summary

&#x20; Total ARM events:     134

&#x20; Drift detected:       12

&#x20; Auto-remediated:      8

&#x20; Pending approval:     2

&#x20; Critical/High alerts: 3



By Severity

&#x20; Critical: 1  High: 2  Medium: 4  Low: 5



Top Drifted Resources

&#x20; 1. adipstore001 (Storage) — 5 drift events

&#x20; 2. testing-vm-nsg (NSG)   — 3 drift events

&#x20; 3. adip-func-001 (Sites)  — 2 drift events



Unresolved Drift

&#x20; \[table of open items with resource, severity, detected date]





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Implementation plan (in order)



1\. Create compliance-reports blob container

2\. Write services/reportService.js — query Tables, build HTML

3\. Write routes/reports.js — 3 endpoints

4\. Register route in app.js

5\. Create Logic App timer (weekly, Monday 08:00) → POST to Express

6\. Add ReportsPage.jsx + route in React Router

7\. Add "Reports" link to NavBar



Estimated new code: \~200 lines total across 3 files. Everything else is configuration.



Want me to implement this?



**Feature 2**



72% λ > give implementation plan for this  Drift Prediction — AI-powered, forward-looking, unique



> ## Drift Prediction — Implementation Plan



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### What it does

Analyses each resource's drift history and predicts:

\- \*\*Likelihood\*\* of drifting in the next 7 days (Low/Medium/High)

\- \*\*Predicted date\*\* of next drift based on average frequency

\- \*\*Which fields\*\* are most likely to change (based on past patterns)

\- \*\*Why\*\* — plain English from GPT-4o



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Architecture



Frontend (DriftScanner — new "Predictions" tab)

&#x20; → GET /api/predictions?subscriptionId=\&resourceId=

&#x20; → Express predictions.js route

&#x20; → predictionsService.js (business logic)

&#x20;     → Query driftIndex Table for resource history

&#x20;     → Compute frequency, field patterns, last drift date

&#x20;     → Call aiOperations Function (new 'predict' operation)

&#x20;         → GPT-4o analyses pattern + returns prediction

&#x20; → Cache result in Table Storage (predictions table, 1hr TTL)

&#x20; → Return prediction to frontend





No new Azure services needed. Uses:

\- driftIndex Table (already exists)

\- aiOperations Function (already deployed — add one new case)

\- New predictionsIndex Table (auto-created on first write)



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Backend — 3 files



services/predictionsService.js — business logic only

computeDriftPattern(driftHistory):

&#x20; - driftFrequencyDays = avg days between drift events

&#x20; - daysSinceLastDrift = now - lastDriftDate

&#x20; - likelihoodScore = daysSinceLastDrift / driftFrequencyDays (0-1+)

&#x20; - topDriftedFields = most common changed paths across history

&#x20; - returns { frequencyDays, daysSinceLastDrift, likelihoodScore, topDriftedFields }



getPrediction(subscriptionId, resourceId):

&#x20; 1. Check predictionsIndex Table — return cached if < 1hr old

&#x20; 2. Query driftIndex for last 30 records for this resource

&#x20; 3. If < 3 records → return { insufficient: true } (need history)

&#x20; 4. computeDriftPattern(history)

&#x20; 5. Call aiOperations 'predict' → GPT-4o plain English prediction

&#x20; 6. Save to predictionsIndex Table with TTL

&#x20; 7. Return prediction





routes/predictions.js — thin route, delegates to service

GET /api/predictions?subscriptionId=\&resourceId=

&#x20; → validate inputs

&#x20; → return getPrediction(subscriptionId, resourceId)





aiOperations/index.js — add one new case

case 'predict':

&#x20; receives { resourceId, resourceType, frequencyDays, daysSinceLastDrift,

&#x20;            topDriftedFields, lastSeverity, recentDriftSummary }

&#x20; prompt: "You are an Azure security analyst. Based on this resource's

&#x20;          drift history, predict whether it will drift in the next 7 days

&#x20;          and which fields are most at risk. Respond ONLY with valid JSON:

&#x20;          { likelihood: 'low|medium|high', predictedDays: number,

&#x20;            fieldsAtRisk: string\[], reasoning: string }"

&#x20; maxTokens: 200





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Frontend — 1 new tab in DriftScanner



After Submit, alongside the existing "Policy Violations" and "AI Anomalies" sections, add a "Drift Prediction" card:



┌─────────────────────────────────────────────────────┐

│  AI Drift Prediction                                 │

│                                                      │

│  Likelihood: HIGH                                    │

│  Predicted next drift: \~3 days                       │

│                                                      │

│  Fields at risk:                                     │

│    • properties.networkAcls.defaultAction            │

│    • tags.environment                                │

│                                                      │

│  "This storage account has drifted 4 times in the   │

│   last 30 days, averaging every 7 days. The last    │

│   drift was 4 days ago. Network ACL changes are     │

│   the most common pattern."                         │

│                                                      │

│  Based on 4 drift events over 30 days               │

└─────────────────────────────────────────────────────┘





Color coded: Low=green, Medium=amber, High=red.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Data flow



User clicks Submit on DriftScanner

→ (existing) fetchAnomalies() runs

→ (new) fetchDriftPrediction(subscriptionId, resourceId) runs in parallel

→ GET /api/predictions

→ predictionsService: query driftIndex → compute pattern → call AI

→ setDriftPrediction(result)

→ Prediction card renders below anomalies





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Implementation order



| Step | File | What |

|---|---|---|

| 1 | aiOperations/index.js | Add predict case |

| 2 | services/predictionsService.js | Pattern computation + AI call + cache |

| 3 | routes/predictions.js | GET endpoint |

| 4 | app.js | Register route |

| 5 | src/services/api.js | fetchDriftPrediction() |

| 6 | src/pages/DriftScanner.jsx | Prediction card UI |

| 7 | .env | PREDICTION\_CACHE\_TTL\_MS=3600000 |



Estimated new code: \~150 lines across 4 files.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Guidelines compliance



| Guideline | How met |

|---|---|

| Single responsibility | predictionsService.js owns all prediction logic |

| Separate business from infrastructure | Pattern computation separate from AI call separate from cache |

| No new Azure services | Reuses driftIndex, aiOperations, adds one Table |

| YAGNI | Only builds what's needed — no over-engineering |

| Idempotent | Same resourceId always produces same cache key |

| Fallback | If AI call fails, returns computed pattern without AI text |

| Input validation | subscriptionId and resourceId required, sanitised |



Want me to implement it?





Feature 3



give one for this as well Resource Dependency Graph — visual, demonstrates deep Azure knowledge



> ## Resource Dependency Graph — Implementation Plan



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### What it does

Shows a visual graph of how Azure resources in a resource group are connected — VNet → Subnet → NSG → NIC → VM → Disk. When drift is

detected on any node, that node turns red. Clicking a node navigates to its ComparisonPage.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Architecture



Frontend (new "Dependency Graph" tab in DriftScanner)

&#x20; → GET /api/dependency-graph?subscriptionId=\&resourceGroupId=

&#x20; → Express dependencyGraph.js route

&#x20; → dependencyGraphService.js

&#x20;     → ARM SDK: listByResourceGroup (already used)

&#x20;     → Parse resource properties to extract relationships

&#x20;     → Return { nodes\[], edges\[] }

&#x20; → Frontend renders with D3.js or React Flow





No new Azure services. Uses:

\- ARM resources.listByResourceGroup (already in azureResourceService.js)

\- Existing driftIndex Table to colour nodes red if drifted recently



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### How relationships are extracted



ARM resource properties already contain references to related resources:



NIC.properties.ipConfigurations\[].properties.subnet.id → Subnet

NIC.properties.ipConfigurations\[].properties.publicIPAddress.id → PublicIP

VM.properties.networkProfile.networkInterfaces\[].id → NIC

VM.properties.storageProfile.osDisk.managedDisk.id → Disk

Subnet.properties.networkSecurityGroup.id → NSG

Subnet.properties.routeTable.id → RouteTable

VNet contains Subnets (child resources)





No ARM Graph API needed — all this is in the standard GET response.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Backend — 2 files



services/dependencyGraphService.js

buildDependencyGraph(subscriptionId, resourceGroupId):

&#x20; 1. getResourceConfig(subscriptionId, resourceGroupId, null)

&#x20;    → returns { resources: \[...] } — already implemented

&#x20; 2. For each resource: extract outbound references from properties

&#x20;    → parseReferences(resource) → \[{ targetId, relationshipType }]

&#x20; 3. Query driftIndex for resources drifted in last 7 days

&#x20;    → mark those nodes as drifted=true

&#x20; 4. Return {

&#x20;      nodes: \[{ id, name, type, location, drifted, severity }],

&#x20;      edges: \[{ source, target, label }]

&#x20;    }



parseReferences(resource):

&#x20; - type-specific extractors (NIC, VM, Subnet, etc.)

&#x20; - returns array of { targetId, label } pairs

&#x20; - only references within the same resource group





routes/dependencyGraph.js

GET /api/dependency-graph?subscriptionId=\&resourceGroupId=

&#x20; → validate inputs

&#x20; → cache result 5 minutes (same pattern as getRecentChanges)

&#x20; → return buildDependencyGraph(...)





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Frontend — new tab in DriftScanner



After Submit, add a "Dependency Graph" tab alongside "Live Current Config" and "Live Activity Feed":



Library choice: react-force-graph-2d — 1 package, \~50KB, no D3 knowledge needed, handles force-directed layout automatically.



npm install react-force-graph-2d





Visual design:

Nodes:

&#x20; - Circle, labelled with resource name

&#x20; - Color by type: VNet=blue, VM=purple, NSG=orange, Storage=teal

&#x20; - Red border + pulsing if drifted recently

&#x20; - Size proportional to number of connections



Edges:

&#x20; - Labelled arrows: "uses NSG", "attached to", "hosted in"



Interactions:

&#x20; - Click node → navigate to ComparisonPage for that resource

&#x20; - Hover → tooltip showing resource type, location, last drift date

&#x20; - Zoom/pan built into react-force-graph-2d





Example graph for rg-adip:

\[VNet: adip-vnet]

&#x20;   │ contains

\[Subnet: default]

&#x20;   │ protected by

\[NSG: testing-vm-nsg] ← RED (drifted 2 days ago)

&#x20;   │

\[NIC: testing-vm-nic]

&#x20;   │ attached to

\[VM: testing-vm] ──── \[Disk: testing-vm\_OsDisk]

&#x20;   │

\[PublicIP: testing-vm-ip]





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Data flow



User clicks Submit → selects resource group

→ (existing) fetchResourceConfiguration() runs

→ (new) fetchDependencyGraph(subscriptionId, resourceGroupId) runs

→ GET /api/dependency-graph

→ dependencyGraphService: list resources → parse refs → mark drifted

→ setGraphData({ nodes, edges })

→ Graph tab renders with react-force-graph-2d





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Implementation order



| Step | File | What |

|---|---|---|

| 1 | services/dependencyGraphService.js | Resource listing + ref parsing + drift overlay |

| 2 | routes/dependencyGraph.js | GET endpoint with 5min cache |

| 3 | app.js | Register route |

| 4 | src/services/api.js | fetchDependencyGraph() |

| 5 | package.json | Add react-force-graph-2d |

| 6 | src/pages/DriftScanner.jsx | New tab + graph component |

| 7 | src/components/DependencyGraph.jsx | Graph rendering component |



Estimated new code: \~180 lines across 4 files.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Guidelines compliance



| Guideline | How met |

|---|---|

| Single responsibility | dependencyGraphService.js owns graph logic, DependencyGraph.jsx owns rendering |

| Reuse shared code | Uses existing getResourceConfig() — no duplicate ARM calls |

| No new Azure services | Pure ARM SDK + existing driftIndex Table |

| KISS | react-force-graph-2d handles all layout math — no custom D3 |

| Stateless | Graph computed fresh each request, cached 5min |

| Input validation | subscriptionId + resourceGroupId required and sanitised |

| Fallback | If graph build fails, returns empty graph with error message — tab still renders |

| YAGNI | Only parses relationship types that exist in rg-adip (NIC, VM, NSG, VNet, Subnet) |





Feature 4







\## Compliance Framework Mapping — Implementation Plan



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### What it does

When drift is detected, automatically identifies which compliance controls (CIS Azure, NIST, ISO 27001) are violated based on which

fields changed. Shows a "Compliance Impact" section on ComparisonPage and a dedicated Compliance Report page with cross-resource

violation aggregation.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 1 — adip-shared/compliance-map.json



Static mapping of ARM property paths to control IDs. No Azure service needed — pure JSON.



json

{

&#x20; "properties.minimumTlsVersion": {

&#x20;   "controls": \["CIS-Azure-3.1", "NIST-SC-8", "ISO27001-A.14.1.3"],

&#x20;   "description": "TLS version must be 1.2 or higher"

&#x20; },

&#x20; "properties.networkAcls.defaultAction": {

&#x20;   "controls": \["CIS-Azure-3.7", "NIST-SC-7"],

&#x20;   "description": "Storage network access must be restricted"

&#x20; },

&#x20; "properties.allowBlobPublicAccess": {

&#x20;   "controls": \["CIS-Azure-3.5", "NIST-AC-3"],

&#x20;   "description": "Public blob access must be disabled"

&#x20; },

&#x20; "properties.supportsHttpsTrafficOnly": {

&#x20;   "controls": \["CIS-Azure-3.1", "NIST-SC-8"],

&#x20;   "description": "HTTPS-only traffic must be enforced"

&#x20; },

&#x20; "properties.encryption.keySource": {

&#x20;   "controls": \["CIS-Azure-3.2", "NIST-SC-28", "ISO27001-A.10.1.1"],

&#x20;   "description": "Encryption key management"

&#x20; },

&#x20; "properties.networkAcls.ipRules": {

&#x20;   "controls": \["CIS-Azure-3.7", "NIST-SC-7"],

&#x20;   "description": "IP firewall rules changed"

&#x20; },

&#x20; "properties.accessPolicies": {

&#x20;   "controls": \["CIS-Azure-8.1", "NIST-AC-2", "ISO27001-A.9.2.1"],

&#x20;   "description": "Key Vault access policies changed"

&#x20; },

&#x20; "properties.securityRules": {

&#x20;   "controls": \["CIS-Azure-6.1", "NIST-SC-7", "ISO27001-A.13.1.1"],

&#x20;   "description": "NSG security rules changed"

&#x20; },

&#x20; "identity": {

&#x20;   "controls": \["CIS-Azure-9.1", "NIST-IA-2"],

&#x20;   "description": "Managed identity configuration changed"

&#x20; },

&#x20; "sku": {

&#x20;   "controls": \["ISO27001-A.17.2.1"],

&#x20;   "description": "Resource tier/SKU changed — availability impact"

&#x20; }

}





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 2 — Enrich drift records



adip-shared/complianceMapper.js — pure function, no Azure services:



js

'use strict'

const complianceMap = require('./compliance-map.json')



// Returns array of violated controls given a list of diff changes

function mapChangesToControls(changes) {

&#x20; const violatedControls = new Set()

&#x20; for (const change of changes) {

&#x20;   const changePath = change.path || ''

&#x20;   for (const \[mappedPath, mapping] of Object.entries(complianceMap)) {

&#x20;     if (changePath.startsWith(mappedPath) || changePath.includes(mappedPath)) {

&#x20;       mapping.controls.forEach(control => violatedControls.add(control))

&#x20;     }

&#x20;   }

&#x20; }

&#x20; return \[...violatedControls]

}



// Groups violated controls by framework prefix (CIS-Azure, NIST, ISO27001)

function groupByFramework(controls) {

&#x20; return controls.reduce((groups, control) => {

&#x20;   const framework = control.split('-').slice(0, 2).join('-')

&#x20;   groups\[framework] = groups\[framework] || \[]

&#x20;   groups\[framework].push(control)

&#x20;   return groups

&#x20; }, {})

}



module.exports = { mapChangesToControls, groupByFramework }





Enrich in detectDrift/index.js — add 2 lines after classifySeverity:

js

const { mapChangesToControls } = require('adip-shared/complianceMapper')

// ...

const violatedControls = mapChangesToControls(detectedChanges)

// add to driftRecord:

complianceControls: violatedControls,

complianceFrameworks: groupByFramework(violatedControls),





Same 2 lines in queuePoller.js enrichWithDiff().



Also add complianceControls to driftIndex Table upsert so it's queryable.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 3 — Backend endpoints



routes/compliance.js:



GET /api/compliance/report?subscriptionId=\&since=

&#x20; 1. Query driftIndex Table for all records with complianceControls not empty

&#x20; 2. Aggregate: count violations per control, per framework, per resource

&#x20; 3. Call GPT-4o (aiService) for executive summary (1 paragraph)

&#x20; 4. Return { summary, byFramework, byResource, topViolations, totalFindings }



GET /api/compliance/report/pdf?subscriptionId=

&#x20; 1. Build HTML report (same pattern as existing sendAlert HTML)

&#x20; 2. writeBlob('compliance-reports', weekKey, htmlContent)

&#x20; 3. Return blob URL

&#x20; 4. Optionally email via ACS (same alertService pattern)





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 4 — Frontend changes



ComparisonPage.jsx — add "Compliance Impact" section below the diff list:



┌─────────────────────────────────────────────────────┐

│  Compliance Impact                                   │

│                                                      │

│  This drift violates 3 compliance controls:         │

│                                                      │

│  CIS Azure  3.1  TLS version must be 1.2+           │

│  NIST       SC-8  Transport confidentiality          │

│  ISO 27001  A.14.1.3  Secure comms in app services  │

└─────────────────────────────────────────────────────┘





Data comes from fieldDifferences already computed — run mapChangesToControls client-side using the same JSON (import it as a static

asset).



New CompliancePage.jsx:



Compliance Report

&#x20; ├── Framework summary (bar chart — recharts already installed)

&#x20; │     CIS Azure: 8 violations

&#x20; │     NIST:      5 violations

&#x20; │     ISO 27001: 3 violations

&#x20; │

&#x20; ├── Top violated controls table

&#x20; │     Control ID | Description | Resources affected | Last violation

&#x20; │

&#x20; ├── Resources with most violations

&#x20; │

&#x20; ├── AI Executive Summary (GPT-4o paragraph)

&#x20; │

&#x20; └── Export PDF button → GET /api/compliance/report/pdf





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Implementation order



| Step | File | What |

|---|---|---|

| 1 | adip-shared/compliance-map.json | Static control mappings |

| 2 | adip-shared/complianceMapper.js | mapChangesToControls(), groupByFramework() |

| 3 | function-app/detectDrift/index.js | Enrich driftRecord with controls |

| 4 | express-api/src/services/queuePoller.js | Same enrichment |

| 5 | routes/compliance.js | 2 endpoints |

| 6 | app.js | Register route |

| 7 | src/services/api.js | fetchComplianceReport(), fetchCompliancePdf() |

| 8 | src/pages/ComparisonPage.jsx | Compliance Impact section |

| 9 | src/pages/CompliancePage.jsx | Full report page |

| 10 | src/App.jsx + NavBar.jsx | Add route + nav link |

| 11 | Deploy Function App | Push enriched detectDrift |



Estimated new code: \~250 lines across 6 files. Zero new Azure services.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Guidelines compliance



| Guideline | How met |

|---|---|

| Single responsibility | complianceMapper.js owns mapping logic only |

| DRY | Same JSON used by both Function App and frontend |

| No new Azure services | Blob Storage + GPT-4o + ACS all already deployed |

| Stateless | Mapping is pure function — same input always same output |

| YAGNI | Only maps paths that exist in rg-adip resource types |

| Idempotent | Re-running enrichment on same drift record produces same controls |

| Input validation | subscriptionId required, since defaults to 30 days |



Feature 4



\## Export Baseline as Terraform/Bicep — Implementation Plan



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### What it does

From the Genome page or ComparisonPage, export any stored baseline as a Bicep or ARM template file. One click → downloads a

deployable infrastructure file. Uses the ARM /exportTemplate API which Azure already provides — zero template generation code needed.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### How ARM Export works



Azure has a built-in REST endpoint:

POST https://management.azure.com/subscriptions/{sub}/resourceGroups/{rg}/exportTemplate?api-version=2021-04-01

Body: { "resources": \["/subscriptions/.../resourceId"], "options": "IncludeParameterDefaultValue" }



Returns a complete ARM template JSON. Azure does all the work.



For Bicep: Azure CLI has az bicep decompile but that requires local CLI. Better approach: use Azure Bicep Decompile REST API (preview)

or simply offer ARM template export (which is production-ready) and label it clearly.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Architecture



Frontend button: "Export as ARM Template" / "Export as Bicep"

&#x20; → POST /api/export/baseline

&#x20; → exportService.js

&#x20;     → Call ARM /exportTemplate API (bearer token from DefaultAzureCredential)

&#x20;     → For Bicep: call Azure Bicep Decompile endpoint

&#x20;     → Return template JSON/Bicep string

&#x20; → Frontend triggers file download





No new Azure services. Uses:

\- ARM Export Template API (built into Azure, free)

\- DefaultAzureCredential (already used everywhere)

\- Existing baseline blob (already stored)



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Backend — 2 files



services/exportService.js — single responsibility: call ARM export API



js

'use strict'

const { DefaultAzureCredential } = require('@azure/identity')



const ARM\_ENDPOINT = process.env.ARM\_ENDPOINT || 'https://management.azure.com'

const ARM\_EXPORT\_API\_VERSION = process.env.ARM\_EXPORT\_API\_VERSION || '2021-04-01'



const credential = new DefaultAzureCredential()



// Calls ARM /exportTemplate to get a deployable ARM template for a resource

async function exportResourceAsArmTemplate(subscriptionId, resourceGroupId, resourceId) {

&#x20; const tokenResponse = await credential.getToken(`${ARM\_ENDPOINT}/.default`)

&#x20; const exportUrl = `${ARM\_ENDPOINT}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupId}/exportTemplate?api-version=${ARM\_EXPORT\_API\_VERSION}`



&#x20; const httpResponse = await fetch(exportUrl, {

&#x20;   method:  'POST',

&#x20;   headers: { 'Authorization': `Bearer ${tokenResponse.token}`, 'Content-Type': 'application/json' },

&#x20;   body:    JSON.stringify({

&#x20;     resources: \[resourceId],

&#x20;     options:   'IncludeParameterDefaultValue,IncludeComments',

&#x20;   }),

&#x20; })



&#x20; if (!httpResponse.ok) {

&#x20;   const errorBody = await httpResponse.text()

&#x20;   throw new Error(`ARM export failed ${httpResponse.status}: ${errorBody}`)

&#x20; }



&#x20; const result = await httpResponse.json()

&#x20; // ARM returns { template: {...}, error: {...} }

&#x20; if (result.error) throw new Error(result.error.message)

&#x20; return result.template

}



// Exports the stored baseline resourceState wrapped in a minimal ARM template

// Used when ARM export API doesn't support the resource type

function wrapBaselineAsArmTemplate(subscriptionId, resourceGroupId, resourceId, resourceState) {

&#x20; const parts = resourceId.split('/')

&#x20; return {

&#x20;   '$schema': 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',

&#x20;   contentVersion: '1.0.0.0',

&#x20;   parameters: {},

&#x20;   resources: \[{

&#x20;     type:       `${parts\[6]}/${parts\[7]}`,

&#x20;     apiVersion: '2023-01-01',

&#x20;     name:       parts\[8],

&#x20;     location:   resourceState.location || '\[resourceGroup().location]',

&#x20;     properties: resourceState.properties || {},

&#x20;     tags:       resourceState.tags || {},

&#x20;   }],

&#x20; }

}



module.exports = { exportResourceAsArmTemplate, wrapBaselineAsArmTemplate }





routes/export.js — thin route, delegates to service



js

'use strict'

const router = require('express').Router()

const { getBaseline } = require('../services/blobService')

const { exportResourceAsArmTemplate, wrapBaselineAsArmTemplate } = require('../services/exportService')



// POST /api/export/baseline

// Body: { subscriptionId, resourceGroupId, resourceId, format: 'arm'|'baseline' }

// Returns: ARM template JSON as downloadable file

router.post('/export/baseline', async (req, res) => {

&#x20; console.log('\[POST /export/baseline] starts')

&#x20; const { subscriptionId, resourceGroupId, resourceId, format = 'arm' } = req.body



&#x20; if (!subscriptionId || !resourceGroupId || !resourceId) {

&#x20;   return res.status(400).json({ error: 'subscriptionId, resourceGroupId and resourceId required' })

&#x20; }

&#x20; if (subscriptionId.includes("'") || resourceGroupId.includes("'")) {

&#x20;   return res.status(400).json({ error: 'Invalid characters in input' })

&#x20; }



&#x20; try {

&#x20;   let armTemplate



&#x20;   if (format === 'arm') {

&#x20;     // Try ARM export API first — most accurate

&#x20;     try {

&#x20;       armTemplate = await exportResourceAsArmTemplate(subscriptionId, resourceGroupId, resourceId)

&#x20;     } catch (armExportError) {

&#x20;       console.warn('\[POST /export/baseline] ARM export failed, falling back to baseline wrap:', armExportError.message)

&#x20;       // Fallback: wrap stored baseline in minimal ARM template

&#x20;       const baseline = await getBaseline(subscriptionId, resourceId)

&#x20;       if (!baseline?.resourceState) return res.status(404).json({ error: 'No baseline found for this resource' })

&#x20;       armTemplate = wrapBaselineAsArmTemplate(subscriptionId, resourceGroupId, resourceId, baseline.resourceState)

&#x20;     }

&#x20;   } else {

&#x20;     // 'baseline' format — return raw baseline resourceState

&#x20;     const baseline = await getBaseline(subscriptionId, resourceId)

&#x20;     if (!baseline?.resourceState) return res.status(404).json({ error: 'No baseline found for this resource' })

&#x20;     armTemplate = baseline.resourceState

&#x20;   }



&#x20;   const resourceName = resourceId.split('/').pop()

&#x20;   const filename = `${resourceName}-baseline-${new Date().toISOString().slice(0,10)}.json`



&#x20;   res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)

&#x20;   res.setHeader('Content-Type', 'application/json')

&#x20;   res.json(armTemplate)

&#x20;   console.log('\[POST /export/baseline] ends — exported:', filename)



&#x20; } catch (exportError) {

&#x20;   console.log('\[POST /export/baseline] ends — error:', exportError.message)

&#x20;   res.status(500).json({ error: exportError.message })

&#x20; }

})



module.exports = router





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 3 — Register route in app.js



One line:

js

app.use('/api', require('./routes/export'))





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 4 — Frontend



src/services/api.js — one new function:

js

export async function exportBaseline(subscriptionId, resourceGroupId, resourceId, format = 'arm') {

&#x20; const response = await fetch(`${API\_BASE\_URL}/export/baseline`, {

&#x20;   method:  'POST',

&#x20;   headers: { 'Content-Type': 'application/json' },

&#x20;   body:    JSON.stringify({ subscriptionId, resourceGroupId, resourceId, format }),

&#x20; })

&#x20; if (!response.ok) throw new Error(`Export failed: ${response.status}`)

&#x20; const blob = await response.blob()

&#x20; // Trigger browser download

&#x20; const resourceName = resourceId.split('/').pop()

&#x20; const filename = `${resourceName}-baseline-${new Date().toISOString().slice(0,10)}.json`

&#x20; const downloadUrl = URL.createObjectURL(blob)

&#x20; const link = document.createElement('a')

&#x20; link.href = downloadUrl

&#x20; link.download = filename

&#x20; link.click()

&#x20; URL.revokeObjectURL(downloadUrl)

}





src/pages/GenomePage.jsx — add export buttons to each snapshot:

jsx

<button className="gp-snap-btn gp-snap-btn--blue"

&#x20; onClick={e => { e.stopPropagation(); exportBaseline(subscriptionId, resourceGroupId, resourceId, 'arm') }}

&#x20; title="Download as ARM template">

&#x20; Export ARM

</button>





src/pages/ComparisonPage.jsx — add export button in header actions:

jsx

<button className="cp-btn cp-btn--secondary" onClick={() => exportBaseline(subscriptionId, resourceGroupId, resourceId, 'arm')}>

&#x20; <span className="material-symbols-outlined" style={{ fontSize: 16 }}>download</span>

&#x20; Export Baseline

</button>





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Implementation order



| Step | File | What |

|---|---|---|

| 1 | services/exportService.js | ARM export API call + baseline wrapper |

| 2 | routes/export.js | POST endpoint with fallback |

| 3 | app.js | Register route |

| 4 | src/services/api.js | exportBaseline() with browser download trigger |

| 5 | src/pages/GenomePage.jsx | Export button on each snapshot |

| 6 | src/pages/ComparisonPage.jsx | Export button in header |

| 7 | .env + .env.example | ARM\_EXPORT\_API\_VERSION=2021-04-01 |



Estimated new code: \~120 lines across 4 files. Zero new Azure services.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Guidelines compliance



| Guideline | How met |

|---|---|

| Single responsibility | exportService.js owns export logic only |

| Separate business from infrastructure | ARM API call in service, route is thin |

| Design for failures | ARM export fallback to baseline wrap if API fails |

| No hardcoding | ARM\_EXPORT\_API\_VERSION in env |

| Validate inputs | Required fields + injection check |

| KISS | ARM does all template generation — zero template code written |

| YAGNI | No Bicep decompile (preview API, unreliable) — ARM JSON is deployable as-is |

| Idempotent | Same resourceId always produces same export |





Feature 5



\## Drift to Compliance Mapping — Implementation Plan



Following the guidelines: maximize Azure services, minimize code, test everything.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Architecture



Drift detected (detectDrift Function or queuePoller)

&#x20; → complianceMapper.js: mapChangesToControls(changes)

&#x20; → Enrich driftRecord with { complianceControls: \[...], complianceFrameworks: {...} }

&#x20; → Save to driftIndex Table (already happens)



Frontend:

&#x20; ComparisonPage → shows "Compliance Impact" section

&#x20; New CompliancePage → aggregated report across all resources





Azure services used:

\- driftIndex Table (existing) — stores enriched records

\- Azure OpenAI (existing) — generates executive summary

\- ACS Email (existing) — weekly compliance digest

\- Blob Storage (existing) — stores PDF reports



New code: \~250 lines across 6 files.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Implementation order



Step 1 — Create compliance mapping (pure data, no Azure)



adip-backend/shared/compliance-map.json:

json

{

&#x20; "properties.minimumTlsVersion": {

&#x20;   "controls": \["CIS-Azure-3.1", "NIST-SC-8", "ISO27001-A.14.1.3"],

&#x20;   "description": "TLS version must be 1.2 or higher",

&#x20;   "severity": "high"

&#x20; },

&#x20; "properties.networkAcls.defaultAction": {

&#x20;   "controls": \["CIS-Azure-3.7", "NIST-SC-7"],

&#x20;   "description": "Storage network access must be restricted",

&#x20;   "severity": "high"

&#x20; },

&#x20; "properties.allowBlobPublicAccess": {

&#x20;   "controls": \["CIS-Azure-3.5", "NIST-AC-3"],

&#x20;   "description": "Public blob access must be disabled",

&#x20;   "severity": "critical"

&#x20; },

&#x20; "properties.supportsHttpsTrafficOnly": {

&#x20;   "controls": \["CIS-Azure-3.1", "NIST-SC-8"],

&#x20;   "description": "HTTPS-only traffic must be enforced",

&#x20;   "severity": "high"

&#x20; },

&#x20; "properties.encryption.keySource": {

&#x20;   "controls": \["CIS-Azure-3.2", "NIST-SC-28", "ISO27001-A.10.1.1"],

&#x20;   "description": "Encryption key management",

&#x20;   "severity": "high"

&#x20; },

&#x20; "properties.accessPolicies": {

&#x20;   "controls": \["CIS-Azure-8.1", "NIST-AC-2", "ISO27001-A.9.2.1"],

&#x20;   "description": "Key Vault access policies changed",

&#x20;   "severity": "high"

&#x20; },

&#x20; "properties.securityRules": {

&#x20;   "controls": \["CIS-Azure-6.1", "NIST-SC-7", "ISO27001-A.13.1.1"],

&#x20;   "description": "NSG security rules changed",

&#x20;   "severity": "high"

&#x20; },

&#x20; "identity": {

&#x20;   "controls": \["CIS-Azure-9.1", "NIST-IA-2"],

&#x20;   "description": "Managed identity configuration changed",

&#x20;   "severity": "medium"

&#x20; },

&#x20; "sku": {

&#x20;   "controls": \["ISO27001-A.17.2.1"],

&#x20;   "description": "Resource tier/SKU changed",

&#x20;   "severity": "low"

&#x20; },

&#x20; "tags": {

&#x20;   "controls": \["ISO27001-A.8.1.1"],

&#x20;   "description": "Resource tagging changed",

&#x20;   "severity": "low"

&#x20; }

}





Step 2 — Mapper utility (pure function, no Azure)



adip-backend/shared/complianceMapper.js:

js

'use strict'

const complianceMap = require('./compliance-map.json')



// Maps drift changes to violated compliance controls

function mapChangesToControls(changes) {

&#x20; const violations = \[]

&#x20; const controlSet = new Set()



&#x20; for (const change of changes) {

&#x20;   const changePath = change.path || ''

&#x20;   for (const \[mappedPath, mapping] of Object.entries(complianceMap)) {

&#x20;     if (changePath.startsWith(mappedPath) || changePath.includes(mappedPath)) {

&#x20;       mapping.controls.forEach(control => {

&#x20;         if (!controlSet.has(control)) {

&#x20;           controlSet.add(control)

&#x20;           violations.push({

&#x20;             control,

&#x20;             path: changePath,

&#x20;             description: mapping.description,

&#x20;             severity: mapping.severity,

&#x20;           })

&#x20;         }

&#x20;       })

&#x20;     }

&#x20;   }

&#x20; }

&#x20; return violations

}



// Groups controls by framework (CIS-Azure, NIST, ISO27001)

function groupByFramework(violations) {

&#x20; return violations.reduce((groups, v) => {

&#x20;   const framework = v.control.split('-').slice(0, 2).join('-')

&#x20;   groups\[framework] = groups\[framework] || \[]

&#x20;   groups\[framework].push(v)

&#x20;   return groups

&#x20; }, {})

}



module.exports = { mapChangesToControls, groupByFramework }





Step 3 — Enrich drift records



function-app/detectDrift/index.js — add 3 lines after classifySeverity:

js

const { mapChangesToControls, groupByFramework } = require('adip-shared/complianceMapper')

// ...

const complianceViolations = mapChangesToControls(detectedChanges)

// add to driftRecord:

complianceControls: complianceViolations.map(v => v.control),

complianceViolations,

complianceFrameworks: groupByFramework(complianceViolations),





express-api/src/services/queuePoller.js — same 3 lines in enrichWithDiff().



Also update driftIndex Table upsert to include complianceControls (array of control IDs) so it's queryable.



Step 4 — Backend compliance report endpoint



routes/compliance.js:

js

'use strict'

const router = require('express').Router()

const { getDriftIndexTableClient } = require('../services/blobService')

const { groupByFramework } = require('../shared/complianceMapper')



// GET /api/compliance/report?subscriptionId=\&since=

router.get('/compliance/report', async (req, res) => {

&#x20; const { subscriptionId, since } = req.query

&#x20; if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' })



&#x20; const sinceDate = since ? new Date(since).toISOString() : new Date(Date.now() - 30\*86400000).toISOString()

&#x20; const filter = `PartitionKey eq '${subscriptionId}' and detectedAt ge '${sinceDate}'`



&#x20; const driftRecords = \[]

&#x20; for await (const entity of getDriftIndexTableClient().listEntities({ queryOptions: { filter } })) {

&#x20;   if (entity.complianceControls \&\& entity.complianceControls.length > 0) {

&#x20;     driftRecords.push(entity)

&#x20;   }

&#x20; }



&#x20; // Aggregate violations

&#x20; const controlCounts = {}

&#x20; const resourceViolations = {}

&#x20; for (const record of driftRecords) {

&#x20;   (record.complianceControls || \[]).forEach(control => {

&#x20;     controlCounts\[control] = (controlCounts\[control] || 0) + 1

&#x20;   })

&#x20;   resourceViolations\[record.resourceId] = (resourceViolations\[record.resourceId] || 0) + 1

&#x20; }



&#x20; const topControls = Object.entries(controlCounts).sort((a,b) => b\[1] - a\[1]).slice(0, 10)

&#x20; const topResources = Object.entries(resourceViolations).sort((a,b) => b\[1] - a\[1]).slice(0, 10)



&#x20; // Call GPT-4o for executive summary

&#x20; const { explainDrift } = require('../services/aiService')

&#x20; const summaryPrompt = `Compliance violations summary: ${topControls.length} unique controls violated across ${driftRecords.length} drift events. Top: ${topControls.slice(0,3).map((\[c,n]) => `${c} (${n}x)`).join(', ')}`

&#x20; const aiSummary = await explainDrift({ resourceId: 'compliance-summary', differences: \[{ sentence: summaryPrompt }] }).catch(() => null)



&#x20; res.json({

&#x20;   totalDriftEvents: driftRecords.length,

&#x20;   uniqueControls: Object.keys(controlCounts).length,

&#x20;   topViolatedControls: topControls.map((\[control, count]) => ({ control, count })),

&#x20;   topAffectedResources: topResources.map((\[resourceId, count]) => ({ resourceId, count })),

&#x20;   aiSummary,

&#x20; })

})



module.exports = router





Register in app.js: app.use('/api', require('./routes/compliance'))



Step 5 — Frontend ComparisonPage enhancement



Add below the diff list:

jsx

{fieldDifferences.length > 0 \&\& (

&#x20; <ComplianceImpactSection differences={fieldDifferences} />

)}





src/components/ComplianceImpactSection.jsx:

jsx

import complianceMap from '../../adip-backend/shared/compliance-map.json'



function ComplianceImpactSection({ differences }) {

&#x20; const violations = \[]

&#x20; differences.forEach(diff => {

&#x20;   const path = diff.path || ''

&#x20;   Object.entries(complianceMap).forEach((\[mappedPath, mapping]) => {

&#x20;     if (path.startsWith(mappedPath) || path.includes(mappedPath)) {

&#x20;       mapping.controls.forEach(control => {

&#x20;         if (!violations.find(v => v.control === control)) {

&#x20;           violations.push({ control, description: mapping.description, severity: mapping.severity })

&#x20;         }

&#x20;       })

&#x20;     }

&#x20;   })

&#x20; })



&#x20; if (violations.length === 0) return null



&#x20; return (

&#x20;   <div className="cp-card">

&#x20;     <div className="cp-card-header">

&#x20;       <span className="material-symbols-outlined" style={{ color: '#dc2626' }}>policy</span>

&#x20;       <h3>Compliance Impact — {violations.length} control(s) violated</h3>

&#x20;     </div>

&#x20;     <div className="cp-compliance-list">

&#x20;       {violations.map((v, i) => (

&#x20;         <div key={i} className="cp-compliance-item">

&#x20;           <span className={`cp-compliance-badge cp-compliance-badge--${v.severity}`}>{v.control}</span>

&#x20;           <span className="cp-compliance-desc">{v.description}</span>

&#x20;         </div>

&#x20;       ))}

&#x20;     </div>

&#x20;   </div>

&#x20; )

}





Step 6 — New CompliancePage



src/pages/CompliancePage.jsx:

jsx

// Fetches compliance report on mount

useEffect(() => {

&#x20; fetchComplianceReport(subscriptionId, since).then(setReport)

}, \[subscriptionId, since])



// Renders:

// - Framework summary bar chart (recharts)

// - Top violated controls table

// - Top affected resources table

// - AI executive summary card





Add route in src/App.jsx and link in NavBar.jsx.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Testing plan



1\. Trigger drift with compliance impact:

&#x20;  - Change storage account allowBlobPublicAccess from false → true

&#x20;  - Verify driftRecord.complianceControls includes \["CIS-Azure-3.5", "NIST-AC-3"]



2\. Test ComparisonPage:

&#x20;  - Navigate to comparison for that storage account

&#x20;  - Verify "Compliance Impact" section shows 2 controls



3\. Test CompliancePage:

&#x20;  - Navigate to /compliance

&#x20;  - Verify report shows aggregated violations

&#x20;  - Verify AI summary renders



4\. Test idempotency:

&#x20;  - Re-run same drift detection

&#x20;  - Verify same controls mapped (no duplicates)



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Estimated effort



| Task | Lines | Time |

|---|---|---|

| compliance-map.json | 50 | 15min |

| complianceMapper.js | 30 | 10min |

| Enrich detectDrift | 5 | 5min |

| Enrich queuePoller | 5 | 5min |

| routes/compliance.js | 60 | 20min |

| ComplianceImpactSection.jsx | 40 | 15min |

| CompliancePage.jsx | 80 | 30min |

| Testing | — | 20min |

| Total | 270 lines | \~2 hours |





Feature 6



\## Smart Remediation Scheduling — Implementation Plan



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### What it does

Adds a third remediation path alongside "Apply Now" and "Request Approval":

\- \*\*Schedule\*\* — queue remediation for a specific time (maintenance window)

\- \*\*Auto-approve\*\* — if admin doesn't respond to approval email within N hours, auto-remediate

\- \*\*Escalate\*\* — if medium drift sits unresolved for 48h, escalate to high and re-alert



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Architecture



ComparisonPage: "Schedule Remediation" button

&#x20; → POST /api/remediation-queue/schedule

&#x20; → Saves to remediationQueue Table



Azure Logic App timer (every 30 min)

&#x20; → POST /api/remediation-queue/process (Express)

&#x20; → Queries remediationQueue for due items

&#x20; → Calls existing /api/remediate for each

&#x20; → Updates status



Escalation check (same timer):

&#x20; → Finds pending items older than escalationHours

&#x20; → Calls sendDriftAlertEmail with escalated severity





Azure services used:

\- Azure Table Storage — remediationQueue table (new, auto-created)

\- Azure Logic App timer — already know how to create (same as after-hours alert)

\- Everything else existing: remediate.js, alertService.js, blobService.js



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 1 — remediationQueue Table schema



PartitionKey: subscriptionId

RowKey:       base64url(resourceId + ':' + createdAt)

Fields:

&#x20; resourceId, resourceGroupId, subscriptionId

&#x20; driftSeverity, changeCount

&#x20; status:              'pending' | 'processing' | 'completed' | 'failed' | 'escalated'

&#x20; scheduledFor:        ISO timestamp (when to remediate)

&#x20; autoApproveAfterMs:  number (ms, 0 = never auto-approve)

&#x20; escalateAfterMs:     number (ms, 0 = never escalate)

&#x20; createdAt:           ISO timestamp

&#x20; completedAt:         ISO timestamp (null until done)

&#x20; errorMessage:        string (null until failed)





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 2 — services/remediationQueueService.js



Single responsibility: all queue business logic.



js

'use strict'

const { getMonitorSessionsTableClient } = require('./blobService')

const { TableClient } = require('@azure/data-tables')



const QUEUE\_TABLE = 'remediationQueue'



function getQueueTable() {

&#x20; return TableClient.fromConnectionString(process.env.STORAGE\_CONNECTION\_STRING, QUEUE\_TABLE)

}



// Adds a remediation job to the queue

async function scheduleRemediation({ subscriptionId, resourceGroupId, resourceId, driftSeverity, changeCount, scheduledFor, autoApproveAfterMs = 0, escalateAfterMs = 172800000 }) {

&#x20; const createdAt = new Date().toISOString()

&#x20; const rowKey    = Buffer.from(`${resourceId}:${createdAt}`).toString('base64url').slice(0, 512)



&#x20; await getQueueTable().upsertEntity({

&#x20;   partitionKey:      subscriptionId,

&#x20;   rowKey,

&#x20;   resourceId,

&#x20;   resourceGroupId,

&#x20;   subscriptionId,

&#x20;   driftSeverity,

&#x20;   changeCount:       changeCount || 0,

&#x20;   status:            'pending',

&#x20;   scheduledFor:      scheduledFor || new Date().toISOString(),

&#x20;   autoApproveAfterMs,

&#x20;   escalateAfterMs,

&#x20;   createdAt,

&#x20;   completedAt:       null,

&#x20;   errorMessage:      null,

&#x20; }, 'Replace')



&#x20; return { queued: true, rowKey, scheduledFor }

}



// Returns all pending jobs that are due now

async function getDueJobs(subscriptionId) {

&#x20; const now    = new Date().toISOString()

&#x20; const filter = `PartitionKey eq '${subscriptionId}' and status eq 'pending' and scheduledFor le '${now}'`

&#x20; const jobs   = \[]

&#x20; for await (const entity of getQueueTable().listEntities({ queryOptions: { filter } })) {

&#x20;   jobs.push(entity)

&#x20; }

&#x20; return jobs

}



// Returns pending jobs older than their escalateAfterMs threshold

async function getJobsDueForEscalation(subscriptionId) {

&#x20; const filter = `PartitionKey eq '${subscriptionId}' and status eq 'pending'`

&#x20; const jobs   = \[]

&#x20; for await (const entity of getQueueTable().listEntities({ queryOptions: { filter } })) {

&#x20;   const ageMs = Date.now() - new Date(entity.createdAt).getTime()

&#x20;   if (entity.escalateAfterMs > 0 \&\& ageMs >= entity.escalateAfterMs) {

&#x20;     jobs.push(entity)

&#x20;   }

&#x20; }

&#x20; return jobs

}



async function updateJobStatus(subscriptionId, rowKey, status, errorMessage = null) {

&#x20; await getQueueTable().upsertEntity({

&#x20;   partitionKey: subscriptionId,

&#x20;   rowKey,

&#x20;   status,

&#x20;   completedAt:  status === 'completed' || status === 'failed' ? new Date().toISOString() : null,

&#x20;   errorMessage,

&#x20; }, 'Merge')

}



module.exports = { scheduleRemediation, getDueJobs, getJobsDueForEscalation, updateJobStatus }





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 3 — routes/remediationQueue.js



js

'use strict'

const router = require('express').Router()

const { scheduleRemediation, getDueJobs, getJobsDueForEscalation, updateJobStatus } = require('../services/remediationQueueService')

const { sendDriftAlertEmail } = require('../services/alertService')

const fetch = require('node-fetch')



const EXPRESS\_API\_URL = process.env.EXPRESS\_API\_URL || 'http://localhost:3001'



// POST /api/remediation-queue/schedule

// Queues a remediation for a future time

router.post('/remediation-queue/schedule', async (req, res) => {

&#x20; console.log('\[POST /remediation-queue/schedule] starts')

&#x20; const { subscriptionId, resourceGroupId, resourceId, driftSeverity, changeCount, scheduledFor, autoApproveAfterMs, escalateAfterMs } = req.body



&#x20; if (!subscriptionId || !resourceGroupId || !resourceId) {

&#x20;   return res.status(400).json({ error: 'subscriptionId, resourceGroupId and resourceId required' })

&#x20; }



&#x20; try {

&#x20;   const result = await scheduleRemediation({ subscriptionId, resourceGroupId, resourceId, driftSeverity, changeCount, scheduledFor, autoApproveAfterMs, escalateAfterMs })

&#x20;   res.json(result)

&#x20;   console.log('\[POST /remediation-queue/schedule] ends — scheduled for:', scheduledFor)

&#x20; } catch (scheduleError) {

&#x20;   console.log('\[POST /remediation-queue/schedule] ends — error:', scheduleError.message)

&#x20;   res.status(500).json({ error: scheduleError.message })

&#x20; }

})



// POST /api/remediation-queue/process

// Called by Logic App timer every 30 minutes

// Processes due jobs and escalates overdue ones

router.post('/remediation-queue/process', async (req, res) => {

&#x20; console.log('\[POST /remediation-queue/process] starts')

&#x20; const subscriptionId = req.body?.subscriptionId || process.env.AZURE\_SUBSCRIPTION\_ID

&#x20; if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' })



&#x20; const results = { processed: 0, escalated: 0, failed: 0 }



&#x20; // Process due jobs

&#x20; const dueJobs = await getDueJobs(subscriptionId)

&#x20; for (const job of dueJobs) {

&#x20;   try {

&#x20;     await updateJobStatus(subscriptionId, job.rowKey, 'processing')

&#x20;     const remediateResponse = await fetch(`${EXPRESS\_API\_URL}/api/remediate`, {

&#x20;       method:  'POST',

&#x20;       headers: { 'Content-Type': 'application/json' },

&#x20;       body:    JSON.stringify({ subscriptionId, resourceGroupId: job.resourceGroupId, resourceId: job.resourceId }),

&#x20;     })

&#x20;     if (!remediateResponse.ok) throw new Error(`Remediate returned ${remediateResponse.status}`)

&#x20;     await updateJobStatus(subscriptionId, job.rowKey, 'completed')

&#x20;     results.processed++

&#x20;   } catch (jobError) {

&#x20;     console.error('\[remediationQueue] job failed:', job.resourceId, jobError.message)

&#x20;     await updateJobStatus(subscriptionId, job.rowKey, 'failed', jobError.message)

&#x20;     results.failed++

&#x20;   }

&#x20; }



&#x20; // Escalate overdue jobs

&#x20; const overdueJobs = await getJobsDueForEscalation(subscriptionId)

&#x20; for (const job of overdueJobs) {

&#x20;   try {

&#x20;     await sendDriftAlertEmail({

&#x20;       subscriptionId,

&#x20;       resourceId:    job.resourceId,

&#x20;       resourceGroup: job.resourceGroupId,

&#x20;       severity:      'high',  // escalate to high

&#x20;       detectedAt:    job.createdAt,

&#x20;       differences:   \[],

&#x20;       escalated:     true,

&#x20;       originalSeverity: job.driftSeverity,

&#x20;     })

&#x20;     await updateJobStatus(subscriptionId, job.rowKey, 'escalated')

&#x20;     results.escalated++

&#x20;   } catch (escalateError) {

&#x20;     console.error('\[remediationQueue] escalation failed:', job.resourceId, escalateError.message)

&#x20;   }

&#x20; }



&#x20; res.json(results)

&#x20; console.log('\[POST /remediation-queue/process] ends —', results)

})



// GET /api/remediation-queue?subscriptionId=

// Returns pending queue items for the dashboard

router.get('/remediation-queue', async (req, res) => {

&#x20; const { subscriptionId } = req.query

&#x20; if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' })

&#x20; const { TableClient } = require('@azure/data-tables')

&#x20; const tc = TableClient.fromConnectionString(process.env.STORAGE\_CONNECTION\_STRING, 'remediationQueue')

&#x20; const items = \[]

&#x20; const filter = `PartitionKey eq '${subscriptionId}' and status eq 'pending'`

&#x20; for await (const entity of tc.listEntities({ queryOptions: { filter } })) items.push(entity)

&#x20; res.json(items.sort((a, b) => new Date(a.scheduledFor) - new Date(b.scheduledFor)))

})



module.exports = router





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 4 — Register route in app.js



js

app.use('/api', require('./routes/remediationQueue'))





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 5 — Logic App timer (every 30 min)



Create via Azure Portal or CLI — same pattern as the after-hours alert Logic App:



bash

\# Trigger: Recurrence every 30 minutes

\# Action: HTTP POST to EXPRESS\_PUBLIC\_URL/api/remediation-queue/process

\# Body: { "subscriptionId": "8f461bb6-..." }





Or add to the existing startAfterHoursAlertCheck pattern in app.js as a setInterval:



js

// Process remediation queue every 30 minutes

setInterval(async () => {

&#x20; const subscriptionId = process.env.AZURE\_SUBSCRIPTION\_ID

&#x20; if (!subscriptionId) return

&#x20; try {

&#x20;   const { getDueJobs, getJobsDueForEscalation } = require('./services/remediationQueueService')

&#x20;   // ... same logic as the route handler

&#x20; } catch (e) { console.error('\[remediationQueue] process error:', e.message) }

}, 30 \* 60 \* 1000)





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 6 — Frontend: ComparisonPage



Add third button in the header actions:



jsx

// New state

const \[showScheduler, setShowScheduler] = useState(false)

const \[scheduledFor, setScheduledFor] = useState('')

const \[autoApproveHours, setAutoApproveHours] = useState(24)



// Third button

{fieldDifferences.length > 0 \&\& !baselineNotFound \&\& driftSeverity === 'medium' \&\& (

&#x20; <button className="cp-btn cp-btn--secondary" onClick={() => setShowScheduler(true)}>

&#x20;   Schedule Remediation

&#x20; </button>

)}



// Scheduler panel (shows when button clicked)

{showScheduler \&\& (

&#x20; <div className="cp-scheduler-panel">

&#x20;   <label>Remediate at:</label>

&#x20;   <input type="datetime-local" value={scheduledFor} onChange={e => setScheduledFor(e.target.value)} />

&#x20;   <label>Auto-approve after (hours, 0 = never):</label>

&#x20;   <input type="number" value={autoApproveHours} onChange={e => setAutoApproveHours(e.target.value)} min="0" />

&#x20;   <button onClick={handleSchedule}>Confirm Schedule</button>

&#x20;   <button onClick={() => setShowScheduler(false)}>Cancel</button>

&#x20; </div>

)}





handleSchedule:

js

const handleSchedule = async () => {

&#x20; await scheduleRemediation(subscriptionId, resourceGroupId, effectiveId, {

&#x20;   scheduledFor: new Date(scheduledFor).toISOString(),

&#x20;   autoApproveAfterMs: autoApproveHours \* 3600000,

&#x20;   escalateAfterMs: 48 \* 3600000,

&#x20;   driftSeverity,

&#x20;   changeCount: fieldDifferences.length,

&#x20; })

&#x20; setShowScheduler(false)

&#x20; setRemediationSucceeded(true)

}





Add scheduleRemediation to src/services/api.js:

js

export async function scheduleRemediation(subscriptionId, resourceGroupId, resourceId, options) {

&#x20; return apiRequest('/remediation-queue/schedule', {

&#x20;   method: 'POST',

&#x20;   body: JSON.stringify({ subscriptionId, resourceGroupId, resourceId, ...options }),

&#x20; })

}





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Implementation order



| Step | File | What |

|---|---|---|

| 1 | services/remediationQueueService.js | Queue CRUD + due/escalation queries |

| 2 | routes/remediationQueue.js | 3 endpoints |

| 3 | app.js | Register route + 30min interval |

| 4 | src/services/api.js | scheduleRemediation() |

| 5 | src/pages/ComparisonPage.jsx | Schedule button + datetime picker |

| 6 | .env | No new vars needed |



Estimated new code: \~200 lines across 4 files. Zero new Azure services.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Testing plan



1\. Create a medium-severity drift on a resource

2\. Click "Schedule Remediation" → set time 2 minutes from now

3\. Wait 2 minutes → verify resource is reverted

4\. Test escalation: set escalateAfterMs = 60000 (1 min) → verify alert email sent after 1 min

5\. Test auto-approve: set autoApproveAfterMs = 60000 → verify auto-remediation after 1 min



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Guidelines compliance



| Guideline | How met |

|---|---|

| Single responsibility | remediationQueueService.js owns all queue logic |

| Idempotent | Same job processed once — status updated to processing before ARM call |

| Design for failures | Failed jobs marked failed with error message, not silently dropped |

| Retries | Logic App timer retries automatically on HTTP failure |

| No hardcoding | EXPRESS\_API\_URL from env |

| Validate inputs | Required fields checked, returns 400 |

| YAGNI | Only 3 statuses needed: pending/completed/failed + escalated |





Feature 7



\## Resource Dependency Graph — Implementation Plan



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 1 — Backend: services/dependencyGraphService.js



js

'use strict'

const { getResourceConfig } = require('./azureResourceService')

const { getDriftIndexTableClient } = require('./blobService')



// Extracts resource references from ARM properties

function extractReferences(resource) {

&#x20; const refs = \[]

&#x20; const props = resource.properties || {}

&#x20; const type  = (resource.type || '').toLowerCase()



&#x20; if (type.includes('networkinterfaces')) {

&#x20;   props.ipConfigurations?.forEach(ip => {

&#x20;     if (ip.properties?.subnet?.id)            refs.push({ targetId: ip.properties.subnet.id,            label: 'in subnet' })

&#x20;     if (ip.properties?.publicIPAddress?.id)   refs.push({ targetId: ip.properties.publicIPAddress.id,   label: 'has public IP' })

&#x20;   })

&#x20; }

&#x20; if (type.includes('virtualmachines')) {

&#x20;   props.networkProfile?.networkInterfaces?.forEach(nic => {

&#x20;     if (nic.id) refs.push({ targetId: nic.id, label: 'uses NIC' })

&#x20;   })

&#x20;   if (props.storageProfile?.osDisk?.managedDisk?.id)

&#x20;     refs.push({ targetId: props.storageProfile.osDisk.managedDisk.id, label: 'OS disk' })

&#x20; }

&#x20; if (type.includes('subnets') \&\& props.networkSecurityGroup?.id)

&#x20;   refs.push({ targetId: props.networkSecurityGroup.id, label: 'protected by NSG' })



&#x20; return refs

}



async function buildDependencyGraph(subscriptionId, resourceGroupId) {

&#x20; // Get all resources (already implemented in getResourceConfig)

&#x20; const { resources } = await getResourceConfig(subscriptionId, resourceGroupId, null)



&#x20; // Get recently drifted resource IDs for red node highlighting

&#x20; const driftedIds = new Set()

&#x20; const since = new Date(Date.now() - 7 \* 86400000).toISOString()

&#x20; const filter = `PartitionKey eq '${subscriptionId}' and detectedAt ge '${since}'`

&#x20; for await (const entity of getDriftIndexTableClient().listEntities({ queryOptions: { filter } })) {

&#x20;   driftedIds.add(entity.resourceId?.toLowerCase())

&#x20; }



&#x20; const nodes = resources.map(r => ({

&#x20;   id:       r.id,

&#x20;   name:     r.name,

&#x20;   type:     r.type,

&#x20;   location: r.location,

&#x20;   drifted:  driftedIds.has(r.id?.toLowerCase()),

&#x20; }))



&#x20; const resourceIds = new Set(resources.map(r => r.id?.toLowerCase()))

&#x20; const edges = \[]

&#x20; for (const resource of resources) {

&#x20;   for (const ref of extractReferences(resource)) {

&#x20;     // Only include edges within the same resource group

&#x20;     if (resourceIds.has(ref.targetId?.toLowerCase())) {

&#x20;       edges.push({ source: resource.id, target: ref.targetId, label: ref.label })

&#x20;     }

&#x20;   }

&#x20; }



&#x20; return { nodes, edges }

}



module.exports = { buildDependencyGraph }





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 2 — Backend: routes/dependencyGraph.js



js

'use strict'

const router = require('express').Router()

const { buildDependencyGraph } = require('../services/dependencyGraphService')



const \_graphCache = new Map()



router.get('/dependency-graph', async (req, res) => {

&#x20; console.log('\[GET /dependency-graph] starts')

&#x20; const { subscriptionId, resourceGroupId } = req.query

&#x20; if (!subscriptionId || !resourceGroupId) return res.status(400).json({ error: 'subscriptionId and resourceGroupId required' })



&#x20; const cacheKey = `${subscriptionId}:${resourceGroupId}`

&#x20; const cached   = \_graphCache.get(cacheKey)

&#x20; if (cached \&\& cached.expiresAt > Date.now()) return res.json(cached.data)



&#x20; try {

&#x20;   const graph = await buildDependencyGraph(subscriptionId, resourceGroupId)

&#x20;   \_graphCache.set(cacheKey, { data: graph, expiresAt: Date.now() + 300000 }) // 5min cache

&#x20;   res.json(graph)

&#x20;   console.log('\[GET /dependency-graph] ends — nodes:', graph.nodes.length, 'edges:', graph.edges.length)

&#x20; } catch (graphError) {

&#x20;   console.log('\[GET /dependency-graph] ends — error:', graphError.message)

&#x20;   res.status(500).json({ error: graphError.message })

&#x20; }

})



module.exports = router





Register in app.js: app.use('/api', require('./routes/dependencyGraph'))



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 3 — Install one package



bash

cd ADIP-main

npm install react-force-graph-2d





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 4 — src/components/DependencyGraph.jsx



jsx

import ForceGraph2D from 'react-force-graph-2d'



// Color by resource type

const TYPE\_COLORS = {

&#x20; 'microsoft.network/virtualnetworks':      '#3b82f6',

&#x20; 'microsoft.network/networksecuritygroups':'#f97316',

&#x20; 'microsoft.network/networkinterfaces':    '#8b5cf6',

&#x20; 'microsoft.network/publicipaddresses':    '#06b6d4',

&#x20; 'microsoft.compute/virtualmachines':      '#ec4899',

&#x20; 'microsoft.compute/disks':               '#6b7280',

&#x20; 'microsoft.storage/storageaccounts':      '#10b981',

}



export default function DependencyGraph({ graphData, onNodeClick }) {

&#x20; if (!graphData?.nodes?.length) return (

&#x20;   <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>

&#x20;     No resources found in this resource group.

&#x20;   </div>

&#x20; )



&#x20; // Transform to react-force-graph format

&#x20; const data = {

&#x20;   nodes: graphData.nodes.map(n => ({

&#x20;     id:      n.id,

&#x20;     name:    n.name,

&#x20;     type:    n.type,

&#x20;     drifted: n.drifted,

&#x20;     color:   TYPE\_COLORS\[n.type?.toLowerCase()] || '#94a3b8',

&#x20;   })),

&#x20;   links: graphData.edges.map(e => ({

&#x20;     source: e.source,

&#x20;     target: e.target,

&#x20;     label:  e.label,

&#x20;   })),

&#x20; }



&#x20; return (

&#x20;   <ForceGraph2D

&#x20;     graphData={data}

&#x20;     width={800}

&#x20;     height={500}

&#x20;     backgroundColor="#0f172a"

&#x20;     nodeLabel={node => `${node.name}\\n${node.type}${node.drifted ? '\\n⚠ Drifted recently' : ''}`}

&#x20;     nodeColor={node => node.color}

&#x20;     nodeCanvasObjectMode={() => 'after'}

&#x20;     nodeCanvasObject={(node, ctx) => {

&#x20;       if (node.drifted) {

&#x20;         // Red pulsing ring for drifted nodes

&#x20;         ctx.beginPath()

&#x20;         ctx.arc(node.x, node.y, 8, 0, 2 \* Math.PI)

&#x20;         ctx.strokeStyle = '#ef4444'

&#x20;         ctx.lineWidth = 2

&#x20;         ctx.stroke()

&#x20;       }

&#x20;       // Node label

&#x20;       ctx.font = '4px Sans-Serif'

&#x20;       ctx.fillStyle = '#e2e8f0'

&#x20;       ctx.textAlign = 'center'

&#x20;       ctx.fillText(node.name, node.x, node.y + 12)

&#x20;     }}

&#x20;     linkLabel={link => link.label}

&#x20;     linkColor={() => '#334155'}

&#x20;     linkDirectionalArrowLength={4}

&#x20;     linkDirectionalArrowRelPos={1}

&#x20;     onNodeClick={node => onNodeClick?.(node)}

&#x20;   />

&#x20; )

}





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 5 — Add tab to DriftScanner



In DriftScanner.jsx, add a third tab after "Live Activity Feed":



jsx

// In tab group:

<button className={`ds-tab-btn ${activeTab === 'graph' ? 'ds-tab-btn--active' : ''}`}

&#x20; onClick={() => setActiveTab('graph')}>

&#x20; Dependency Graph

</button>



// In tab content:

{activeTab === 'graph' \&\& (

&#x20; <DependencyGraph

&#x20;   graphData={dependencyGraph}

&#x20;   onNodeClick={node => navigate('/comparison', {

&#x20;     state: { subscriptionId: subscription, resourceGroupId: resourceGroup, resourceId: node.id, resourceName: node.name }

&#x20;   })}

&#x20; />

)}





Add to handleSubmit (parallel with existing calls):

js

fetchDependencyGraph(subscription, resourceGroup)

&#x20; .then(graph => setDependencyGraph(graph))

&#x20; .catch(() => {})





Add fetchDependencyGraph to api.js:

js

export async function fetchDependencyGraph(subscriptionId, resourceGroupId) {

&#x20; return apiRequest(`/dependency-graph?subscriptionId=${encodeURIComponent(subscriptionId)}\&resourceGroupId=${encodeURIComponent(resourceGroupId)}`)

}





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Implementation order



| Step | File | What |

|---|---|---|

| 1 | npm install react-force-graph-2d | One package |

| 2 | services/dependencyGraphService.js | Graph building + drift overlay |

| 3 | routes/dependencyGraph.js | GET endpoint + 5min cache |

| 4 | app.js | Register route |

| 5 | src/services/api.js | fetchDependencyGraph() |

| 6 | src/components/DependencyGraph.jsx | Graph rendering |

| 7 | src/pages/DriftScanner.jsx | New tab + fetch on submit |



Estimated new code: \~180 lines across 5 files.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Testing



1\. Submit scan on rg-adip

2\. Click "Dependency Graph" tab

3\. Verify nodes appear for all resources

4\. Change an NSG rule → verify that node turns red after next submit

5\. Click a node → verify navigation to ComparisonPage





Feature 8



\## Policy as Code Enforcement — Implementation Plan



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### What it does

After drift is detected and remediated, automatically creates an Azure Policy assignment that prevents the same drift from happening

again. Closes the loop: detect → remediate → prevent.



Example: Storage account allowBlobPublicAccess drifted to true → remediated → Policy created: "Deny any storage account in rg-adip

where allowBlobPublicAccess = true"



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### How Azure Policy works with Contributor access



Contributor can:

\- Create Policy Assignments (assign existing built-in policies to a scope) ✓

\- Create Policy Definitions (custom policies) ✓

\- Cannot assign Owner-level policies ✓



Azure has hundreds of built-in policies already. We map drift field paths to existing built-in policy definition IDs — no custom

policy code needed.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Architecture



Drift remediated (POST /api/remediate or approve email)

&#x20; → policyEnforcementService.js: findMatchingPolicies(changes)

&#x20; → Maps changed fields to built-in Azure Policy definition IDs

&#x20; → Creates Policy Assignment via @azure/arm-policy SDK

&#x20; → Stores assignment in policyAssignments Table

&#x20; → Returns { policiesCreated: \[...] }



Frontend: ComparisonPage

&#x20; → After remediation success: shows "Policy Enforcement" section

&#x20; → Lists policies created to prevent recurrence

&#x20; → Link to Azure Portal policy page





Azure services used:

\- @azure/arm-policy SDK (new import, no new Azure resource)

\- policyAssignments Table Storage (auto-created)

\- DefaultAzureCredential (existing)



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 1 — Built-in policy mapping



adip-shared/policy-map.json — maps drift paths to Azure built-in policy IDs:



json

{

&#x20; "properties.allowBlobPublicAccess": {

&#x20;   "policyDefinitionId": "/providers/Microsoft.Authorization/policyDefinitions/4fa4b6c0-31ca-4c0d-b10d-24b96f62a751",

&#x20;   "displayName": "Storage accounts should not allow public blob access",

&#x20;   "effect": "Deny"

&#x20; },

&#x20; "properties.supportsHttpsTrafficOnly": {

&#x20;   "policyDefinitionId": "/providers/Microsoft.Authorization/policyDefinitions/404c3081-a854-4457-ae30-26a93ef643f9",

&#x20;   "displayName": "Secure transfer to storage accounts should be enabled",

&#x20;   "effect": "Deny"

&#x20; },

&#x20; "properties.minimumTlsVersion": {

&#x20;   "policyDefinitionId": "/providers/Microsoft.Authorization/policyDefinitions/fe83a0eb-a853-422d-aac2-1bffd182c5d0",

&#x20;   "displayName": "Storage accounts should have minimum TLS version 1.2",

&#x20;   "effect": "Deny"

&#x20; },

&#x20; "properties.networkAcls.defaultAction": {

&#x20;   "policyDefinitionId": "/providers/Microsoft.Authorization/policyDefinitions/34c877ad-507e-4c82-993e-3452a6e0ad3c",

&#x20;   "displayName": "Storage accounts should restrict network access",

&#x20;   "effect": "Deny"

&#x20; },

&#x20; "properties.accessPolicies": {

&#x20;   "policyDefinitionId": "/providers/Microsoft.Authorization/policyDefinitions/55615ac9-af46-4a59-874e-391cc3dfb490",

&#x20;   "displayName": "Key Vault should use RBAC permission model",

&#x20;   "effect": "Audit"

&#x20; },

&#x20; "properties.securityRules": {

&#x20;   "policyDefinitionId": "/providers/Microsoft.Authorization/policyDefinitions/9daedab3-fb2d-461e-b861-71790eead4f6",

&#x20;   "displayName": "All network ports should be restricted on NSGs",

&#x20;   "effect": "AuditIfNotExists"

&#x20; },

&#x20; "properties.encryption.keySource": {

&#x20;   "policyDefinitionId": "/providers/Microsoft.Authorization/policyDefinitions/6fac406b-40ca-413b-bf8e-0bf964659c25",

&#x20;   "displayName": "Storage account encryption should use customer-managed key",

&#x20;   "effect": "Audit"

&#x20; }

}





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 2 — services/policyEnforcementService.js



js

'use strict'

const { PolicyClient } = require('@azure/arm-policy')

const { DefaultAzureCredential } = require('@azure/identity')

const { TableClient } = require('@azure/data-tables')

const policyMap = require('adip-shared/policy-map.json')



const credential = new DefaultAzureCredential()



function getAssignmentsTable() {

&#x20; return TableClient.fromConnectionString(process.env.STORAGE\_CONNECTION\_STRING, 'policyAssignments')

}



// Finds built-in policies matching the drifted fields

function findMatchingPolicies(changes) {

&#x20; const matched = \[]

&#x20; const seen    = new Set()

&#x20; for (const change of changes) {

&#x20;   const changePath = change.path || ''

&#x20;   for (const \[mappedPath, policy] of Object.entries(policyMap)) {

&#x20;     if ((changePath.startsWith(mappedPath) || changePath.includes(mappedPath)) \&\& !seen.has(policy.policyDefinitionId)) {

&#x20;       seen.add(policy.policyDefinitionId)

&#x20;       matched.push(policy)

&#x20;     }

&#x20;   }

&#x20; }

&#x20; return matched

}



// Creates Azure Policy assignments for matched policies on the resource group scope

async function enforcePolicesForDrift(subscriptionId, resourceGroupId, changes) {

&#x20; const matchedPolicies = findMatchingPolicies(changes)

&#x20; if (matchedPolicies.length === 0) return \[]



&#x20; const policyClient = new PolicyClient(credential, subscriptionId)

&#x20; const scope        = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupId}`

&#x20; const created      = \[]



&#x20; for (const policy of matchedPolicies) {

&#x20;   const assignmentName = `adip-${policy.policyDefinitionId.split('/').pop().slice(0, 20)}-${Date.now()}`

&#x20;   try {

&#x20;     // Check if assignment already exists to avoid duplicates

&#x20;     const existingFilter = `PartitionKey eq '${subscriptionId}' and policyDefinitionId eq '${policy.policyDefinitionId}' and resourceGroupId eq '${resourceGroupId}'`

&#x20;     let alreadyExists = false

&#x20;     for await (const \_ of getAssignmentsTable().listEntities({ queryOptions: { filter: existingFilter } })) {

&#x20;       alreadyExists = true; break

&#x20;     }

&#x20;     if (alreadyExists) {

&#x20;       console.log('\[policyEnforcement] policy already assigned, skipping:', policy.displayName)

&#x20;       continue

&#x20;     }



&#x20;     // Create the policy assignment

&#x20;     const assignment = await policyClient.policyAssignments.create(scope, assignmentName, {

&#x20;       policyDefinitionId: policy.policyDefinitionId,

&#x20;       displayName:        `\[ADIP] ${policy.displayName}`,

&#x20;       description:        `Auto-assigned by ADIP after drift detection on ${new Date().toISOString()}`,

&#x20;       enforcementMode:    'Default',

&#x20;     })



&#x20;     // Record in Table Storage

&#x20;     await getAssignmentsTable().upsertEntity({

&#x20;       partitionKey:       subscriptionId,

&#x20;       rowKey:             Buffer.from(assignmentName).toString('base64url').slice(0, 512),

&#x20;       assignmentName,

&#x20;       assignmentId:       assignment.id,

&#x20;       policyDefinitionId: policy.policyDefinitionId,

&#x20;       displayName:        policy.displayName,

&#x20;       resourceGroupId,

&#x20;       createdAt:          new Date().toISOString(),

&#x20;       scope,

&#x20;     }, 'Replace')



&#x20;     created.push({ assignmentName, displayName: policy.displayName, assignmentId: assignment.id })

&#x20;     console.log('\[policyEnforcement] created assignment:', policy.displayName)

&#x20;   } catch (assignError) {

&#x20;     // Non-fatal — policy assignment failure should not block remediation

&#x20;     console.warn('\[policyEnforcement] failed to create assignment:', policy.displayName, assignError.message)

&#x20;   }

&#x20; }



&#x20; return created

}



module.exports = { enforcePolicesForDrift, findMatchingPolicies }





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 3 — Install SDK



bash

cd adip-backend/express-api

npm install @azure/arm-policy





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 4 — Hook into remediation



In routes/remediate.js, after the ARM PUT succeeds, add:



js

const { enforcePolicesForDrift } = require('../services/policyEnforcementService')

// ...

// After ARM PUT:

const policiesCreated = await enforcePolicesForDrift(subscriptionId, rgName, fieldDifferences).catch(e => {

&#x20; console.warn('\[remediate] policy enforcement failed (non-fatal):', e.message)

&#x20; return \[]

})



res.json({

&#x20; remediated: true, resourceId, changeCount: fieldDifferences.length,

&#x20; policiesCreated,  // new field

&#x20; appliedBaseline: baselineStateStripped, previousLiveState: liveStateStripped,

})





Same in remediateDecision.js after the ARM PUT.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 5 — New endpoint: list active policy assignments



In routes/remediate.js (or new routes/policy.js extension):



js

// GET /api/policy/assignments?subscriptionId=\&resourceGroupId=

router\_remediate.get('/policy/assignments', async (req, res) => {

&#x20; const { subscriptionId, resourceGroupId } = req.query

&#x20; if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' })

&#x20; const tc = TableClient.fromConnectionString(process.env.STORAGE\_CONNECTION\_STRING, 'policyAssignments')

&#x20; const items = \[]

&#x20; let filter = `PartitionKey eq '${subscriptionId}'`

&#x20; if (resourceGroupId) filter += ` and resourceGroupId eq '${resourceGroupId}'`

&#x20; for await (const entity of tc.listEntities({ queryOptions: { filter } })) items.push(entity)

&#x20; res.json(items)

})





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 6 — Frontend: ComparisonPage



After successful remediation, show what policies were created:



jsx

{remediationSucceeded \&\& remediationResult?.policiesCreated?.length > 0 \&\& (

&#x20; <div className="cp-alert cp-alert--success">

&#x20;   <strong>✓ {remediationResult.policiesCreated.length} policy assignment(s) created to prevent recurrence:</strong>

&#x20;   <ul style={{ marginTop: 8 }}>

&#x20;     {remediationResult.policiesCreated.map((p, i) => (

&#x20;       <li key={i} style={{ fontSize: 12, color: '#94a3b8' }}>{p.displayName}</li>

&#x20;     ))}

&#x20;   </ul>

&#x20; </div>

)}





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Implementation order



| Step | File | What |

|---|---|---|

| 1 | npm install @azure/arm-policy | One SDK |

| 2 | adip-shared/policy-map.json | Built-in policy ID mappings |

| 3 | services/policyEnforcementService.js | Policy assignment logic |

| 4 | routes/remediate.js | Call enforcement after ARM PUT |

| 5 | routes/remediateDecision.js | Same for email approval path |

| 6 | routes/remediate.js | GET /api/policy/assignments |

| 7 | src/pages/ComparisonPage.jsx | Show created policies after remediation |



Estimated new code: \~120 lines across 4 files.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Testing



1\. Set baseline with allowBlobPublicAccess = false

2\. Change it to true in Azure Portal

3\. Click "Apply Fix Now" on ComparisonPage

4\. Verify: resource reverted + policy assignment created in Azure Portal

5\. Try changing allowBlobPublicAccess to true again → Azure Policy should deny it

6\. Verify policyAssignments Table has the record



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Guidelines compliance



| Guideline | How met |

|---|---|

| Single responsibility | policyEnforcementService.js owns all policy logic |

| Non-fatal | Policy failure never blocks remediation — wrapped in .catch() |

| Idempotent | Checks existing assignments before creating — no duplicates |

| No hardcoding | Policy IDs in JSON map, not in code |

| YAGNI | Only maps policies for resource types in rg-adip |

| Least privilege | Contributor can create Policy Assignments — no Owner needed |





Feature 9



\## Multi-Subscription Analysis — Implementation Plan



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### What it does

Monitors multiple Azure subscriptions simultaneously from one ADIP instance. The dashboard shows a unified view across all

subscriptions — total drift, top drifted resources, compliance status — with the ability to drill into any subscription.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### What actually needs to change



The code already supports multiple subscriptions in most places (subscriptionId is always a parameter). The gaps are:



1\. Event Grid — one subscription per Event Grid subscription (already have adip-sub-logic on sub 8f461bb6). Need one more per

additional subscription.

2\. Dashboard — currently auto-selects first subscription. Need a "All Subscriptions" aggregate view.

3\. After-hours alert — hardcoded to AZURE\_SUBSCRIPTION\_ID. Needs to iterate all accessible subs.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Architecture



User has Reader access on multiple subscriptions

&#x20; → listSubscriptions() already returns all of them

&#x20; → Frontend subscription dropdown already shows all



New: "All Subscriptions" view in DashboardHome

&#x20; → GET /api/stats/all-subscriptions

&#x20; → Queries changesIndex + driftIndex for each subscription in parallel

&#x20; → Returns aggregated { bySubscription: \[...], totals: {...} }



Event Grid (per additional subscription):

&#x20; → az eventgrid event-subscription create (one CLI command per sub)

&#x20; → Points to same eventGridRouter Function





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 1 — Backend: aggregate stats endpoint



routes/drift.js — add one new endpoint:



js

// GET /api/stats/all-subscriptions

// Returns aggregated drift stats across all subscriptions the credential can access

router\_drift.get('/stats/all-subscriptions', async (req, res) => {

&#x20; console.log('\[GET /stats/all-subscriptions] starts')

&#x20; try {

&#x20;   const { listSubscriptions } = require('../services/azureResourceService')

&#x20;   const subscriptions = await listSubscriptions()



&#x20;   const since = new Date()

&#x20;   since.setHours(0, 0, 0, 0)

&#x20;   const sinceISO = since.toISOString()



&#x20;   // Query all subscriptions in parallel

&#x20;   const results = await Promise.allSettled(

&#x20;     subscriptions.map(async sub => {

&#x20;       const subscriptionId = sub.subscriptionId

&#x20;       const tc = getChangesIndexTableClient()

&#x20;       const filter = `PartitionKey eq '${subscriptionId}' and detectedAt ge '${sinceISO}'`



&#x20;       let totalChanges = 0

&#x20;       const uniqueResources = new Set()

&#x20;       for await (const entity of tc.listEntities({ queryOptions: { filter } })) {

&#x20;         totalChanges++

&#x20;         if (entity.resourceId) uniqueResources.add(entity.resourceId)

&#x20;       }



&#x20;       const allTimeTotal = await getTotalChangesCount(subscriptionId).catch(() => 0)



&#x20;       return {

&#x20;         subscriptionId,

&#x20;         displayName:   sub.displayName,

&#x20;         totalChangesToday: totalChanges,

&#x20;         resourcesChanged:  uniqueResources.size,

&#x20;         allTimeTotal,

&#x20;       }

&#x20;     })

&#x20;   )



&#x20;   const bySubscription = results

&#x20;     .filter(r => r.status === 'fulfilled')

&#x20;     .map(r => r.value)



&#x20;   const totals = {

&#x20;     totalChangesToday: bySubscription.reduce((sum, s) => sum + s.totalChangesToday, 0),

&#x20;     totalResourcesChanged: bySubscription.reduce((sum, s) => sum + s.resourcesChanged, 0),

&#x20;     allTimeTotal: bySubscription.reduce((sum, s) => sum + s.allTimeTotal, 0),

&#x20;     subscriptionCount: bySubscription.length,

&#x20;   }



&#x20;   res.json({ bySubscription, totals })

&#x20;   console.log('\[GET /stats/all-subscriptions] ends — subscriptions:', bySubscription.length)

&#x20; } catch (fetchError) {

&#x20;   console.log('\[GET /stats/all-subscriptions] ends — error:', fetchError.message)

&#x20;   res.status(500).json({ error: fetchError.message })

&#x20; }

})





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 2 — Fix after-hours alert to cover all subscriptions



In app.js, update startAfterHoursAlertCheck:



js

// Replace single subscription check with all subscriptions

const { listSubscriptions } = require('./services/azureResourceService')

const allSubscriptions = await listSubscriptions()



for (const sub of allSubscriptions) {

&#x20; const since = new Date(today + 'T00:00:00.000Z').toISOString()

&#x20; const critical = await getDriftRecords({ subscriptionId: sub.subscriptionId, severity: 'critical', limit: 50 })

&#x20; const todayCritical = critical.filter(r => r.detectedAt >= since)

&#x20; for (const record of todayCritical) {

&#x20;   await sendDriftAlertEmail({ ...record, afterHoursAlert: true })

&#x20; }

}





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 3 — Frontend: "All Subscriptions" view in DashboardHome



Add a toggle at the top of DashboardHome:



jsx

const \[viewMode, setViewMode] = useState('single') // 'single' | 'all'

const \[allSubsStats, setAllSubsStats] = useState(null)



// When switching to 'all' view:

useEffect(() => {

&#x20; if (viewMode === 'all') {

&#x20;   fetchAllSubscriptionsStats().then(setAllSubsStats)

&#x20; }

}, \[viewMode])





Toggle UI:

jsx

<div className="dh-view-toggle">

&#x20; <button className={viewMode === 'single' ? 'active' : ''} onClick={() => setViewMode('single')}>

&#x20;   Single Subscription

&#x20; </button>

&#x20; <button className={viewMode === 'all' ? 'active' : ''} onClick={() => setViewMode('all')}>

&#x20;   All Subscriptions

&#x20; </button>

</div>





"All Subscriptions" view renders:

┌─────────────────────────────────────────────────────┐

│  All Subscriptions Overview                          │

│                                                      │

│  Total Changes Today: 134  |  Subscriptions: 3      │

│                                                      │

│  Subscription          Changes  Resources  All Time  │

│  ─────────────────────────────────────────────────  │

│  ADIP Dev (8f461bb6)      45        6        450    │

│  Production (abc123)      89       12        1200   │

│  Staging (def456)          0        0          23   │

└─────────────────────────────────────────────────────┘





Clicking a row sets activeSubscriptionId and switches to single view.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 4 — Add fetchAllSubscriptionsStats to api.js



js

export async function fetchAllSubscriptionsStats() {

&#x20; return apiRequest('/stats/all-subscriptions')

}





━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Step 5 — Register Event Grid for additional subscriptions



One CLI command per additional subscription (run once, not code):



bash

az eventgrid event-subscription create \\

&#x20; --name adip-sub-logic-{subscriptionName} \\

&#x20; --source-resource-id /subscriptions/{additionalSubscriptionId} \\

&#x20; --endpoint https://adip-func-001.azurewebsites.net/api/eventGridRouter \\

&#x20; --endpoint-type webhook \\

&#x20; --included-event-types Microsoft.Resources.ResourceWriteSuccess Microsoft.Resources.ResourceDeleteSuccess





The same eventGridRouter Function handles events from all subscriptions — it already extracts subscriptionId from the event payload.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Implementation order



| Step | File | What |

|---|---|---|

| 1 | routes/drift.js | GET /api/stats/all-subscriptions |

| 2 | app.js | Fix after-hours alert to iterate all subs |

| 3 | src/services/api.js | fetchAllSubscriptionsStats() |

| 4 | src/pages/DashboardHome.jsx | View toggle + all-subs table |

| 5 | Azure CLI | Event Grid subscription per additional sub |



Estimated new code: \~80 lines across 3 files. Zero new Azure services.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Testing



1\. Verify listSubscriptions() returns multiple subs (if credential has access to more than one)

2\. Hit GET /api/stats/all-subscriptions — verify response has bySubscription array

3\. Toggle "All Subscriptions" in dashboard — verify table renders

4\. Click a subscription row — verify switches to single view for that sub

5\. Make a change in the second subscription — verify it appears in the all-subs view



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━





\### Guidelines compliance



| Guideline | How met |

|---|---|

| Parallel fetching | Promise.allSettled — all subscriptions queried simultaneously |

| Design for failures | allSettled — one failing subscription doesn't break others |

| KISS | No new infrastructure — Event Grid already routes by subscriptionId |

| YAGNI | No cross-subscription aggregation DB — Tables already partitioned by subscriptionId |

| Stateless | No per-subscription state in Express — all data in Azure Tables |







