'use strict'

// Caller identity is already resolved from JWT claims in parseMessage.
// This function normalises the value — no external calls needed.
async function resolveIdentity(caller) {
  if (!caller || caller === 'unknown') return null
  return caller
}

module.exports = { resolveIdentity }
