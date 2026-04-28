require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') })
const https = require('https')

// Get publishing credentials to access Kudu
const sub = '8f461bb6-e3a4-468b-b134-8b1269337ac7'
const rg  = 'rg-adip'
const app = 'adip-func-001'

// Use Azure REST API to get recent function invocations
const { DefaultAzureCredential } = require('@azure/identity')

async function main() {
  const cred = new DefaultAzureCredential()
  const token = await cred.getToken('https://management.azure.com/.default')
  
  const url = `https://management.azure.com/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Web/sites/${app}/functions/aiOperations/listKeys?api-version=2022-03-01`
  
  const req = https.request(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token.token, 'Content-Length': 0 }
  }, res => {
    let data = ''
    res.on('data', c => data += c)
    res.on('end', () => {
      console.log('listKeys status:', res.statusCode)
      console.log('body:', data.slice(0, 300))
    })
  })
  req.on('error', e => console.error(e.message))
  req.end()
}
main().catch(e => console.error(e.message))
