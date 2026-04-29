'use strict'
const router = require('express').Router()
const fetch  = require('node-fetch')

// AI operations are handled by the aiOperations Azure Function
// Express proxies to the Function App — frontend keeps calling /api/ai/*
// Builds the full URL for the aiOperations Azure Function
// Appends the function key as ?code= if AI_FUNCTION_KEY is set in .env
function buildAiFunctionUrl(operationName) {
  const functionAppBaseUrl = process.env.FUNCTION_APP_URL?.replace(/\/$/, '')
  if (!functionAppBaseUrl) throw new Error('FUNCTION_APP_URL environment variable is not set')
  const functionAuthKey = process.env.AI_FUNCTION_KEY || ''
  return `${functionAppBaseUrl}/ai/${operationName}${functionAuthKey ? `?code=${functionAuthKey}` : ''}`
}

// Forwards a POST request to the aiOperations Function and returns the JSON response
async function forwardPostToAiFunction(operationName, requestBody) {
  const httpResponse = await fetch(buildAiFunctionUrl(operationName), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(requestBody),
  })
  if (!httpResponse.ok) throw new Error(`AI Function error ${httpResponse.status}: ${await httpResponse.text()}`)
  return httpResponse.json()
}

// Forwards a GET request to the aiOperations Function and returns the JSON response
async function forwardGetToAiFunction(operationName, queryParams) {
  const queryString  = new URLSearchParams(queryParams).toString()
  const fullUrl      = buildAiFunctionUrl(operationName) + (queryString ? `&${queryString}` : '')
  const httpResponse = await fetch(fullUrl)
  if (!httpResponse.ok) throw new Error(`AI Function error ${httpResponse.status}: ${await httpResponse.text()}`)
  return httpResponse.json()
}

router.post('/ai/explain',   async (req, res) => { try { res.json(await forwardPostToAiFunction('explain',   req.body))  } catch (aiError) { res.status(500).json({ error: aiError.message }) } })
router.post('/ai/severity',  async (req, res) => { try { res.json(await forwardPostToAiFunction('severity',  req.body))  } catch (aiError) { res.status(500).json({ error: aiError.message }) } })
router.post('/ai/recommend', async (req, res) => { try { res.json(await forwardPostToAiFunction('recommend', req.body))  } catch (aiError) { res.status(500).json({ error: aiError.message }) } })
router.get('/ai/predict',    async (req, res) => { try { res.json(await forwardGetToAiFunction('predict',    req.query)) } catch (aiError) { res.status(500).json({ error: aiError.message }) } })
router.get('/ai/recommendations', async (req, res) => { try { res.json(await forwardGetToAiFunction('recommendations', req.query)) } catch (aiError) { res.status(500).json({ error: aiError.message }) } })
router.get('/ai/rg-recommendations', async (req, res) => { try { res.json(await forwardGetToAiFunction('rg-recommendations', req.query)) } catch (aiError) { res.status(500).json({ error: aiError.message }) } })

module.exports = router
