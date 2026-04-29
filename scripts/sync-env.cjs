/**
 * sync-env.cjs — verifies root .env exists and is non-empty.
 * Both Express API and Function App load from root .env directly via dotenv path option.
 * Vite reads VITE_* vars from root .env automatically.
 */
const fs   = require('fs')
const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const ENV  = path.join(ROOT, '.env')

if (!fs.existsSync(ENV)) {
  console.error('❌  .env not found. Run: cp .env.example .env  then fill in your values.')
  process.exit(1)
}
const content = fs.readFileSync(ENV, 'utf-8')
const filled  = content.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.includes('<'))
console.log(`✅  .env found — ${filled.length} variable(s) configured.`)
