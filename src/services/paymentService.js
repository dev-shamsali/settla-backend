import { repos } from '../repositories/index.js';
import { page } from '../repositories/base.js';
import { notFound, AppError } from '../lib/errors.js';
import { withIdempotency } from './idempotency.js';
import { evaluatePolicy } from '../policies/policyEngine.js';
import { assessRisk } from '../policies/riskEngine.js';
import { checkPermission } from '../policies/permissionEngine.js';
import { createCase, transition } from './caseService.js';
import { execute, requestApproval } from '../agents/rhea.js';
import { audit } from './auditService.js';
import { sha256 } from '../lib/crypto.js';
import { AUTO_REFUND_LIMIT_INR } from '../config/env.js';
import { caseMachine } from '../domain/stateMachines.js';

export const listPayments = (tenantId, q = {}) =>
  page(repos.payments, tenantId, q.status ? { status: String(q.status) } : {}, q);

export async function getPaymentDetail(ctx, id) {
  const live = await ctx.adapters.payments.getPayment(id);
  if (!live) throw notFound('Payment could not be located', 'PAYMENT_NOT_FOUND');
  const local = await repos.payments.findOne(ctx.tenantId, { gatewayPaymentId: id });
  const [cases, orders] = await Promise.all([
    repos.cases.find(ctx.tenantId, { paymentId: id }, { limit: 10 }),
    repos.orders.find(ctx.tenantId, { paymentRef: id }, { limit: 5 }),
  ]);
  return { payment: { ...local, ...live }, cases, orders };
}

/**
 * Manual/API refund. Amount comes from the gateway, never from the client:
 * the client may only request a LOWER partial amount, which is validated against the live balance.
 */
export async function requestRefund(ctx, paymentId, { amount, reason }, idempotencyKey) {
  return withIdempotency(ctx.tenantId, 'payment.refund', idempotencyKey, { paymentId, amount, reason, actor: ctx.actor.id }, async () => {
    const payment = await ctx.adapters.payments.getPayment(paymentId);
    if (!payment) throw notFound('Payment could not be located', 'PAYMENT_NOT_FOUND');
    const balance = payment.amount - (payment.amountRefunded ?? 0);
    const refundAmount = amount ?? balance;
    if (!(refundAmount > 0) || refundAmount > balance) throw new AppError('REFUND_EXCEEDS_BALANCE', `Refund must be >0 and ≤ ₹${balance}`, 409);

    const existingOrder = await ctx.adapters.orders.findOrderByPaymentRef(paymentId);
    const policy = evaluatePolicy('refund-v1', { payment, refundAmount, existingOrder, signals: {}, limits: { autoExecuteInr: ctx.tenant.limits?.autoExecuteInr ?? AUTO_REFUND_LIMIT_INR } });
    const risk = assessRisk({ amount: refundAmount, payment, customer: {}, signals: {} });
    if (policy.failedRules.length) {
      await audit(ctx, { action: 'refund.rejected_by_policy', resourceType: 'payment', resourceId: paymentId, meta: { policy } });
      throw new AppError('POLICY_REJECTED', policy.reason, 422, { evaluatedRules: policy.evaluatedRules });
    }

    // find or create the owning case
    let c = (await repos.cases.find(ctx.tenantId, { paymentId, status: { $nin: ['RESOLVED', 'REFUNDED', 'CLOSED'] } }, { limit: 1 }))[0];
    if (!c) {
      const customer = await repos.customers.findOne(ctx.tenantId, { email: payment.email });
      c = await createCase(ctx, { paymentId, amount: payment.amount, customerEmail: payment.email, customerName: customer?.name, customerId: customer?._id, channel: 'manual' });
      for (const s of ['OBSERVING', 'INVESTIGATING', 'DECIDING']) await transition(ctx, c._id, s, 'manual refund request');
      c = await repos.cases.findById(ctx.tenantId, c._id);
    }
    const plan = {
      decision: 'REFUND', tool: 'refund_payment', amount: refundAmount, confidence: 1, evidence: [`Manual refund requested by ${ctx.actor.id}`],
      parameters: { paymentId, amount: refundAmount, reason: reason ?? 'manual_refund' }, required_permission: 'payments:refund', escalation_reason: reason,
      idempotency_key: sha256(`${ctx.tenantId}:${c._id}:refund:${paymentId}:${refundAmount}:${idempotencyKey}`).slice(0, 48),
    };
    const perm = checkPermission({ actor: ctx.actor, tool: 'refund_payment', amount: refundAmount, tenant: ctx.tenant });
    if (perm.requiresApproval || policy.requiresApproval) {
      const ap = await requestApproval(ctx, c, plan, policy, risk, undefined, payment);
      return { status: 'APPROVAL_REQUIRED', approvalId: ap._id, caseId: c._id, amount: refundAmount, policy: policy.reason };
    }
    if (!perm.allowed) throw new AppError('PERMISSION_DENIED', perm.reason, 403);
    if (!caseMachine.canTransition(c.status, 'EXECUTING') && c.status !== 'DECIDING') throw new AppError('CASE_STATE_CONFLICT', `Case is ${c.status}`, 409);
    const r = await execute(ctx, c, plan, policy, risk, { payment });
    return { status: r.status, caseId: c._id, amount: refundAmount, result: r.result };
  });
}
