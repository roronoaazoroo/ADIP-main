// ============================================================
// FILE: adip-backend/express-api/src/shared/complianceMap.js
// ROLE: Static mapping of ARM property paths to compliance controls
//
// Maps field path patterns (from diffObjects output) to violated
// controls across CIS Azure, NIST SP 800-53, and ISO 27001.
//
// Pattern matching: a diff path "matches" a rule if the path
// contains the rule's pathFragment (case-insensitive).
// ============================================================
'use strict'

// Each rule: { pathFragment, controls: [{ framework, controlId, title }] }
const COMPLIANCE_RULES = [
  {
    pathFragment: 'networkaclsdefaultaction',
    controls: [
      { framework: 'CIS Azure 1.4.0',    controlId: '3.7',      title: 'Ensure default action is set to Deny on Storage Account network ACLs' },
      { framework: 'NIST SP 800-53 R5',  controlId: 'SC-7',     title: 'Boundary Protection' },
      { framework: 'ISO 27001:2013',      controlId: 'A.13.1.1', title: 'Network Controls' },
    ],
  },
  {
    pathFragment: 'networkacls',
    controls: [
      { framework: 'CIS Azure 1.4.0',    controlId: '3.7',      title: 'Storage Account network access restrictions' },
      { framework: 'NIST SP 800-53 R5',  controlId: 'SC-7',     title: 'Boundary Protection' },
    ],
  },
  {
    pathFragment: 'securityrules',
    controls: [
      { framework: 'CIS Azure 1.4.0',    controlId: '6.1',      title: 'Ensure RDP access is restricted from the internet' },
      { framework: 'NIST SP 800-53 R5',  controlId: 'SC-7',     title: 'Boundary Protection' },
      { framework: 'ISO 27001:2013',      controlId: 'A.13.1.3', title: 'Segregation in Networks' },
    ],
  },
  {
    pathFragment: 'encryption',
    controls: [
      { framework: 'CIS Azure 1.4.0',    controlId: '3.2',      title: 'Ensure Storage Account encryption is enabled' },
      { framework: 'NIST SP 800-53 R5',  controlId: 'SC-28',    title: 'Protection of Information at Rest' },
      { framework: 'ISO 27001:2013',      controlId: 'A.10.1.1', title: 'Policy on the Use of Cryptographic Controls' },
    ],
  },
  {
    pathFragment: 'minimumtlsversion',
    controls: [
      { framework: 'CIS Azure 1.4.0',    controlId: '3.15',     title: 'Ensure minimum TLS version is set to 1.2' },
      { framework: 'NIST SP 800-53 R5',  controlId: 'SC-8',     title: 'Transmission Confidentiality and Integrity' },
    ],
  },
  {
    pathFragment: 'supportshttpstrafficonly',
    controls: [
      { framework: 'CIS Azure 1.4.0',    controlId: '3.1',      title: 'Ensure secure transfer required is enabled' },
      { framework: 'NIST SP 800-53 R5',  controlId: 'SC-8',     title: 'Transmission Confidentiality and Integrity' },
      { framework: 'ISO 27001:2013',      controlId: 'A.10.1.1', title: 'Policy on the Use of Cryptographic Controls' },
    ],
  },
  {
    pathFragment: 'allowblobpublicaccess',
    controls: [
      { framework: 'CIS Azure 1.4.0',    controlId: '3.5',      title: 'Ensure public access is disabled on Storage Account' },
      { framework: 'NIST SP 800-53 R5',  controlId: 'AC-3',     title: 'Access Enforcement' },
    ],
  },
  {
    pathFragment: 'accesspolicies',
    controls: [
      { framework: 'CIS Azure 1.4.0',    controlId: '8.1',      title: 'Ensure Key Vault access policies are configured' },
      { framework: 'NIST SP 800-53 R5',  controlId: 'AC-6',     title: 'Least Privilege' },
      { framework: 'ISO 27001:2013',      controlId: 'A.9.4.1',  title: 'Information Access Restriction' },
    ],
  },
  {
    pathFragment: 'identity',
    controls: [
      { framework: 'NIST SP 800-53 R5',  controlId: 'IA-2',     title: 'Identification and Authentication' },
      { framework: 'ISO 27001:2013',      controlId: 'A.9.2.1',  title: 'User Registration and De-registration' },
    ],
  },
  {
    pathFragment: 'sku',
    controls: [
      { framework: 'NIST SP 800-53 R5',  controlId: 'SA-9',     title: 'External System Services' },
    ],
  },
  {
    pathFragment: 'tags',
    controls: [
      { framework: 'CIS Azure 1.4.0',    controlId: '1.15',     title: 'Ensure resource tagging policy is in place' },
    ],
  },
]

/**
 * Maps an array of diff changes to violated compliance controls.
 * Deduplicates controls across all changes.
 * @param {Array} differences — output of diffObjects()
 * @returns {Array} unique violated controls: [{ framework, controlId, title, matchedPath }]
 */
function mapDiffToControls(differences) {
  const seen    = new Set()
  const results = []

  for (const diff of differences) {
    const pathLower = (diff.path || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    for (const rule of COMPLIANCE_RULES) {
      const fragment = rule.pathFragment.toLowerCase().replace(/[^a-z0-9]/g, '')
      if (!pathLower.includes(fragment)) continue
      for (const control of rule.controls) {
        const key = `${control.framework}:${control.controlId}`
        if (seen.has(key)) continue
        seen.add(key)
        results.push({ ...control, matchedPath: diff.path })
      }
    }
  }

  return results
}

module.exports = { mapDiffToControls }
