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

module.exports = { VOLATILE, CRITICAL_PATHS }
