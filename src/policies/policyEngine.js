import { AUTO_REFUND_LIMIT_INR } from '../config/env.js';

/**
 * Versioned, auditable policies. Each rule is pure: (ctx) => { passed, detail }.
 * evaluate() returns every rule result so the UI/audit can show exactly why.
 */
const HOURS_72 = 72 * 3600 * 1000;

const rule = (id, description, fn, { severity = 'block' } = {}) => ({ id, description, fn, severity });

export const POLICIES = {
  'recover-order-v2': {
    key: 'recover-order',
    version: 'v2',
    description: 'Create the missing order for a captured payment when evidence is unambiguous.',
    rules: [
      rule('payment_captured', 'Payment is captured', (c) => ({ passed: c.payment?.status === 'captured', detail: c.payment?.status })),
      rule('no_existing_order', 'No order already linked to payment', (c) => ({ passed: !c.existingOrder, detail: c.existingOrder?.orderNumber ?? 'none' })),
      rule('cart_matches_payment', 'Cart total equals captured amount', (c) => ({
        passed: !!c.cart && c.cart.total === c.payment?.amount,
        detail: `cart=${c.cart?.total ?? 'none'} payment=${c.payment?.amount}`,
      })),
      rule('no_duplicate_72h', 'No duplicate order for same customer+cart in 72h', (c) => ({
        passed: !(c.recentOrders ?? []).some((o) => o.cartHash === c.cart?.hash && Date.now() - new Date(o.createdAt).getTime() < HOURS_72),
        detail: `${(c.recentOrders ?? []).length} recent orders`,
      })),
      rule('inventory_available', 'All cart items in stock', (c) => ({
        passed: !!c.cart && c.cart.items.every((i) => (c.inventory?.[i.sku] ?? 0) >= i.qty),
        detail: JSON.stringify(c.inventory ?? {}),
      })),
      rule('within_auto_limit', `Amount within auto-execution limit ₹${AUTO_REFUND_LIMIT_INR}`, (c) => ({
        passed: (c.payment?.amount ?? Infinity) <= (c.limits?.autoExecuteInr ?? AUTO_REFUND_LIMIT_INR),
        detail: `${c.payment?.amount}`,
      })),
      rule('customer_not_blocked', 'Customer not blocked', (c) => ({ passed: !c.customer?.blocked, detail: c.customer?.blocked ? 'blocked' : 'ok' })),
      rule('no_fraud_signal', 'No fraud signal', (c) => ({ passed: !c.signals?.fraud, detail: c.signals?.fraud ? 'fraud' : 'clear' })),
      rule('no_legal_chargeback', 'No legal/chargeback language', (c) => ({
        passed: !c.signals?.legal && !c.signals?.chargeback,
        detail: `legal=${!!c.signals?.legal} chargeback=${!!c.signals?.chargeback}`,
      })),
    ],
  },
  'refund-v1': {
    key: 'refund',
    version: 'v1',
    description: 'Refund captured payments; amounts above the auto limit require human approval.',
    rules: [
      rule('payment_captured', 'Payment is captured', (c) => ({ passed: c.payment?.status === 'captured' || c.payment?.status === 'partially_refunded', detail: c.payment?.status })),
      rule('refundable_balance', 'Amount ≤ refundable balance', (c) => ({
        passed: c.refundAmount > 0 && c.refundAmount <= (c.payment?.amount ?? 0) - (c.payment?.amountRefunded ?? 0),
        detail: `req=${c.refundAmount} balance=${(c.payment?.amount ?? 0) - (c.payment?.amountRefunded ?? 0)}`,
      })),
      rule('no_chargeback', 'No active chargeback', (c) => ({ passed: !c.signals?.chargeback, detail: `${!!c.signals?.chargeback}` })),
      rule('no_existing_order_for_refund', 'No fulfilled order exists for this payment', (c) => ({ passed: !c.existingOrder, detail: c.existingOrder?.orderNumber ?? 'none' })),
      rule(
        'within_auto_limit',
        `Amount within auto limit ₹${AUTO_REFUND_LIMIT_INR} (else approval)`,
        (c) => ({ passed: c.refundAmount <= (c.limits?.autoExecuteInr ?? AUTO_REFUND_LIMIT_INR), detail: `${c.refundAmount}` }),
        { severity: 'approval' },
      ),
    ],
  },
};

export const listPolicies = () => Object.entries(POLICIES).map(([id, p]) => ({
  id, key: p.key, version: p.version, description: p.description,
  rules: p.rules.map((r) => ({ id: r.id, description: r.description, severity: r.severity })),
}));

export function evaluatePolicy(policyId, ctx) {
  const policy = POLICIES[policyId];
  if (!policy) throw new Error(`Unknown policy ${policyId}`);
  const evaluatedRules = policy.rules.map((r) => {
    let out;
    try { out = r.fn(ctx); } catch (e) { out = { passed: false, detail: `error: ${e.message}` }; }
    return { id: r.id, description: r.description, severity: r.severity, passed: !!out.passed, detail: String(out.detail ?? '') };
  });
  const blocking = evaluatedRules.filter((r) => !r.passed && r.severity === 'block');
  const approval = evaluatedRules.filter((r) => !r.passed && r.severity === 'approval');
  return {
    policy: policyId,
    policyVersion: policy.version,
    passed: blocking.length === 0 && approval.length === 0,
    requiresApproval: blocking.length === 0 && approval.length > 0,
    reason: blocking.length
      ? `Failed: ${blocking.map((r) => r.id).join(', ')}`
      : approval.length ? `Approval required: ${approval.map((r) => r.id).join(', ')}` : 'All rules passed',
    failedRules: blocking.map((r) => r.id),
    evaluatedRules,
  };
}
