import { CONFIDENCE_THRESHOLD } from '../config/env.js';
import { decisionTool } from './llm.js';
import { TOOL_PERMISSIONS } from '../policies/permissionEngine.js';
import { sha256 } from '../lib/crypto.js';

/**
 * Deterministic guard between the LLM proposal and everything else.
 * The model can never widen its own authority: tool, permission, amount, and
 * idempotency key are re-derived here from trusted data.
 */
export function enforceHardRules(plan, ctx) {
  const overrides = [];
  const out = { ...plan };

  // 1) tool must correspond to decision
  const expectedTool = decisionTool[out.decision];
  if (out.tool !== expectedTool) { overrides.push(`tool_corrected:${out.tool}->${expectedTool}`); out.tool = expectedTool; }
  out.required_permission = TOOL_PERMISSIONS[out.tool];

  // 2) amount is authoritative from the gateway, never from the model/frontend
  if (out.decision === 'RECOVER_ORDER') {
    out.amount = ctx.payment?.amount ?? 0;
  } else if (out.decision === 'REFUND') {
    const balance = (ctx.payment?.amount ?? 0) - (ctx.payment?.amountRefunded ?? 0);
    const wanted = Number(out.parameters?.amount ?? out.amount ?? 0);
    const clamped = Math.min(Math.max(wanted, 0), balance);
    if (clamped !== wanted) overrides.push(`refund_amount_clamped:${wanted}->${clamped}`);
    out.amount = clamped;
    out.parameters = { ...out.parameters, paymentId: ctx.payment?.id, amount: clamped };
  }
  if (out.decision === 'RECOVER_ORDER') {
    out.parameters = { paymentId: ctx.payment?.id, total: ctx.payment?.amount, items: ctx.cart?.items ?? [] };
  }

  // 3) hard escalation conditions the model cannot override
  const s = ctx.signals ?? {};
  const forced = [];
  if (out.confidence < CONFIDENCE_THRESHOLD) forced.push('low_confidence');
  if (s.requestsHuman) forced.push('customer_requested_human');
  if (s.chargeback || s.legal) forced.push('legal_or_chargeback');
  if (s.systemsDisagree) forced.push('systems_disagree');
  if (s.hostile) forced.push('hostile_sentiment');
  if (s.injection) forced.push('prompt_injection');
  if (forced.length && out.decision !== 'ESCALATE') {
    overrides.push(`forced_escalation:${forced.join('|')}`);
    out.decision = 'ESCALATE';
    out.tool = 'escalate';
    out.required_permission = TOOL_PERMISSIONS.escalate;
    out.escalation_reason = forced.join(',');
    out.policy = 'none';
  } else if (forced.length) {
    out.escalation_reason = out.escalation_reason ?? forced.join(',');
  }

  // 4) deterministic idempotency key (never model-supplied)
  out.idempotency_key = sha256(`${ctx.tenantId}:${ctx.caseId}:${out.tool}:${ctx.payment?.id ?? 'none'}:${out.amount}`).slice(0, 48);
  return { plan: out, overrides };
}
