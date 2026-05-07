require('dotenv').config({ path: '../../.env' })
const { TableClient } = require('@azure/data-tables')
const { BlobServiceClient } = require('@azure/storage-blob')

async function main() {
  const connStr = process.env.STORAGE_CONNECTION_STRING
  
  // 1. Check driftIndex for recent events
  console.log('=== DRIFT INDEX (last 2h) ===')
  const driftTc = TableClient.fromConnectionString(connStr, 'driftIndex')
  const since = new Date(Date.now() - 7200000).toISOString()
  let driftCount = 0
  for await (const e of driftTc.listEntities({ queryOptions: { filter: `PartitionKey eq '8f461bb6-e3a4-468b-b134-8b1269337ac7'` } })) {
    if (e.detectedAt < since) continue
    driftCount++
    console.log(`  ${e.resourceId?.split('/').pop()} | ${e.detectedAt} | blobKey: ${e.blobKey} | severity: ${e.severity}`)
    if (driftCount >= 5) break
  }
  console.log(`  Total drift entries in last 2h: ${driftCount}`)

  // 2. Read one drift blob to see its structure
  if (driftCount > 0) {
    console.log('\n=== SAMPLE DRIFT BLOB ===')
    const blobSvc = BlobServiceClient.fromConnectionString(connStr)
    const container = blobSvc.getContainerClient('drift-records')
    let found = false
    for await (const blob of container.listBlobsFlat()) {
      if (blob.name.includes('2026-05-06')) {
        const content = await container.getBlobClient(blob.name).downloadToBuffer()
        const data = JSON.parse(content.toString())
        console.log(`  Blob: ${blob.name}`)
        console.log(`  Has differences: ${(data.differences || []).length}`)
        if (data.differences?.length) {
          data.differences.slice(0, 3).forEach(d => console.log(`    ${d.type} | ${d.path} | ${JSON.stringify(d.oldValue)?.slice(0,30)} -> ${JSON.stringify(d.newValue)?.slice(0,30)}`))
        }
        found = true
        break
      }
    }
    if (!found) console.log('  No drift blobs from today')
  }
}
main().catch(e => console.log('Error:', e.message))
