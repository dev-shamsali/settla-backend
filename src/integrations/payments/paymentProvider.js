import { AppError } from '../../lib/errors.js';
import { evaluatePolicy } from '../../policies/policyEngine.js';
import { AUTO_REFUND_LIMIT_INR } from '../../config/env.js';

/**
 * PaymentProvider: the only way backend code talks to a payment gateway.
 *   fetchPayment(id) · fetchOrder(ref) · paymentStatus(id) · refundEligibility(id, amount) · refund(...) · refundStatus(id)
 * Implementations hold NO policy. refundEligibility() delegates to the backend policy engine so the
 * decision stays in one authoritative place (never in n8n, never in the adapter).
 */
export const PAYMENT_PROVIDER_METHODS = ['fetchPayment', 'fetchOrder', 'paymentStatus', 'refundEligibility', 'refund', 'refundStatus'];

export function assertPaymentProvider(p) {
  const missing = PAYMENT_PROVIDER_METHODS.filter((m) => typeof p?.[m] !== 'function');
  if (missing.length) throw new Error(`PaymentProvider missing: ${missing.join(', ')}`);
  return p;
}

/**
 * RazorpayAdapter wraps the existing gateway adapter (mock or live). Real money movement is
 * hard-disabled in this phase: refund() always throws FINANCIAL_WRITES_DISABLED, regardless of mode.
 * Enabling it later requires an explicit code change + approval, test keys first.
 */
export class RazorpayAdapter {
  constructor({ payments, orders, limitInr = AUTO_REFUND_LIMIT_INR }) {
    this.payments = payments;
    this.orders = orders;
    this.limitInr = limitInr;
  }

  fetchPayment(id) { return this.payments.getPayment(id); }
  fetchOrder(paymentRef) { return this.orders.findOrderByPaymentRef(paymentRef); }
  async paymentStatus(id) { return (await this.payments.getPayment(id))?.status ?? 'unknown'; }

  /** Returns the backend policy verdict; never moves money. */
  async refundEligibility(id, amount) {
    const payment = await this.payments.getPayment(id);
    if (!payment) return { eligible: false, code: 'PAYMENT_NOT_FOUND', requiresApproval: false, evaluation: null };
    const existingOrder = await this.orders.findOrderByPaymentRef(id);
    const refundAmount = amount ?? payment.amount - (payment.amountRefunded ?? 0);
    const evaluation = evaluatePolicy('refund-v1', { payment, refundAmount, existingOrder, signals: {}, limits: { autoExecuteInr: this.limitInr } });
    return { eligible: evaluation.failedRules.length === 0, requiresApproval: evaluation.requiresApproval, autonomous: evaluation.passed, evaluation };
  }

  async refund() {
    throw new AppError('FINANCIAL_WRITES_DISABLED', 'Real refunds are disabled in this phase', 403);
  }

  refundStatus(id) { return this.payments.getRefund(id); }
}
