// ============================================================
// FILE: src/utils/complianceMap.js
// ROLE: Client-side compliance mapping — maps a diff path to
//       violated compliance controls (CIS, NIST, ISO 27001).
//
// Mirrors the server-side shared/complianceMap.js but runs in
// the browser so each diff row can show controls inline without
// an API call.
// ============================================================

const RULES = [
  { fragment: 'networkaclsdefaultaction', controls: [
    { fw: 'CIS 3.7',    title: 'Storage network ACL default action' },
    { fw: 'NIST SC-7',  title: 'Boundary Protection' },
    { fw: 'ISO A.13.1.1', title: 'Network Controls' },
  ]},
  { fragment: 'networkacls', controls: [
    { fw: 'CIS 3.7',    title: 'Storage network access restrictions' },
    { fw: 'NIST SC-7',  title: 'Boundary Protection' },
  ]},
  { fragment: 'securityrules', controls: [
    { fw: 'CIS 6.1',    title: 'Restrict RDP/SSH from internet' },
    { fw: 'NIST SC-7',  title: 'Boundary Protection' },
    { fw: 'ISO A.13.1.3', title: 'Segregation in Networks' },
  ]},
  { fragment: 'encryption', controls: [
    { fw: 'CIS 3.2',    title: 'Storage encryption enabled' },
    { fw: 'NIST SC-28', title: 'Protection of Information at Rest' },
    { fw: 'ISO A.10.1.1', title: 'Cryptographic Controls' },
  ]},
  { fragment: 'minimumtlsversion', controls: [
    { fw: 'CIS 3.15',   title: 'Minimum TLS version 1.2' },
    { fw: 'NIST SC-8',  title: 'Transmission Confidentiality' },
  ]},
  { fragment: 'supportshttpstrafficonly', controls: [
    { fw: 'CIS 3.1',    title: 'Secure transfer required' },
    { fw: 'NIST SC-8',  title: 'Transmission Confidentiality' },
    { fw: 'ISO A.10.1.1', title: 'Cryptographic Controls' },
  ]},
  { fragment: 'allowblobpublicaccess', controls: [
    { fw: 'CIS 3.5',    title: 'Disable public blob access' },
    { fw: 'NIST AC-3',  title: 'Access Enforcement' },
  ]},
  { fragment: 'accesspolicies', controls: [
    { fw: 'CIS 8.1',    title: 'Key Vault access policies' },
    { fw: 'NIST AC-6',  title: 'Least Privilege' },
    { fw: 'ISO A.9.4.1', title: 'Information Access Restriction' },
  ]},
  { fragment: 'identity', controls: [
    { fw: 'NIST IA-2',  title: 'Identification and Authentication' },
    { fw: 'ISO A.9.2.1', title: 'User Registration' },
  ]},
  { fragment: 'tags', controls: [
    { fw: 'CIS 1.15',   title: 'Resource tagging policy' },
  ]},
]

/**
 * Returns compliance controls violated by a single diff path.
 * @param {string} path — e.g. "properties → networkAcls → defaultAction"
 * @returns {Array} [{ fw, title }]
 */
export function getControlsForPath(path) {
  if (!path) return []
  const normalised = path.toLowerCase().replace(/[^a-z0-9]/g, '')
  const results = []
  for (const rule of RULES) {
    if (normalised.includes(rule.fragment)) {
      results.push(...rule.controls)
    }
  }
  return results
}
