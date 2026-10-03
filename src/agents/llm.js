import { env } from '../config/env.js';
import { TOOL_PERMISSIONS } from '../policies/permissionEngine.js';
import { AUTO_REFUND_LIMIT_INR } from '../config/env.js';

/**
 * Provider abstraction: complete({system, user}) -> raw text containing a JSON plan.
 * The mock is a deterministic stand-in so tests/demo never depend on a live model.
 * It reads ONLY the structured evidence block, never the untrusted customer text.
 */
export const decisionTool = { RECOVER_ORDER: 'recover_order', REFUND: 'refund_payment', WAIT_FOR_AUTO_REVERSAL: 'wait_for_reversal', ESCALATE: 'escalate' };

export function deterministicPlan(ev) {
  const base = (decision, confidence, evidence, extra = {}) => ({
    decision, confidence, risk: 'LOW', evidence, tool: decisionTool[decision],
    policy: decision === 'RECOVER_ORDER' ? 'recover-order-v2' : decision === 'REFUND' ? 'refund-v1' : 'none',
    required_permission: TOOL_PERMISSIONS[decisionTool[decision]],
    amount: ev.payment?.amount ?? 0,
    parameters: {}, idempotency_key: `plan-${ev.caseId}-${decision}`.slice(0, 120),
    verification_plan: [], ...extra,
  });
  const e = [];
  if (ev.payment) e.push(`Payment ${ev.payment.id} status=${ev.payment.status} amount=₹${ev.payment.amount}`);
  if (ev.signals?.injection) return base('ESCALATE', 0.99, [...e, 'Prompt-injection attempt detected in customer text'], { escalation_reason: 'prompt_injection', reasoning_summary: 'Customer text contained instruction-like content.' });
  if (ev.signals?.requestsHuman) return base('ESCALATE', 0.99, [...e, 'Customer asked for a human'], { escalation_reason: 'customer_requested_human' });
  if (ev.signals?.legal || ev.signals?.chargeback) return base('ESCALATE', 0.99, [...e, 'Legal/chargeback language'], { escalation_reason: 'legal_or_chargeback' });
  if (ev.signals?.systemsDisagree) return base('ESCALATE', 0.9, [...e, 'Systems of record disagree'], { escalation_reason: 'systems_disagree' });
  if (!ev.payment) return base('ESCALATE', 0.4, ['Payment not found in gateway'], { escalation_reason: 'payment_not_found' });

  if (ev.payment.status !== 'captured') {
    return base('WAIT_FOR_AUTO_REVERSAL', 0.88, [...e, 'Payment not captured: gateway auto-reversal expected'], {
      verification_plan: ['payment still not captured at recheck'],
    });
  }
  e.push(ev.existingOrder ? `Order ${ev.existingOrder.orderNumber} already linked` : 'No order linked to payment');
  if (ev.signals?.duplicatePayment) {
    const amt = ev.signals.duplicateAmount ?? ev.payment.amount;
    return base('REFUND', 0.9, [...e, 'Duplicate capture detected'], {
      amount: amt, parameters: { paymentId: ev.payment.id, amount: amt, reason: 'duplicate_capture' },
      verification_plan: ['refund processed', 'amount matches'],
    });
  }
  if (ev.existingOrder) return base('ESCALATE', 0.8, [...e, 'Order already exists: nothing to recover'], { escalation_reason: 'order_already_exists' });
  if (!ev.cart) return base('ESCALATE', 0.5, [...e, 'No cart snapshot to rebuild order'], { escalation_reason: 'no_cart' });
  e.push(ev.cartMatchesPayment ? 'Cart total matches payment' : 'Cart total does NOT match payment');
  if (!ev.cartMatchesPayment) return base('ESCALATE', 0.55, e, { escalation_reason: 'cart_mismatch' });
  if (!ev.stockAvailable) {
    return base('REFUND', 0.85, [...e, 'Stock unavailable'], {
      amount: ev.payment.amount, parameters: { paymentId: ev.payment.id, amount: ev.payment.amount, reason: 'out_of_stock' },
      verification_plan: ['refund processed', 'amount matches'],
    });
  }
  e.push('Stock available');
  const conf = ev.forceConfidence ?? 0.92;
  return base('RECOVER_ORDER', conf, e, {
    parameters: { paymentId: ev.payment.id, total: ev.payment.amount, items: ev.cart.items },
    verification_plan: ['order exists', 'payment linked', 'amount correct', 'stock reserved', 'customer correct'],
    reasoning_summary: `Captured payment with matching cart and stock; auto limit ₹${AUTO_REFUND_LIMIT_INR}.`,
  });
}

export const mockProvider = {
  name: 'mock',
  async complete({ evidence }) {
    if (evidence?.__simulate === 'llm_failure') throw new Error('LLM provider unavailable');
    if (evidence?.__simulate === 'malformed') return '{"decision": "REFUND", oops';
    if (evidence?.__simulate === 'schema_violation') return JSON.stringify({ decision: 'DROP_DATABASE', tool: 'rm_rf' });
    if (evidence?.__simulate === 'extra_tool') return JSON.stringify({ ...deterministicPlan(evidence), tool: 'wire_transfer' });
    return JSON.stringify(deterministicPlan(evidence));
  },
};

export const anthropicProvider = {
  name: 'anthropic',
  async complete({ system, user }) {
    if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: env.ANTHROPIC_MODEL, max_tokens: 1500, system, messages: [{ role: 'user', content: user }] }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`anthropic ${res.status}`);
      const j = await res.json();
      return j.content?.map((c) => c.text ?? '').join('') ?? '';
    } finally {
      clearTimeout(t);
    }
  },
};

export const getProvider = (name = env.LLM_PROVIDER) => (name === 'anthropic' ? anthropicProvider : mockProvider);
