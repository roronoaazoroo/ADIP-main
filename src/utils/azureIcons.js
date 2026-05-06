// FILE: src/utils/azureIcons.js
// ROLE: Maps Azure ARM resource type strings to official Azure SVG icon URLs.
// Source: https://github.com/benc-uk/icon-collection/tree/master/azure-icons (292 icons)
// All icon names below are verified to exist in that collection.
// If no icon is found for a type, returns null — callers must handle null gracefully.

const BASE = 'https://raw.githubusercontent.com/benc-uk/icon-collection/master/azure-icons'
const i = name => `${BASE}/${name}.svg`

// Keyed by lowercase ARM resource type for case-insensitive lookup
const TYPE_MAP = {
  // Compute  
  'microsoft.compute/virtualmachines':                    i('Virtual-Machine'),
  'microsoft.compute/virtualmachinescalesets':            i('VM-Scale-Sets'),
  'microsoft.compute/availabilitysets':                   i('Availability-Sets'),
  'microsoft.compute/disks':                              i('Disks'),
  'microsoft.compute/images':                             i('Images'),
  'microsoft.compute/snapshots':                          i('Disks-Snapshots'),

  //Web / App Service 
  'microsoft.web/sites':                                  i('App-Services'),       // App Service & Function App share this type
  'microsoft.web/serverfarms':                            i('App-Service-Plans'),
  'microsoft.web/staticsites':                            i('Static-Apps'),
  'microsoft.web/certificates':                           i('App-Service-Certificates'),

  // Storage
  'microsoft.storage/storageaccounts':                    i('Storage-Accounts'),
  'microsoft.storage/storagesyncservices':                i('Storage-Sync-Services'),

  // Networking
  'microsoft.network/virtualnetworks':                    i('Virtual-Networks'),
  'microsoft.network/networksecuritygroups':              i('Network-Security-Groups'),
  'microsoft.network/publicipaddresses':                  i('Public-IP-Addresses'),
  'microsoft.network/networkinterfaces':                  i('Network-Interfaces'),
  'microsoft.network/loadbalancers':                      i('Load-Balancers'),
  'microsoft.network/applicationgateways':                i('Application-Gateways'),
  'microsoft.network/virtualnetworkgateways':             i('Virtual-Network-Gateways'),
  'microsoft.network/routetables':                        i('Route-Tables'),
  'microsoft.network/dnszones':                           i('DNS-Zones'),
  'microsoft.network/frontdoors':                         i('Front-Doors'),
  'microsoft.network/firewalls':                          i('Firewalls'),
  'microsoft.network/trafficmanagerprofiles':             i('Traffic-Manager-Profiles'),
  'microsoft.network/ddosprotectionplans':                i('DDoS-Protection-Plans'),
  'microsoft.network/bastionhosts':                       i('Azure-Firewall-Manager'),

  // Security  
  'microsoft.keyvault/vaults':                            i('Key-Vaults'),
  'microsoft.keyvault/managedhsms':                       i('Key-Vaults'),
  'microsoft.security/automations':                       i('Security-Center'),

  // Databases
  'microsoft.sql/servers':                                i('SQL-Server'),
  'microsoft.sql/servers/databases':                      i('SQL-Database'),
  'microsoft.sql/managedinstances':                       i('SQL-Managed-Instance'),
  'microsoft.documentdb/databaseaccounts':                i('Azure-Cosmos-DB'),
  'microsoft.dbformysql/servers':                         i('Azure-Database-MySQL-Server'),
  'microsoft.dbformysql/flexibleservers':                 i('Azure-Database-MySQL-Server'),
  'microsoft.dbforpostgresql/servers':                    i('Azure-Database-PostgreSQL-Server'),
  'microsoft.dbforpostgresql/flexibleservers':            i('Azure-Database-PostgreSQL-Server'),
  'microsoft.dbformariadb/servers':                       i('Azure-Database-MariaDB-Server'),
  'microsoft.cache/redis':                                i('Cache-Redis'),
  'microsoft.synapse/workspaces':                         i('Azure-Synapse-Analytics'),

  // Monitoring & Management
  'microsoft.insights/components':                        i('Application-Insights'),
  'microsoft.insights/actiongroups':                      i('Alerts'),
  'microsoft.insights/activitylogalerts':                 i('Alerts'),
  'microsoft.insights/metricalerts':                      i('Alerts'),
  'microsoft.insights/workbooks':                         i('Azure-Workbooks'),
  'microsoft.insights/scheduledqueryrules':               i('Alerts'),
  'microsoft.alertsmanagement/smartdetectoralertrules':   i('Alerts'),
  'microsoft.alertsmanagement/actionrules':               i('Alerts'),
  'microsoft.operationalinsights/workspaces':             i('Log-Analytics-Workspaces'),
  'microsoft.operationsmanagement/solutions':             i('Monitor'),
  'microsoft.monitor/accounts':                           i('Monitor'),

  // Integration & Messaging
  'microsoft.eventgrid/topics':                           i('Event-Grid-Topics'),
  'microsoft.eventgrid/domains':                          i('Event-Grid-Domains'),
  'microsoft.eventgrid/eventsubscriptions':               i('Event-Grid-Subscriptions'),
  'microsoft.eventhub/namespaces':                        i('Event-Hubs'),
  'microsoft.servicebus/namespaces':                      i('Service-Bus'),
  'microsoft.logic/workflows':                            i('Logic-Apps'),
  'microsoft.logic/integrationaccounts':                  i('Integration-Accounts'),
  'microsoft.apimanagement/service':                      i('API-Management-Services'),
  'microsoft.notificationhubs/namespaces':                i('Notification-Hub-Namespaces'),
  'microsoft.notificationhubs/namespaces/notificationhubs': i('Notification-Hubs'),
  'microsoft.relay/namespaces':                           i('Relays'),

  // AI & Cognitive
  'microsoft.cognitiveservices/accounts':                 i('Cognitive-Services'),
  'microsoft.machinelearningservices/workspaces':         i('Machine-Learning'),

  // Communication
  // No dedicated icon in collection omit (return null)
  'microsoft.communication/communicationservices':        null,
  'microsoft.communication/emailservices':                null,
  'microsoft.communication/emailservices/domains':        null,

  // Containers & Kubernetes
  'microsoft.containerservice/managedclusters':           i('Kubernetes-Services'),
  'microsoft.containerregistry/registries':               i('Container-Registries'),
  'microsoft.containerinstance/containergroups':          i('Container-Instances'),

  // Identity  
  'microsoft.aad/domainservices':                         i('Azure-AD-Domain-Services'),
  'microsoft.managedidentity/userassignedidentities':     i('Managed-Applications-Center'),

  // Automation & DevOps
  'microsoft.automation/automationaccounts':              i('Automation-Accounts'),
  'microsoft.devtestlab/labs':                            i('DevTest-Labs'),

  // Serverless / Functions
  // Microsoft.Web/sites covers both App Service and Function Apps.
  // Use Function-Apps icon when the resource name contains 'func' (handled in getAzureIconUrl)

  // Scope-level ──────
  'resourcegroup':                                        i('Resource-Groups'),
  'subscription':                                         i('Subscriptions'),
  'managementgroup':                                      i('Management-Groups'),
}

/**
 * Returns the Azure icon URL for a given ARM resource type, or null if none is available.
 * @param {string} type  — ARM resource type, e.g. "Microsoft.Storage/storageAccounts"
 * @param {string} [name] — resource name, used to distinguish Function Apps from App Services
 */
export function getAzureIconUrl(type, name = '') {
  if (!type) return null
  const key = type.toLowerCase()

  // Microsoft.Web/sites can be either App Service or Function App.
  // Function Apps typically have 'func' in the name or kind.
  if (key === 'microsoft.web/sites') {
    const lname = (name || '').toLowerCase()
    return lname.includes('func') ? i('Function-Apps') : i('App-Services')
  }

  const url = TYPE_MAP[key]
  return url !== undefined ? url : null   // explicit null means "no icon available"
}

export const RESOURCE_GROUP_ICON_URL = i('Resource-Groups')
export const SUBSCRIPTION_ICON_URL   = i('Subscriptions')
