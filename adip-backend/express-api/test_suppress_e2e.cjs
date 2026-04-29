require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') })
const http = require('http')
const HOST = '172.17.112.1'
const SUB  = '8f461bb6-e3a4-468b-b134-8b1269337ac7'
const RG   = 'rg-adip'
const RES  = '/subscriptions/' + SUB + '/resourceGroups/rg-adip/providers/Microsoft.Storage/storageAccounts/adipstore001'

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const opts = { hostname: HOST, port: 3001, path: '/api' + path, method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }
    const r = http.request(opts, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => resolve({ status: res.statusCode, body: d }))
    })
    r.on('error', reject)
    if (data) r.write(data)
    r.end()
  })
}

async function main() {
  // Step 1: Run compare WITHOUT suppression rule — see all diffs
  console.log('=== Step 1: Compare WITHOUT suppression rule ===')
  const r1 = await req('POST', '/compare', { subscriptionId: SUB, resourceGroupId: RG, resourceId: RES })
  const d1 = JSON.parse(r1.body)
  console.log('Status:', r1.status)
  console.log('Changes:', d1.changeCount, '| Severity:', d1.severity)
  console.log('Diff paths:', (d1.differences || []).map(d => d.path))

  // Step 2: Add suppression rule for 'tags'
  console.log('\n=== Step 2: Add suppression rule for "tags" ===')
  const addRule = await req('POST', '/suppression-rules', {
    subscriptionId: SUB, fieldPath: 'tags', resourceGroupId: RG, changeTypes: ['all'], reason: 'e2e test'
  })
  const rule = JSON.parse(addRule.body)
  console.log('Rule added:', rule.rowKey, '| field:', rule.fieldPath)

  // Step 3: Run compare WITH suppression rule — tags should be filtered
  console.log('\n=== Step 3: Compare WITH suppression rule ===')
  const r2 = await req('POST', '/compare', { subscriptionId: SUB, resourceGroupId: RG, resourceId: RES })
  const d2 = JSON.parse(r2.body)
  console.log('Status:', r2.status)
  console.log('Changes:', d2.changeCount, '| Severity:', d2.severity)
  console.log('Diff paths:', (d2.differences || []).map(d => d.path))
  const tagDiffsRemaining = (d2.differences || []).filter(d => d.path?.startsWith('tags'))
  console.log('Tag diffs remaining (should be 0):', tagDiffsRemaining.length)

  // Step 4: Cleanup
  await req('DELETE', `/suppression-rules/${encodeURIComponent(rule.rowKey)}?subscriptionId=${SUB}`)
  console.log('\n=== Cleanup done ===')
  console.log('Suppression working:', tagDiffsRemaining.length === 0 ? '✓ YES' : '✗ NO')
}
main().catch(e => console.error('FATAL:', e.message))
