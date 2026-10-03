const clamp = (n) => Math.min(1, Math.max(0, n));
const round = (n) => Math.round(n * 100) / 100;

/** Additive, capped risk model. Every factor reported so it is explainable. */
export function assessRisk(ctx) {
  const factors = [];
  const add = (name, weight, detail) => { if (weight > 0) factors.push({ name, weight: round(weight), detail }); };
  const amount = ctx.amount ?? ctx.payment?.amount ?? 0;

  add('baseline', 0.045, 'operational baseline');
  add('transaction_amount', Math.min(amount / 100000, 0.25), `₹${amount}`);
  add('duplicate_payment', ctx.signals?.duplicatePayment ? 0.3 : 0, 'same cart/amount captured more than once');
  add('fraud_signal', ctx.signals?.fraud ? 0.45 : 0, 'fraud indicator present');
  add('velocity', Math.min(Math.max((ctx.customer?.paymentsLast24h ?? 1) - 1, 0) / 10, 0.15), `${ctx.customer?.paymentsLast24h ?? 0} payments/24h`);
  add('previous_refunds', Math.min((ctx.customer?.refundCount ?? 0) * 0.05, 0.2), `${ctx.customer?.refundCount ?? 0} prior refunds`);
  add('hostile_sentiment', ctx.signals?.hostile ? 0.12 : 0, 'hostile customer tone');
  add('chargeback_language', ctx.signals?.chargeback ? 0.35 : 0, 'chargeback keywords');
  add('legal_language', ctx.signals?.legal ? 0.4 : 0, 'legal keywords');
  add('system_disagreement', ctx.signals?.systemsDisagree ? 0.3 : 0, 'systems of record disagree');
  add('policy_exception', ctx.policyException ? 0.2 : 0, 'policy exception requested');
  add('prompt_injection', ctx.signals?.injection ? 0.5 : 0, 'prompt injection attempt in customer text');

  const riskScore = round(clamp(factors.reduce((s, f) => s + f.weight, 0)));
  const riskLevel = riskScore < 0.25 ? 'LOW' : riskScore < 0.5 ? 'MEDIUM' : riskScore < 0.75 ? 'HIGH' : 'CRITICAL';
  return { riskScore, riskLevel, factors };
}
