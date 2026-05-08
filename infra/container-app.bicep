# ============================================================
# FILE: infra/container-app.bicep
# ROLE: Azure Container Apps deployment for ADIP Express API
# ============================================================

@description('Location for all resources')
param location string = resourceGroup().location

@description('Container image to deploy')
param containerImage string = 'adipacr.azurecr.io/adip-api:latest'

@description('Key Vault URL for secrets')
param keyVaultUrl string

@description('Storage account connection string (Key Vault reference)')
@secure()
param storageConnectionString string

param logAnalyticsWorkspaceId string

// Container Apps Environment
resource environment 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: 'adip-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsWorkspaceId
      }
    }
  }
}

// Container App — ADIP Express API
resource containerApp 'Microsoft.App/containerApps@2023-05-01' = {
  name: 'adip-api'
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3001
        transport: 'http'
        corsPolicy: {
          allowedOrigins: ['https://adip.azurewebsites.net', 'http://localhost:5173']
          allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
          allowedHeaders: ['*']
        }
      }
      secrets: [
        { name: 'storage-conn', value: storageConnectionString }
      ]
      registries: [
        { server: 'adipacr.azurecr.io', identity: 'system' }
      ]
    }
    template: {
      containers: [
        {
          name: 'adip-api'
          image: containerImage
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'PORT', value: '3001' }
            { name: 'NODE_ENV', value: 'production' }
            { name: 'KEY_VAULT_URL', value: keyVaultUrl }
            { name: 'STORAGE_CONNECTION_STRING', secretRef: 'storage-conn' }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/api/health', port: 3001 }
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: { path: '/api/health', port: 3001 }
              initialDelaySeconds: 10
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 5
        rules: [
          {
            name: 'http-scaling'
            http: { metadata: { concurrentRequests: '50' } }
          }
        ]
      }
    }
  }
}

// Output the FQDN
output fqdn string = containerApp.properties.configuration.ingress.fqdn
output principalId string = containerApp.identity.principalId
