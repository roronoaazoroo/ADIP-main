// ============================================================
// FILE: adip-backend/express-api/src/services/mlPredictionService.js
// ROLE: Drift prediction using XGBoost-learned feature weights
//       Weights are exported from trained XGBoost model (training/model/weights.json)
//       No external endpoint needed — runs entirely inside Express
// ============================================================
'use strict'
const path = require('path')
const fs = require('fs')

// Load XGBoost-learned weights (or use defaults)
const WEIGHTS_PATH = path.resolve(__dirname, '../../../../training/model/weights.json')
let LEARNED_WEIGHTS = null

try {
  if (fs.existsSync(WEIGHTS_PATH)) {
    LEARNED_WEIGHTS = JSON.parse(fs.readFileSync(WEIGHTS_PATH, 'utf-8'))
    console.log(`[mlPrediction] XGBoost weights loaded (AUC: ${LEARNED_WEIGHTS.auc_roc}, trained on ${LEARNED_WEIGHTS.samples} samples)`)
  }
} catch { /* use fallback */ }

// Cache predictions for 5 minutes
const _cache = new Map()
const CACHE_TTL = 5 * 60 * 1000

/**
 * Normalizes raw feature values to 0-1 range for scoring.
 */
function normalizeFeatures(f) {
  return [
    Math.min(f[0] / 5, 1),           // change_frequency_7d
    Math.max(0, 1 - f[1] / 48),      // min_inter_arrival (shorter = riskier)
    Math.min(f[2], 1),                // drift_ratio
    f[3] / 3,                         // max_severity (0-3 → 0-1)
    Math.min(f[4] / 5, 1),           // current_drift_streak
    Math.max(0, 1 - f[5] / 30),      // days_since_last_drift (recent = higher)
    Math.max(0, 1 - f[6] / 720),     // recency_hours (recent = higher)
    Math.min(f[7] / 2.5, 1),         // caller_entropy
    f[8],                             // caller_drift_rate (already 0-1)
    f[9] / 6,                         // resource_type (0-6 → 0-1)
    Math.min(f[10] / 3, 1),          // rg_drift_density
    Math.min(f[11] / 60, 1),         // days_since_baseline
    f[12],                            // delete_event_ratio (already 0-1)
  ]
}

/**
 * Predicts drift risk using XGBoost-learned weights.
 * @param {number[][]} featureVectors - array of 13-element feature arrays
 * @returns {number[]} - drift probabilities 0-1 per resource
 */
async function predictDriftRisk(featureVectors) {
  if (!featureVectors.length) return []

  const cacheKey = Buffer.from(JSON.stringify(featureVectors).slice(0, 200)).toString('base64url').slice(0, 32)
  const cached = _cache.get(cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.predictions

  const weights = LEARNED_WEIGHTS?.weights || [0.02, 0.05, 0.20, 0.01, 0.02, 0.05, 0.43, 0.04, 0.03, 0.26, 0.01, 0.00, 0.02]

  const predictions = featureVectors.map(f => {
    if (f.length < 13) return 0
    const norm = normalizeFeatures(f)
    let score = 0
    for (let i = 0; i < 13; i++) score += norm[i] * weights[i]
    return Math.min(Math.round(score * 1000) / 1000, 1.0)
  })

  _cache.set(cacheKey, { predictions, ts: Date.now() })
  for (const [k, v] of _cache) { if (Date.now() - v.ts > CACHE_TTL) _cache.delete(k) }

  return predictions
}

module.exports = { predictDriftRisk }
