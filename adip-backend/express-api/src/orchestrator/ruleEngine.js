// ============================================================
// ruleEngine.js — Deterministic policy rules that ALWAYS override AI
// Safety-critical decisions never delegated to AI alone.
// ============================================================
'use strict'

const DEFAULT_POLICIES = {
  CRITICAL_SECURITY_DRIFT: { requireApproval: true, minApprovers: 2, autoRemediate: false, escalateImmediate: true },
  HIGH_SEVERITY: { requireApproval: true, minApprovers: 1, autoRemediate: false },
  MEDIUM_SEVERITY: { requireApproval: false, autoRemediate: true, requireHistoricalApproval: true },
  LOW_SEVERITY: { requireApproval: false, autoRemediate: true },
  MAX_RESOURCE_MODIFICATIONS: { threshold: 5, requireApproval: true },
  OUTSIDE_BUSINESS_HOURS: { escalationRequired: true, businessHoursStart: 9, businessHoursEnd: 18 },
  FREEZE_WINDOW: { blockAll: true },
  EMERGENCY_MODE: { bypassApproval: true, requirePostAudit: true },
  RESOURCE_DELETION: { requireApproval: true, minApprovers: 2 },
  MULTI_RESOURCE_BLAST: { threshold: 3, requireApproval: true },
}

class RuleEngine {
  constructor() {
    this.policies = { ...DEFAULT_POLICIES }
    this.tenantOverrides = new Map()
  }

  /**
   * Evaluate rules against an event. Returns constraints the AI plan MUST respect.
   */
  evaluate(event, tenantPolicies = null) {
    const policies = tenantPolicies || this.policies
    const constraints = {
      requireApproval: false,
      minApprovers: 0,
      autoRemediate: false,
      blocked: false,
      blockReason: '',
      escalate: false,
      maxResources: policies.MAX_RESOURCE_MODIFICATIONS?.threshold || 5,
      emergencyMode: false,
      warnings: [],
    }

    // Freeze window check
    if (this._inFreezeWindow(event.tenantId)) {
      constraints.blocked = true
      constraints.blockReason = 'Change freeze window active. No remediations allowed.'
      return constraints
    }

    // Severity rules
    const severity = (event.severity || '').toLowerCase()
    if (severity === 'critical') {
      constraints.requireApproval = true
      constraints.minApprovers = policies.CRITICAL_SECURITY_DRIFT?.minApprovers || 2
      constraints.escalate = true
      constraints.autoRemediate = false
    } else if (severity === 'high') {
      constraints.requireApproval = true
      constraints.minApprovers = policies.HIGH_SEVERITY?.minApprovers || 1
      constraints.autoRemediate = false
    } else if (severity === 'medium') {
      constraints.requireApproval = policies.MEDIUM_SEVERITY?.requireApproval || false
      constraints.autoRemediate = policies.MEDIUM_SEVERITY?.autoRemediate || true
    } else {
      constraints.autoRemediate = policies.LOW_SEVERITY?.autoRemediate || true
    }

    // Resource deletion always requires approval
    if (event.type === 'resource-deleted' || event.eventType === 'Microsoft.Resources.ResourceDeleteSuccess') {
      constraints.requireApproval = true
      constraints.minApprovers = Math.max(constraints.minApprovers, 2)
      constraints.warnings.push('Resource deletion detected — requires 2 approvals')
    }

    // Multi-resource blast radius
    const affectedCount = event.affectedResources?.length || event.changes?.length || 0
    if (affectedCount > (policies.MULTI_RESOURCE_BLAST?.threshold || 3)) {
      constraints.requireApproval = true
      constraints.warnings.push(`Blast radius: ${affectedCount} resources affected`)
    }

    // Outside business hours
    const hour = new Date().getHours()
    const start = policies.OUTSIDE_BUSINESS_HOURS?.businessHoursStart || 9
    const end = policies.OUTSIDE_BUSINESS_HOURS?.businessHoursEnd || 18
    if (hour < start || hour > end) {
      constraints.escalate = true
      constraints.warnings.push('Outside business hours — escalation required')
    }

    return constraints
  }

  /**
   * Validate an AI-generated plan against rule constraints.
   * Returns { valid, violations, correctedPlan }
   */
  validatePlan(plan, constraints) {
    const violations = []

    if (constraints.blocked) {
      return { valid: false, violations: [constraints.blockReason], correctedPlan: null }
    }

    // AI tried to auto-remediate but rules require approval
    if (constraints.requireApproval && !plan.steps?.some(s => s.action === 'request-approval' || s.action === 'await-approval')) {
      violations.push('Plan missing required approval step')
    }

    // AI tried to modify too many resources
    const remediateSteps = plan.steps?.filter(s => s.action === 'remediate') || []
    if (remediateSteps.length > constraints.maxResources) {
      violations.push(`Plan modifies ${remediateSteps.length} resources, max allowed: ${constraints.maxResources}`)
    }

    // AI tried to delete without approval
    const deleteSteps = plan.steps?.filter(s => s.action === 'delete-resource') || []
    if (deleteSteps.length > 0 && !plan.steps?.some(s => s.action === 'request-approval')) {
      violations.push('Plan includes resource deletion without approval')
    }

    if (violations.length === 0) return { valid: true, violations: [], correctedPlan: plan }

    // Auto-correct: inject approval step before first mutating action
    const corrected = { ...plan, steps: [...(plan.steps || [])] }
    if (constraints.requireApproval && !corrected.steps.some(s => s.action === 'request-approval')) {
      const firstMutating = corrected.steps.findIndex(s => ['remediate', 'delete-resource', 'enforce-policy'].includes(s.action))
      if (firstMutating >= 0) {
        corrected.steps.splice(firstMutating, 0, { action: 'request-approval', approvers: constraints.minApprovers }, { action: 'await-approval' })
      }
    }

    return { valid: false, violations, correctedPlan: corrected }
  }

  _inFreezeWindow(tenantId) {
    // Check tenant-specific freeze windows (could be stored in Table Storage)
    return false // Default: no freeze
  }

  setTenantPolicy(tenantId, overrides) {
    this.tenantOverrides.set(tenantId, { ...this.policies, ...overrides })
  }

  getTenantPolicy(tenantId) {
    return this.tenantOverrides.get(tenantId) || this.policies
  }
}

module.exports = { RuleEngine: new RuleEngine(), DEFAULT_POLICIES }
