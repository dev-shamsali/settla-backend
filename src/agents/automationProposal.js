import { AUTO_REFUND_LIMIT_INR } from '../config/env.js';
import { proposalSchema, N8N_ACTIONS, FINANCIAL_ACTIONS, READ_ONLY_ACTIONS, ACTION_PERMISSION, RISK_LEVELS } from '../integrations/n8n/contract.js';
import { assessRisk } from '../policies/riskEngine.js';

/**
 * Rhea proposes; the backend decides. This is deterministic stand-in logic for the planner:
 * it only ever proposes a read-only investigation step first.
 */
export function proposeAutomation(caseDoc, tenant) {
  const limit = tenant?.limits?.autoExecuteInr ?? AUTO_REFUND_LIMIT_INR;
  const level = (caseDoc.risk?.level ?? 'LOW').toLowerCase();
  return {
    caseId: caseDoc.caseNumber,
    decision: 'investigate',
    action: 'payment_lookup',
    riskLevel: level,
    requiresHumanApproval: (caseDoc.amount ?? 0) > limit,
  };
}

const RANK = Object.fromEntries(RISK_LEVELS.map((r, i) => [r, i]));

/**
 * Backend-authoritative gate between an (untrusted) proposal and n8n.
 * Returns { allowed, code, httpStatus, reasons[], backend:{risk, requiresApproval, ...}, action }.
 * The proposal's own riskLevel / requiresHumanApproval are advisory: the backend recomputes both
 * and may only tighten them, never loosen them.
 */
export function decideAutomation({ proposal, caseDoc, tenant, actor, payment, customer, approvedApproval }) {
  const reasons = [];
  const block = (code, httpStatus, msg) => ({ allowed: false, code, httpStatus, reasons: [...reasons, msg], backend: backendView() });

  const limit = tenant?.limits?.autoExecuteInr ?? AUTO_REFUND_LIMIT_INR;
  const amount = payment?.amount ?? caseDoc.amount ?? 0; // authoritative: never the proposal / client
  const risk = assessRisk({ amount, payment, customer: customer ?? {}, signals: {} });
  const requiresApproval = amount > limit;
  const backendView = () => ({ amount, riskScore: risk.riskScore, riskLevel: risk.riskLevel, autoLimit: limit, requiresApproval, policy: 'refund-v1/recover-order-v2 limits' });

  const parsed = proposalSchema.safeParse(proposal);
  if (!parsed.success) return block('INVALID_PROPOSAL', 422, `Proposal rejected: ${parsed.error.issues[0]?.path.join('.') || 'body'} ${parsed.error.issues[0]?.message ?? ''}`.trim());
  const p = parsed.data;
  const action = p.action;

  if (p.caseId !== caseDoc.caseNumber) return block('CASE_MISMATCH', 422, 'Proposal caseId does not match the case');
  if (FINANCIAL_ACTIONS.includes(action) || p.decision === 'refund') return block('FINANCIAL_ACTION_NOT_ALLOWED', 403, 'Financial actions are never executed through n8n');
  if (!N8N_ACTIONS.includes(action)) return block('ACTION_NOT_ALLOWED', 403, `Action "${action}" is not allow-listed`);
  if (caseDoc.status === 'CLOSED') return block('CASE_CLOSED', 409, 'Case is closed');

  const mode = tenant?.executionMode ?? 'AUTONOMOUS';
  const readOnly = READ_ONLY_ACTIONS.includes(action);
  if (tenant?.status && tenant.status !== 'active') return block('TENANT_DISABLED', 403, 'Tenant not active');
  if (mode === 'DISABLED') return block('EXECUTION_DISABLED', 403, 'Tenant execution is DISABLED');
  if (mode === 'RECOMMEND_ONLY' && !readOnly) return block('RECOMMEND_ONLY', 403, 'Tenant is RECOMMEND_ONLY: only read-only investigation is allowed');

  if (!actor.permissions.has('automation:dispatch')) return block('PERMISSION_DENIED', 403, 'Missing permission automation:dispatch');
  const needed = ACTION_PERMISSION[action];
  if (needed && !actor.permissions.has(needed)) return block('PERMISSION_DENIED', 403, `Missing permission ${needed}`);

  // risk may be tightened by the backend, never loosened by the proposal
  const proposed = RANK[String(p.riskLevel).toUpperCase()] ?? 0;
  if (proposed < RANK[risk.riskLevel]) reasons.push(`Proposal risk ${String(p.riskLevel).toUpperCase()} raised to backend risk ${risk.riskLevel}`);
  if (!p.requiresHumanApproval && requiresApproval) reasons.push('Proposal claimed no approval needed; backend requires it (amount above autonomous limit)');

  if (!readOnly && requiresApproval && !approvedApproval) {
    return block('HUMAN_APPROVAL_REQUIRED', 409, `Amount ₹${amount} exceeds the ₹${limit} autonomous limit: an approved human approval is required`);
  }
  if (risk.riskLevel === 'CRITICAL' && !readOnly) return block('RISK_TOO_HIGH', 403, 'Risk is CRITICAL: only read-only investigation is allowed');

  return { allowed: true, code: 'ALLOWED', httpStatus: 200, reasons, action, readOnly, backend: backendView(), proposal: p, humanApprovalSatisfied: requiresApproval ? !!approvedApproval : false };
}
