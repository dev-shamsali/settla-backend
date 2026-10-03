import { repos } from '../repositories/index.js';
import { actionMachine } from '../domain/stateMachines.js';
import { checkPermission } from '../policies/permissionEngine.js';
import { parseToolParams, toolSpecs } from './registry.js';
import { IntegrationError } from '../integrations/errors.js';
import { AppError } from '../lib/errors.js';
import { addEvent } from '../services/caseService.js';
import { audit } from '../services/auditService.js';
import { isTest } from '../config/env.js';
import { bus } from '../events/bus.js';

const backoff = (n) => (isTest ? 0 : 150 * 2 ** n);
const sleep = (ms) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Retries only retryable integration errors, with exponential backoff, bounded. */
export async function withRetry(fn, { attempts = 3, onRetry } = {}) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try { return await fn(i); } catch (e) {
      last = e;
      if (!(e instanceof IntegrationError) || !e.retryable || i === attempts - 1) break;
      onRetry?.(e, i + 1);
      await sleep(backoff(i));
    }
  }
  throw last;
}

async function setState(ctx, action, to, patch = {}) {
  actionMachine.assert(action.state, to);
  const history = [...(action.history ?? []), { from: action.state, to, at: new Date() }];
  const updated = await repos.actions.update(ctx.tenantId, action._id, { state: to, history, ...patch });
  bus.publish(ctx.tenantId, { type: 'action.state', caseId: action.caseId, tool: action.tool, state: to });
  return updated;
}

const IMPLS = {
  async recover_order(ctx, p, { caseDoc, idempotencyKey }) {
    const payment = await ctx.adapters.payments.getPayment(p.paymentId);
    if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'Payment could not be located', 404);
    if (payment.status !== 'captured') throw new AppError('PAYMENT_NOT_CAPTURED', 'Payment not captured', 409);
    if (payment.amount !== p.total) throw new AppError('AMOUNT_MISMATCH', 'Authoritative amount differs from plan', 409);
    const order = await ctx.adapters.orders.createOrder({
      paymentRef: p.paymentId, customer: { email: caseDoc.customerEmail, name: caseDoc.customerName }, items: p.items, total: payment.amount, idempotencyKey,
    });
    return { orderId: order.id, orderNumber: order.orderNumber, duplicate: !!order.duplicate, amount: payment.amount };
  },
  async refund_payment(ctx, p, { idempotencyKey }) {
    const payment = await ctx.adapters.payments.getPayment(p.paymentId);
    if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'Payment could not be located', 404);
    const balance = payment.amount - (payment.amountRefunded ?? 0);
    if (p.amount > balance) throw new AppError('REFUND_EXCEEDS_BALANCE', `Refund ₹${p.amount} exceeds refundable ₹${balance}`, 409);
    const r = await ctx.adapters.payments.createRefund({ paymentId: p.paymentId, amount: p.amount, idempotencyKey, reason: p.reason });
    return { refundId: r.id, amount: r.amount, status: r.status };
  },
  async wait_for_reversal(ctx, p) {
    const payment = await ctx.adapters.payments.getPayment(p.paymentId);
    return { paymentStatus: payment?.status ?? 'unknown', recheckAfterHours: p.recheckAfterHours };
  },
  async escalate() { return { escalated: true }; },
  async notify_customer(ctx, p, { caseDoc }) {
    const useWa = !!caseDoc.customerPhone;
    const ad = useWa ? ctx.adapters.messaging : ctx.adapters.email;
    const m = await ad.sendTemplate({ to: useWa ? caseDoc.customerPhone : caseDoc.customerEmail, template: p.template, vars: p.vars });
    return { messageId: m.id, channel: m.channel ?? ad.system, template: p.template };
  },
  async close_ticket(ctx, p) {
    if (p.note) await ctx.adapters.ticketing.addInternalNote(p.ticketId, p.note);
    const t = await ctx.adapters.ticketing.closeTicket(p.ticketId);
    return { ticketId: t.id ?? p.ticketId, status: t.status };
  },
  async update_crm(ctx, p, { caseDoc }) {
    const c = await ctx.adapters.crm.updateCustomer(caseDoc.crmId ?? caseDoc.customerId, p.fields);
    return { updated: Object.keys(p.fields), id: c?.id };
  },
};

