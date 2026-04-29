'use strict'

// Shared blob key helpers used by both the Express API and the Function App

function blobKey(resourceId) {
  return Buffer.from(resourceId).toString('base64url') + '.json'
}

function driftKey(resourceId, ts) {
  const stamp = (ts || new Date().toISOString()).replace(/[:.]/g, '-')
  return `${stamp}_${Buffer.from(resourceId).toString('base64url')}.json`
}

async function readBlob(containerClient, blobName) {
  try {
    const buf = await containerClient.getBlobClient(blobName).downloadToBuffer()
    return JSON.parse(buf.toString('utf-8'))
  } catch (e) {
    if (e.statusCode === 404 || e.code === 'BlobNotFound') return null
    throw e
  }
}

async function writeBlob(containerClient, blobName, data) {
  const body = JSON.stringify(data)
  await containerClient
    .getBlockBlobClient(blobName)
    .upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: 'application/json' } })
}

module.exports = { blobKey, driftKey, readBlob, writeBlob }
