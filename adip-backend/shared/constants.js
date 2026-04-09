'use strict'

const VOLATILE = [
  'etag', 'changedTime', 'createdTime', 'provisioningState',
  'lastModifiedAt', 'systemData', '_ts', '_etag',
  'primaryEndpoints', 'secondaryEndpoints', 'primaryLocation',
  'secondaryLocation', 'statusOfPrimary', 'statusOfSecondary', 'creationTime',
]

const CRITICAL_PATHS = [
  'properties.networkAcls',
  'properties.accessPolicies',
  'properties.securityRules',
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
