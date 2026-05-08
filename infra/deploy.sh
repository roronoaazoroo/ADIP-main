# ============================================================
# FILE: infra/deploy.sh
# ROLE: One-command deployment script for ADIP Azure infrastructure
# ============================================================
#!/bin/bash
set -e

RG="rg-adip"
LOCATION="centralus"
ACR_NAME="adipacr"
IMAGE_TAG="adip-api:$(date +%Y%m%d%H%M)"

echo "═══ ADIP Azure Deployment ═══"

# 1. Build and push container image
echo "→ Building container image..."
az acr build --registry $ACR_NAME --image $IMAGE_TAG --file Dockerfile .

# 2. Deploy Key Vault
echo "→ Deploying Key Vault..."
az deployment group create \
  --resource-group $RG \
  --template-file infra/keyvault.bicep \
  --parameters containerAppPrincipalId="placeholder"

KV_URL=$(az deployment group show --resource-group $RG --name keyvault --query 'properties.outputs.vaultUrl.value' -o tsv)

# 3. Deploy Container App
echo "→ Deploying Container App..."
az deployment group create \
  --resource-group $RG \
  --template-file infra/container-app.bicep \
  --parameters \
    containerImage="${ACR_NAME}.azurecr.io/${IMAGE_TAG}" \
    keyVaultUrl="$KV_URL" \
    storageConnectionString="$(az keyvault secret show --vault-name adip-kv-001 --name storage-connection-string --query value -o tsv)"

FQDN=$(az deployment group show --resource-group $RG --name container-app --query 'properties.outputs.fqdn.value' -o tsv)

# 4. Deploy Function App updates
echo "→ Deploying Function App..."
cd adip-backend/function-app
func azure functionapp publish adip-func-001 --javascript
cd ../..

echo ""
echo "═══ Deployment Complete ═══"
echo "API URL: https://$FQDN"
echo "Health:  https://$FQDN/api/health"
