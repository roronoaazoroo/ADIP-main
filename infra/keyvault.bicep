# ============================================================
# FILE: infra/keyvault.bicep
# ROLE: Azure Key Vault for ADIP secrets management
# ============================================================

param location string = resourceGroup().location
param containerAppPrincipalId string

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'adip-kv-001'
  location: location
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
  }
}

// Grant Container App access to secrets
resource kvRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, containerAppPrincipalId, 'Key Vault Secrets User')
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6') // Key Vault Secrets User
    principalId: containerAppPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output vaultUrl string = keyVault.properties.vaultUri
