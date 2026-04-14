'use strict'
const router = require('express').Router()
const fetch  = require('node-fetch')

// AI operations are handled by the aiOperations Azure Function
// Express proxies to the Function App — frontend keeps calling /api/ai/*
function getFunctionUrl(operation) {
  const base = process.env.FUNCTION_APP_URL?.replace(/\/$/, '') || 'https://adip-func-001.azurewebsites.net/api'
  const key  = process.env.AI_FUNCTION_KEY || ''
  return `${base}/ai/${operation}${key ? `?code=${key}` : ''}`
}

async function proxyPost(operation, body) {
  const res = await fetch(getFunctionUrl(operation), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`AI Function error ${res.status}: ${await res.text()}`)
  return res.json()
}

async function proxyGet(operation, query) {
  const params = new URLSearchParams(query).toString()
  const url    = getFunctionUrl(operation) + (params ? `&${params}` : '')
  const res    = await fetch(url)
  if (!res.ok) throw new Error(`AI Function error ${res.status}: ${await res.text()}`)
  return res.json()
}

router.post('/ai/explain',    async (req, res) => { try { res.json(await proxyPost('explain',    req.body)) } catch (e) { res.status(500).json({ error: e.message }) } })
router.post('/ai/severity',   async (req, res) => { try { res.json(await proxyPost('severity',   req.body)) } catch (e) { res.status(500).json({ error: e.message }) } })
router.post('/ai/recommend',  async (req, res) => { try { res.json(await proxyPost('recommend',  req.body)) } catch (e) { res.status(500).json({ error: e.message }) } })
router.get('/ai/anomalies',   async (req, res) => { try { res.json(await proxyGet('anomalies',   req.query)) } catch (e) { res.status(500).json({ error: e.message }) } })

module.exports = router