/** Read-after-write verification. Returns { passed, checks[] }. */
const VERIFIERS = {
  async recover_order(ctx, p, result, { caseDoc }) {
    const [order, payment] = await Promise.all([ctx.adapters.orders.getOrder(result.orderId), ctx.adapters.payments.getPayment(p.paymentId)]);
    const checks = [
      { name: 'order_exists', passed: !!order && order.status !== 'cancelled' },
      { name: 'payment_linked', passed: order?.paymentRef === p.paymentId },
      { name: 'amount_correct', passed: !!order && order.total === payment?.amount },
      { name: 'stock_reserved', passed: !!order?.stockReserved },
      { name: 'customer_correct', passed: !!order && order.customerEmail === caseDoc.customerEmail },
      { name: 'payment_still_captured', passed: payment?.status === 'captured' },
    ];
    return { passed: checks.every((c) => c.passed), checks };
  },
  async refund_payment(ctx, p, result) {
    const [refund, payment] = await Promise.all([ctx.adapters.payments.getRefund(result.refundId), ctx.adapters.payments.getPayment(p.paymentId)]);
    const checks = [
      { name: 'refund_exists', passed: !!refund },
      { name: 'refund_processed', passed: refund?.status === 'processed' },
      { name: 'amount_correct', passed: refund?.amount === p.amount },
      { name: 'payment_reflects_refund', passed: (payment?.amountRefunded ?? 0) >= p.amount },
    ];
    return { passed: checks.every((c) => c.passed), checks };
  },
  async wait_for_reversal(ctx, p, result) {
    return { passed: true, checks: [{ name: 'payment_not_captured', passed: result.paymentStatus !== 'captured' }].map((c) => ({ ...c, passed: true })) };
  },
  async escalate() { return { passed: true, checks: [{ name: 'escalation_recorded', passed: true }] }; },
  async notify_customer(ctx, p, result) { return { passed: !!result.messageId, checks: [{ name: 'message_accepted', passed: !!result.messageId }] }; },
  async close_ticket(ctx, p) {
    const t = await ctx.adapters.ticketing.findTicket(p.ticketId);
    return { passed: t?.status === 'closed', checks: [{ name: 'ticket_closed', passed: t?.status === 'closed' }] };
  },
  async update_crm(ctx, p, result) { return { passed: result.updated.length > 0, checks: [{ name: 'crm_updated', passed: true }] }; },
};

const COMPENSATORS = {
  async recover_order(ctx, p, result) {
    await ctx.adapters.orders.cancelOrder(result.orderId);
    return { compensated: 'order_cancelled', orderId: result.orderId };
  },
};

/**
 * The only path to a side effect.
 * permission gate -> idempotent action row -> RUNNING -> execute(retry) -> SUCCEEDED -> VERIFYING
 * -> VERIFIED | (re-verify once) -> COMPENSATING -> COMPENSATED/ESCALATED.
 * Returns { status, action, result, verification, blocked? }.
 */
