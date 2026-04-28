require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') })
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential } = require('@azure/identity')
const https = require('https')

function check(name) {
  return new Promise(r => {
    https.get(`https://raw.githubusercontent.com/benc-uk/icon-collection/master/azure-icons/${name}.svg`,
      res => r(res.statusCode === 200)).on('error', () => r(false))
  })
}

async function main() {
  const arm = new ResourceManagementClient(new DefaultAzureCredential(), '8f461bb6-e3a4-468b-b134-8b1269337ac7')
  console.log('=== Resource types in rg-adip ===')
  for await (const r of arm.resources.listByResourceGroup('rg-adip'))
    console.log(r.type, '|', r.name)

  console.log('\n=== Icon checks ===')
  const icons = ['Storage-Accounts','App-Services','Function-Apps','App-Service-Plans',
    'Application-Insights','Event-Grid-Topics','Logic-Apps','Action-Groups','Monitor',
    'Communication-Services','Cognitive-Services','Azure-OpenAI','Resource-Groups',
    'Key-Vaults','Virtual-Machine','Network-Security-Groups','Virtual-Networks','Email',
    'Alert-Rules','Automation-Accounts','Azure-Monitor']
  const results = await Promise.all(icons.map(async n => [n, await check(n)]))
  results.forEach(([n, ok]) => console.log(ok ? '✓' : '✗', n))
}
main().catch(e => console.error(e.message))
