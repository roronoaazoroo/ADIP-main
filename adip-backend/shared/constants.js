'use strict'

const VOLATILE = [
  'etag', 'changedTime', 'createdTime', 'provisioningState',
  'lastModifiedAt', 'systemData', '_ts', '_etag',
  'primaryEndpoints', 'secondaryEndpoints', 'primaryLocation',
  'secondaryLocation', 'statusOfPrimary', 'statusOfSecondary', 'creationTime',
  // VM read-only fields — immutable after creation, ARM rejects on PUT
  'vmId', 'timeCreated', 'instanceView', 'powerState', 'statuses',
  'resources', 'latestModelApplied', 'resourceGuid',
  // VM osProfile — immutable after provisioning
  'adminUsername', 'adminPassword', 'computerName',
  // NSG back-references
  'defaultSecurityRules',
]

const CRITICAL_PATHS = [
  'properties.networkAcls',
  'properties.accessPolicies',
  'properties.securityRules',
  'properties.accessTier',
  'properties.minimumTlsVersion',
  'properties.allowBlobPublicAccess',
  'properties.supportsHttpsTrafficOnly',
  'sku',
  'location',
  'identity',
  'properties.encryption',
]

const API_VERSION_MAP = {
  storageaccounts: '2023-01-01', virtualmachines: '2023-07-01', workflows: '2019-05-01',
  sites: '2023-01-01', vaults: '2023-07-01', virtualnetworks: '2023-05-01',
  networksecuritygroups: '2023-05-01', databaseaccounts: '2024-11-15',
  accounts: '2023-11-01', components: '2020-02-02',
}

module.exports = { VOLATILE, CRITICAL_PATHS, API_VERSION_MAP }
