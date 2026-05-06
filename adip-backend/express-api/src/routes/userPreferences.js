
// FILE: adip-backend/express-api/src/routes/userPreferences.js
// ROLE: Per-user settings persistence

// GET  /api/user-preferences?username=
// POST /api/user-preferences  — Body: { username, preferences: {...} }

// Stored in Azure Table Storage (userPreferences table).
// PartitionKey = username, RowKey = 'settings'

'use strict'
const router = require('express').Router()
const { TableClient } = require('@azure/data-tables')

function tableClient() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'userPreferences')
}

// GET /api/user-preferences?username=
router.get('/user-preferences', async (req, res) => {
  console.log('[GET /user-preferences] starts')
  const { username } = req.query
  if (!username) return res.status(400).json({ error: 'username required' })

  try {
    const entity = await tableClient().getEntity(username, 'settings')
    const prefs = JSON.parse(entity.preferences || '{}')
    res.json(prefs)
    console.log('[GET /user-preferences] ends — username:', username)
  } catch (err) {
    if (err.statusCode === 404) {
      res.json({})  // no preferences yet — return empty object
    } else {
      console.log('[GET /user-preferences] error:', err.message)
      res.status(500).json({ error: err.message })
    }
  }
})

// POST /api/user-preferences
// Body: { username, preferences: {...} }
router.post('/user-preferences', async (req, res) => {
  console.log('[POST /user-preferences] starts')
  const { username, preferences } = req.body
  if (!username || !preferences) {
    return res.status(400).json({ error: 'username and preferences required' })
  }

  try {
    await tableClient().upsertEntity({
      partitionKey: username,
      rowKey:       'settings',
      preferences:  JSON.stringify(preferences),
      updatedAt:    new Date().toISOString(),
    }, 'Replace')
    res.json({ saved: true })
    console.log('[POST /user-preferences] ends — username:', username)
  } catch (err) {
    console.log('[POST /user-preferences] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