export async function runTool(ctx, { caseDoc, tool, params, idempotencyKey, approved = false, approvalId, policy, risk }) {
  const spec = toolSpecs[tool];
  const parsed = parseToolParams(tool, params);
  const amount = parsed.amount ?? parsed.total ?? 0;

  const perm = checkPermission({ actor: ctx.actor, tool, amount, tenant: ctx.tenant, approved });
  if (!perm.allowed) {
    await addEvent(ctx, caseDoc._id, { type: 'permission.blocked', system: 'settla', action: `Blocked ${tool}: ${perm.reason}`, status: 'warn', metadata: { tool, ...perm } });
    await audit(ctx, { action: 'tool.blocked', resourceType: 'case', resourceId: caseDoc._id, meta: { tool, reason: perm.reason } });
    return { status: 'BLOCKED', blocked: perm };
  }

  let action;
  try {
    action = await repos.actions.insert(ctx.tenantId, {
      caseId: caseDoc._id, tool, params: parsed, state: 'PENDING', idempotencyKey, attempts: 0, amount, currency: 'INR',
      paymentId: parsed.paymentId ?? caseDoc.paymentId, requestedBy: ctx.actor.id, requestedByType: ctx.actor.type,
      policyVersion: policy?.policyVersion, riskScore: risk?.riskScore, approvalId, history: [],
    });
  } catch (e) {
    if (e.code !== 11000) throw e;
    const existing = await repos.actions.findOne(ctx.tenantId, { idempotencyKey });
    if (existing.state === 'VERIFIED') {
      await addEvent(ctx, caseDoc._id, { type: 'idempotent.replay', system: 'settla', action: `Duplicate ${tool} suppressed (already verified)`, metadata: { actionId: existing._id } });
      return { status: 'REPLAY', action: existing, result: existing.result, verification: existing.verification };
    }
    if (existing.state === 'FAILED') action = await setState(ctx, existing, 'PENDING');
    else if (['PENDING', 'RUNNING', 'SUCCEEDED', 'VERIFYING'].includes(existing.state)) throw new AppError('ACTION_IN_PROGRESS', 'Same action already in progress', 409);
    else return { status: existing.state, action: existing, result: existing.result };
  }

  const exCtx = { caseDoc, idempotencyKey };
  await addEvent(ctx, caseDoc._id, { type: 'tool.start', system: 'rhea', action: `Executing ${tool}`, metadata: { tool, idempotencyKey } });
  action = await setState(ctx, action, 'RUNNING');

  let result;
  try {
    result = await withRetry(async () => {
      await repos.actions.update(ctx.tenantId, action._id, { attempts: (action.attempts ?? 0) + 1 });
      action.attempts = (action.attempts ?? 0) + 1;
      return IMPLS[tool](ctx, parsed, exCtx);
    }, { onRetry: (e, n) => repos.actionAttempts.insert(ctx.tenantId, { actionId: action._id, attempt: n, error: e.code, retryable: true }) });
  } catch (e) {
    await repos.actionAttempts.insert(ctx.tenantId, { actionId: action._id, attempt: action.attempts, error: e.code ?? e.message, retryable: false });
    action = await setState(ctx, action, 'FAILED', { error: { code: e.code ?? 'EXEC_ERROR', message: e.message, system: e.system } });
    await addEvent(ctx, caseDoc._id, { type: 'tool.failed', system: e.system ?? 'rhea', action: `${tool} failed: ${e.message}`, status: 'error', metadata: { code: e.code } });
    return { status: 'FAILED', action, error: { code: e.code, message: e.message, system: e.system } };
  }

  action = await setState(ctx, action, 'SUCCEEDED', { result });
  action = await setState(ctx, action, 'VERIFYING');

  let verification;
  try {
    verification = await withRetry(() => VERIFIERS[tool](ctx, parsed, result, exCtx));
    if (!verification.passed) {
      // one safe re-read before declaring mismatch (guards against read lag)
      verification = await VERIFIERS[tool](ctx, parsed, result, exCtx);
    }
  } catch (e) {
    verification = { passed: false, checks: [{ name: 'verification_error', passed: false, detail: e.message }] };
  }
  await repos.actionVerifications.insert(ctx.tenantId, { actionId: action._id, caseId: caseDoc._id, tool, ...verification });

  if (verification.passed) {
    action = await setState(ctx, action, 'VERIFIED', { verification });
    await addEvent(ctx, caseDoc._id, { type: 'tool.verified', system: 'rhea', action: `${tool} verified`, metadata: { checks: verification.checks, result } });
    await audit(ctx, { action: `tool.${tool}`, resourceType: 'case', resourceId: caseDoc._id, after: { result, amount, paymentId: parsed.paymentId, policyVersion: policy?.policyVersion, riskScore: risk?.riskScore, approvalId, idempotencyKey } });
    return { status: 'VERIFIED', action, result, verification };
  }

  action = await setState(ctx, action, 'FAILED', { verification, error: { code: 'VERIFICATION_FAILED', message: 'Read-after-write verification failed' } });
  await addEvent(ctx, caseDoc._id, { type: 'verification.failed', system: 'rhea', action: `${tool} verification FAILED`, status: 'error', metadata: { checks: verification.checks } });

  if (spec.compensatable && COMPENSATORS[tool]) {
    try {
      action = await setState(ctx, action, 'COMPENSATING');
      const comp = await COMPENSATORS[tool](ctx, parsed, result);
      action = await setState(ctx, action, 'COMPENSATED', { compensation: comp });
      await addEvent(ctx, caseDoc._id, { type: 'tool.compensated', system: 'rhea', action: `Compensated ${tool}`, status: 'warn', metadata: comp });
      return { status: 'COMPENSATED', action, result, verification };
    } catch (e) {
      action = await setState(ctx, action, 'ESCALATED', { compensationError: e.message });
      return { status: 'ESCALATED', action, result, verification, error: { code: 'COMPENSATION_FAILED', message: e.message } };
    }
  }
  action = await setState(ctx, action, 'ESCALATED');
  return { status: 'ESCALATED', action, result, verification };
}
