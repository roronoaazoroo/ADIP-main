// ============================================================
// FILE: adip-backend/express-api/src/seedOrgData.js
// ROLE: Seeds organizations + orgMembers tables with dummy data
//       Run once: node src/seedOrgData.js
// ============================================================
'use strict'
require('dotenv').config({ path: '../../.env' })
const { TableClient } = require('@azure/data-tables')
const bcrypt = require('bcryptjs')

const CONN = process.env.STORAGE_CONNECTION_STRING

const ORG = {
  orgId: 'cloudthat',
  organizationName: 'CloudThat Technologies',
  organizationToken: 'ADIP-CLOUDTHAT-7F3A9B',
  adminUserId: 'saksham-001',
  subscriptionId: '8f461bb6-e3a4-468b-b134-8b1269337ac7',
  retentionDays: 90,
  requiredApprovals: 2,
}

const MEMBERS = [
  { userId: 'saksham-001', email: 'saksham@cloudthat.com', name: 'Saksham Midha', role: 'admin', password: 'Admin@123' },
  { userId: 'rounak-002', email: 'rounak@cloudthat.com', name: 'Rounak Chandrakar', role: 'approver', password: 'Admin@123' },
  { userId: 'ravi-003', email: 'ravi@cloudthat.com', name: 'Ravi Davadra', role: 'requestor', password: 'Admin@123' },
]

async function seed() {
  console.log('Seeding organization data...')

  const orgsTable = TableClient.fromConnectionString(CONN, 'organizations')
  const membersTable = TableClient.fromConnectionString(CONN, 'orgMembers')

  // Create org
  await orgsTable.upsertEntity({
    partitionKey: ORG.orgId,
    rowKey: ORG.orgId,
    organizationName: ORG.organizationName,
    organizationToken: ORG.organizationToken,
    adminUserId: ORG.adminUserId,
    subscriptionId: ORG.subscriptionId,
    retentionDays: ORG.retentionDays,
    requiredApprovals: ORG.requiredApprovals,
    createdAt: new Date().toISOString(),
  }, 'Replace')
  console.log('  ✓ Organization created:', ORG.organizationName)
  console.log('    Token:', ORG.organizationToken)

  // Create members
  for (const member of MEMBERS) {
    const passwordHash = await bcrypt.hash(member.password, 10)
    await membersTable.upsertEntity({
      partitionKey: ORG.orgId,
      rowKey: member.userId,
      email: member.email,
      name: member.name,
      role: member.role,
      passwordHash,
      joinedAt: new Date().toISOString(),
    }, 'Replace')
    console.log(`  ✓ Member: ${member.name} (${member.role}) — ${member.email}`)
  }

  console.log('\nDone! Login credentials:')
  console.log('┌──────────────────────────┬──────────────┬────────────┐')
  console.log('│ Email                    │ Password     │ Role       │')
  console.log('├──────────────────────────┼──────────────┼────────────┤')
  MEMBERS.forEach(m => {
    console.log(`│ ${m.email.padEnd(24)} │ ${m.password.padEnd(12)} │ ${m.role.padEnd(10)} │`)
  })
  console.log('└──────────────────────────┴──────────────┴────────────┘')
  console.log('\nOrg token for joining:', ORG.organizationToken)
}

seed().catch(e => { console.error('Error:', e.message); process.exit(1) })
