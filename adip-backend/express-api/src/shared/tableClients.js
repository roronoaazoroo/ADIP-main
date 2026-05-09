// ============================================================
// FILE: adip-backend/express-api/src/shared/tableClients.js
// ROLE: Centralized Table Storage client factory — eliminates
//       duplicate TableClient.fromConnectionString() calls
// ============================================================
'use strict'
const { TableClient } = require('@azure/data-tables')

const _cache = new Map()

function getTableClient(tableName) {
  if (!_cache.has(tableName)) {
    _cache.set(tableName, TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, tableName))
  }
  return _cache.get(tableName)
}

module.exports = { getTableClient }
