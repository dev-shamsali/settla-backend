import { repos } from '../repositories/index.js';
import { proposePlan } from './planner.js';
import { enforceHardRules } from './hardRules.js';
import { evaluatePolicy } from '../policies/policyEngine.js';
import { assessRisk } from '../policies/riskEngine.js';
import { checkPermission } from '../policies/permissionEngine.js';
import { runTool, withRetry } from '../tools/executor.js';
import { transition, addEvent, patchCase } from '../services/caseService.js';
import { createEscalation } from '../services/escalationService.js';
import { notify } from '../services/notificationService.js';
import { audit } from '../services/auditService.js';
import { analyzeUntrusted } from '../security/untrusted.js';
import { sha256 } from '../lib/crypto.js';
import { AUTO_REFUND_LIMIT_INR } from '../config/env.js';
import { enqueue } from '../queues/index.js';
import { caseMachine } from '../domain/stateMachines.js';
import { agentActor } from '../lib/context.js';

/** Simulated-clock step sizes: the demo timeline sums to exactly 27s. */
const STEP_MS = { customer: 2000, payment: 2000, order: 2000, cart: 2000, policy: 2000, execute: 3000, verified: 3000, notified: 3000, ticket: 4000, outcome: 4000 };

const step = async (ctx, caseId, key, ev) => {
  ctx.clock.advance(STEP_MS[key] ?? 0);
  return addEvent(ctx, caseId, ev);
};

const cartHash = (items) => sha256(JSON.stringify([...items].sort((a, b) => a.sku.localeCompare(b.sku)).map((i) => [i.sku, i.qty, i.price])));

class EscalateSignal extends Error {
  constructor(reason, detail) { super(reason); this.reason = reason; this.detail = detail; }
}

async function lookup(ctx, caseId, label, fn) {
  try {
    return await withRetry(fn, { onRetry: (e, n) => addEvent(ctx, caseId, { type: 'integration.retry', system: e.system, action: `${label}: retry ${n} (${e.code})`, status: 'warn' }) });
  } catch (e) {
    await addEvent(ctx, caseId, { type: 'integration.failed', system: e.system ?? 'integration', action: `${label} failed: ${e.message}`, status: 'error', metadata: { code: e.code } });
    throw new EscalateSignal('integration_failure', `${label}: ${e.message}`);
  }
}

/** Gather authoritative evidence from every system of record. */
async function investigate(ctx, c) {
  const a = ctx.adapters;
  const payment = await lookup(ctx, c._id, 'Razorpay payment lookup', () => a.payments.getPayment(c.paymentId));
  if (!payment) throw new EscalateSignal('payment_not_found', c.paymentId);

  const customer = await lookup(ctx, c._id, 'HubSpot customer lookup', () => a.crm.findCustomer({ email: c.customerEmail ?? payment.email, phone: c.customerPhone ?? payment.contact }))
    .catch((e) => { if (e instanceof EscalateSignal) return null; throw e; });
  const crmCtx = customer ? await a.crm.getContext(customer.id).catch(() => null) : null;
  const email = c.customerEmail ?? payment.email;
  const localCustomer = await repos.customers.upsert(ctx.tenantId, { email }, {
    name: customer?.name ?? c.customerName ?? 'Unknown', phone: customer?.phone ?? payment.contact, crmId: customer?.id, blocked: !!customer?.blocked,
    refundCount: crmCtx?.refundCount ?? 0, paymentsLast24h: crmCtx?.paymentsLast24h ?? 1, demo: !!c.demo,
  });
  await step(ctx, c._id, 'customer', { type: 'customer.identified', system: 'hubspot', action: `Customer identified: ${localCustomer.name}`, metadata: { customerId: localCustomer._id } });

  await repos.payments.upsert(ctx.tenantId, { gatewayPaymentId: payment.id }, {
    status: payment.status, amount: payment.amount, currency: payment.currency ?? 'INR', amountRefunded: payment.amountRefunded ?? 0,
    customerId: localCustomer._id, email, gateway: 'razorpay', demo: !!c.demo,
  });
  await step(ctx, c._id, 'payment', { type: 'payment.found', system: 'razorpay', action: `Razorpay payment ${payment.id} found (${payment.status}, ₹${payment.amount})`, metadata: { status: payment.status, amount: payment.amount } });

  const existingOrder = await lookup(ctx, c._id, 'Shopify order lookup', () => a.orders.findOrderByPaymentRef(payment.id));
  const recentOrders = await lookup(ctx, c._id, 'Shopify customer orders', () => a.orders.findOrdersByCustomer(email));
  await step(ctx, c._id, 'order', { type: 'order.lookup', system: 'shopify', action: existingOrder ? `Shopify order ${existingOrder.orderNumber} found` : 'No Shopify order found', metadata: { found: !!existingOrder } });
  if (existingOrder) await repos.orders.upsert(ctx.tenantId, { orderNumber: existingOrder.orderNumber }, { paymentRef: payment.id, total: existingOrder.total, status: existingOrder.status, customerId: localCustomer._id });

  const cart = payment.cart ?? null;
  let cartSnap = cart && { items: cart.items, total: cart.total, hash: cartHash(cart.items) };
  if (!cartSnap) {
    const snap = (await repos.cartSnapshots.find(ctx.tenantId, { customerId: localCustomer._id }, { limit: 1 }))[0];
    if (snap) cartSnap = { items: snap.items, total: snap.total, hash: snap.hash };
  } else {
    await repos.cartSnapshots.upsert(ctx.tenantId, { caseId: c._id, customerId: localCustomer._id, hash: cartSnap.hash }, { items: cartSnap.items, total: cartSnap.total });
  }
  const inventory = cartSnap ? await lookup(ctx, c._id, 'Shopify inventory', () => a.orders.getInventory(cartSnap.items.map((i) => i.sku))) : {};
  const cartMatchesPayment = !!cartSnap && cartSnap.total === payment.amount;
  const stockAvailable = !!cartSnap && cartSnap.items.every((i) => (inventory[i.sku] ?? 0) >= i.qty);
  if (cartSnap) await step(ctx, c._id, 'cart', { type: 'cart.matched', system: 'shopify', action: cartMatchesPayment ? 'Cart matched payment' : 'Cart does NOT match payment', status: cartMatchesPayment ? 'ok' : 'warn', metadata: { cartTotal: cartSnap.total, inventory } });

  const ticket = c.ticketId ? await lookup(ctx, c._id, 'Freshdesk ticket lookup', () => a.ticketing.findTicket(c.ticketId)).catch((e) => { if (e instanceof EscalateSignal) return null; throw e; }) : null;

  // duplicate payment: another captured payment, same amount, that already has the order
  let duplicatePayment = false;
  const others = (await lookup(ctx, c._id, 'Razorpay customer payments', () => a.payments.listPayments({ email })))
    .filter((p) => p.id !== payment.id && p.status === 'captured' && p.amount === payment.amount);
  for (const o of others) {
    const ord = await a.orders.findOrderByPaymentRef(o.id);
    if (ord && !existingOrder) { duplicatePayment = true; break; }
  }

  const text = analyzeUntrusted([c.customerMessage, ticket?.subject, ticket?.description].filter(Boolean).join('\n'));
  const signals = {
    injection: text.injectionDetected, requestsHuman: text.requestsHuman, chargeback: text.chargebackLanguage, legal: text.legalLanguage, hostile: text.hostile,
    fraud: !!customer?.fraudFlag, duplicatePayment,
    systemsDisagree: (!!existingOrder && payment.status !== 'captured') || (ticket?.claimedAmount !== undefined && ticket?.claimedAmount !== null && ticket.claimedAmount !== payment.amount),
  };
  return { payment, existingOrder, recentOrders, cart: cartSnap, inventory, cartMatchesPayment, stockAvailable, customer: { ...localCustomer, ...(crmCtx ?? {}) }, localCustomer, ticket, signals, injectionSignals: text.injectionSignals };
}

function policyContext(ev, plan, tenant) {
  return {
    payment: ev.payment, existingOrder: ev.existingOrder, recentOrders: ev.recentOrders, cart: ev.cart, inventory: ev.inventory,
    customer: ev.customer, signals: ev.signals, refundAmount: plan.amount, limits: { autoExecuteInr: tenant.limits?.autoExecuteInr ?? AUTO_REFUND_LIMIT_INR },
  };
}

async function persistDecision(ctx, c, ev, rawPlan, plan, overrides, policy, risk, source, outcome) {
  const decision = await repos.decisions.insert(ctx.tenantId, {
    caseId: c._id, plan, proposedPlan: rawPlan, overrides, source, policyEvaluation: policy, riskAssessment: risk, outcome,
  });
  await repos.policyEvaluations.insert(ctx.tenantId, { caseId: c._id, decisionId: decision._id, ...(policy ?? { policy: 'none', passed: true, evaluatedRules: [] }) });
  await repos.riskAssessments.insert(ctx.tenantId, { caseId: c._id, decisionId: decision._id, ...risk });
  await repos.decisionTraces.insert(ctx.tenantId, {
    caseId: c._id, caseNumber: c.caseNumber, decisionId: decision._id,
    proposal: plan.decision, paymentId: ev.payment?.id, amount: plan.amount, rules: (policy?.evaluatedRules ?? []).map((r) => ({ id: r.id, passed: r.passed })),
    policy: policy ? `${policy.policy}` : 'none', risk: `${risk.riskScore} ${risk.riskLevel}`, permission: plan.required_permission,
    idempotency: plan.idempotency_key ? 'generated' : 'none', execution: plan.tool, verification: 'PENDING', final: 'PENDING', overrides,
  });
  return decision;
}

const finalizeTrace = (ctx, caseId, patch) =>
  repos.decisionTraces.raw().updateOne({ tenantId: ctx.tenantId, caseId }, { $set: patch }, { sort: { createdAt: -1 } });

/** Main autonomous loop. Safe to call once per case; every step is validated and recorded. */
export async function processCase(ctx, caseId) {
  let c = await repos.cases.findById(ctx.tenantId, caseId);
  try {
    if (ctx.tenant.executionMode === 'DISABLED') {
      await transition(ctx, caseId, 'OBSERVING', 'received');
      throw new EscalateSignal('automation_disabled', 'Tenant execution mode is DISABLED');
    }
    await addEvent(ctx, caseId, { type: 'message.received', system: c.channel, action: `${c.channel} message received`, metadata: { ticketId: c.ticketId } });
    await transition(ctx, caseId, 'OBSERVING', 'new payment/order mismatch observed');
    await transition(ctx, caseId, 'INVESTIGATING', 'gathering evidence');
    const ev = await investigate(ctx, c);
    c = await patchCase(ctx, caseId, { customerId: ev.localCustomer._id, crmId: ev.localCustomer.crmId, customerName: ev.localCustomer.name, amount: ev.payment.amount });

    await transition(ctx, caseId, 'DECIDING', 'evidence complete');
    const evidence = {
      caseId, payment: ev.payment, existingOrder: ev.existingOrder ? { orderNumber: ev.existingOrder.orderNumber } : null, cart: ev.cart,
      cartMatchesPayment: ev.cartMatchesPayment, stockAvailable: ev.stockAvailable, signals: ev.signals, forceConfidence: ctx.forceConfidence, __simulate: ctx.simulateLlm,
    };
    const proposal = await proposePlan({ evidence, customerText: c.customerMessage ?? '', provider: ctx.llmProvider });
    if (!proposal.ok) {
      await addEvent(ctx, caseId, { type: 'ai.plan_rejected', system: 'rhea', action: `AI plan rejected: ${proposal.errors[0]}`, status: 'error', metadata: { errors: proposal.errors } });
      await audit(ctx, { action: 'ai.plan_rejected', resourceType: 'case', resourceId: caseId, meta: { errors: proposal.errors } });
      throw new EscalateSignal('invalid_ai_plan', proposal.errors.join('; '));
    }
    const { plan, overrides } = enforceHardRules(proposal.plan, { ...ev, tenantId: ctx.tenantId, caseId });
    const risk = assessRisk({ amount: plan.amount, payment: ev.payment, customer: ev.customer, signals: ev.signals });
    plan.risk = risk.riskLevel;
    const policy = plan.decision === 'RECOVER_ORDER' ? evaluatePolicy('recover-order-v2', policyContext(ev, plan, ctx.tenant))
      : plan.decision === 'REFUND' ? evaluatePolicy('refund-v1', policyContext(ev, plan, ctx.tenant)) : null;
    const decision = await persistDecision(ctx, c, ev, proposal.plan, plan, overrides, policy, risk, proposal.source);
    c = await patchCase(ctx, caseId, { decision: plan.decision, confidence: plan.confidence, risk: { score: risk.riskScore, level: risk.riskLevel }, decisionId: decision._id, policyId: policy?.policy });
    await step(ctx, caseId, 'policy', {
      type: 'policy.evaluated', system: 'settla', action: policy ? `Policy ${policy.policy}: ${policy.passed ? 'passed' : policy.reason} · risk ${risk.riskScore} ${risk.riskLevel}` : `Decision ${plan.decision} · risk ${risk.riskScore} ${risk.riskLevel}`,
      status: policy && !policy.passed && !policy.requiresApproval ? 'warn' : 'ok', metadata: { plan: { decision: plan.decision, confidence: plan.confidence }, policy, risk },
    });
    if (overrides.length) await addEvent(ctx, caseId, { type: 'hardrules.override', system: 'settla', action: `Hard rules overrode AI proposal: ${overrides.join(', ')}`, status: 'warn', metadata: { overrides } });

    if (plan.decision === 'ESCALATE') throw new EscalateSignal(plan.escalation_reason ?? 'ai_escalation', plan.evidence.join(' | '));
    if (policy && !policy.passed && !policy.requiresApproval) throw new EscalateSignal(`policy_failed:${policy.failedRules.join(',')}`, policy.reason);

    const perm = checkPermission({ actor: ctx.actor, tool: plan.tool, amount: plan.amount, tenant: ctx.tenant });
    if (perm.recommendOnly) {
      await addEvent(ctx, caseId, { type: 'recommend_only', system: 'settla', action: `RECOMMEND_ONLY: Rhea recommends ${plan.decision} (not executed)`, status: 'warn', metadata: { plan } });
      throw new EscalateSignal('recommend_only_mode', `Recommended: ${plan.decision}`);
    }
    if (perm.requiresApproval || policy?.requiresApproval) {
      const approval = await requestApproval(ctx, c, plan, policy, risk, decision._id, ev.payment);
      return { status: 'AWAITING_APPROVAL', approvalId: approval._id };
    }
    if (!perm.allowed) throw new EscalateSignal('permission_denied', perm.reason);

    return await execute(ctx, c, plan, policy, risk, { payment: ev.payment, customer: ev.localCustomer, ticket: ev.ticket });
  } catch (e) {
    if (e instanceof EscalateSignal) {
      c = await repos.cases.findById(ctx.tenantId, caseId);
      await createEscalation(ctx, c, { reason: e.reason, detail: e.detail });
      await finalizeTrace(ctx, caseId, { final: 'ESCALATED', escalationReason: e.reason });
      return { status: 'ESCALATED', reason: e.reason };
    }
    await addEvent(ctx, caseId, { type: 'system.error', system: 'rhea', action: `Unexpected error: ${e.message}`, status: 'error' });
    c = await repos.cases.findById(ctx.tenantId, caseId);
    if (caseMachine.canTransition(c.status, 'FAILED')) await transition(ctx, caseId, 'FAILED', e.message);
    await notify(ctx, { kind: 'case_failed', title: `Case failed: ${c.caseNumber}`, body: e.message, severity: 'error', caseId });
    throw e;
  }
}

export async function requestApproval(ctx, c, plan, policy, risk, decisionId, payment) {
  const approval = await repos.approvals.insert(ctx.tenantId, {
    caseId: c._id, caseNumber: c.caseNumber, status: 'PENDING', action: plan.tool, decision: plan.decision, amount: plan.amount, currency: 'INR',
    paymentId: payment?.id ?? c.paymentId, customerName: c.customerName, reason: plan.escalation_reason ?? plan.reasoning_summary ?? plan.decision,
    risk: { score: risk.riskScore, level: risk.riskLevel }, policy: policy ? { policy: policy.policy, version: policy.policyVersion, reason: policy.reason } : null,
    evidence: plan.evidence, plan, decisionId, requestedBy: ctx.actor.id, requestedAt: ctx.clock.now(),
  });
  await transition(ctx, c._id, 'AWAITING_APPROVAL', 'approval required', { approvalId: approval._id });
  await patchCase(ctx, c._id, { autonomous: false, approvalId: approval._id });
  await addEvent(ctx, c._id, { type: 'approval.requested', system: 'settla', action: `Approval required: ${plan.tool} ₹${plan.amount}`, status: 'warn', metadata: { approvalId: approval._id } });
  await notify(ctx, { kind: 'approval', title: `Approval required: ${c.caseNumber}`, body: `${plan.tool} ₹${plan.amount}`, severity: 'warning', caseId: c._id, link: '/approvals' });
  await finalizeTrace(ctx, c._id, { final: 'AWAITING_APPROVAL' });
  return approval;
}

/** Act -> verify -> follow up. Used for autonomous runs and for approved/human-driven runs. */
export async function execute(ctx, c, plan, policy, risk, extra = {}) {
  const fresh = await repos.cases.findById(ctx.tenantId, c._id);
  if (plan.tool === 'wait_for_reversal') {
    const r = await runTool(ctx, { caseDoc: fresh, tool: 'wait_for_reversal', params: { paymentId: plan.parameters?.paymentId ?? fresh.paymentId, recheckAfterHours: 24 }, idempotencyKey: plan.idempotency_key, policy, risk, plan });
    if (r.status !== 'VERIFIED' && r.status !== 'REPLAY') return failure(ctx, fresh, r, plan);
    await transition(ctx, c._id, 'WAITING_REVERSAL', 'waiting for gateway auto-reversal');
    await patchCase(ctx, c._id, { autonomous: true });
    await enqueue('retry', 'reversal-recheck', { tenantId: ctx.tenantId, caseId: c._id }, { delay: 24 * 3600 * 1000 });
    await followUps(ctx, fresh, plan, { template: 'waiting_reversal' });
    await finalizeTrace(ctx, c._id, { verification: 'PASSED', final: 'WAITING_REVERSAL' });
    return { status: 'WAITING_REVERSAL' };
  }

  if (caseMachine.canTransition(fresh.status, 'EXECUTING')) await transition(ctx, c._id, 'EXECUTING', `executing ${plan.tool}`);
  ctx.clock.advance(STEP_MS.execute);
  const r = await runTool(ctx, { caseDoc: fresh, tool: plan.tool, params: plan.parameters, idempotencyKey: plan.idempotency_key, approved: !!extra.approved, approvalId: extra.approvalId, policy, risk, plan });
  if (r.status === 'BLOCKED') {
    if (r.blocked.requiresApproval) { const ap = await requestApproval(ctx, fresh, plan, policy, risk, plan.decisionId, extra.payment); return { status: 'AWAITING_APPROVAL', approvalId: ap._id }; }
    const blockedCase = await repos.cases.findById(ctx.tenantId, c._id);
    await createEscalation(ctx, blockedCase, { reason: 'permission_denied', detail: r.blocked.reason, recommended: plan.decision });
    return { status: 'ESCALATED', reason: 'permission_denied' };
  }
  if (r.status !== 'VERIFIED' && r.status !== 'REPLAY') return failure(ctx, fresh, r, plan);

  await transition(ctx, c._id, 'VERIFYING', 'verifying outcome');
  const refunded = plan.tool === 'refund_payment';
  ctx.clock.advance(STEP_MS.verified);
  await addEvent(ctx, c._id, { type: 'outcome.verified', system: 'rhea', action: refunded ? `Refund ${r.result.refundId} verified` : `Order ${r.result.orderNumber} created and verified`, metadata: { checks: r.verification?.checks } });
  await transition(ctx, c._id, refunded ? 'REFUNDED' : 'RESOLVED', refunded ? 'refund verified' : 'order recovered');
  if (!refunded && r.result.orderNumber) {
    // persist the order we just created and verified, so the case page can show it
    await repos.orders.upsert(ctx.tenantId, { orderNumber: r.result.orderNumber }, { paymentRef: fresh.paymentId, total: r.result.amount, status: 'open', customerId: fresh.customerId, caseId: c._id });
  }
  await patchCase(ctx, c._id, { autonomous: extra.approved ? false : true, orderNumber: r.result.orderNumber, refundId: r.result.refundId });
  await finalizeTrace(ctx, c._id, { verification: 'PASSED', final: refunded ? 'REFUNDED' : 'RESOLVED', execution: plan.tool });

  await followUps(ctx, fresh, plan, { template: refunded ? 'refund_initiated' : 'order_recovered', result: r.result, ticketId: fresh.ticketId });
  await learn(ctx, fresh, plan, r.result);
  return { status: refunded ? 'REFUNDED' : 'RESOLVED', result: r.result };
}

async function failure(ctx, c, r, plan) {
  const reason = r.status === 'FAILED' ? 'action_failed_after_retry' : 'verification_failed';
  await finalizeTrace(ctx, c._id, { verification: 'FAILED', final: 'ESCALATED' });
  const fresh = await repos.cases.findById(ctx.tenantId, c._id);
  await createEscalation(ctx, fresh, { reason, detail: r.error?.message ?? (r.verification?.checks ?? []).filter((x) => !x.passed).map((x) => x.name).join(', '), recommended: plan.decision });
  await notify(ctx, { kind: 'action_failed', title: `Action failed: ${c.caseNumber}`, body: reason, severity: 'error', caseId: c._id });
  return { status: 'ESCALATED', reason };
}

/** Best-effort follow-ups. A failure here never un-resolves the case; it is queued for retry. */
export async function followUps(ctx, c, plan, { template, result, ticketId }) {
  const fresh = await repos.cases.findById(ctx.tenantId, c._id);
  const orderNumber = result?.orderNumber ?? '';
  const jobs = [
    { key: 'notify', tool: 'notify_customer', params: { template, vars: { name: fresh.customerName ?? 'Customer', orderNumber, amount: plan.amount } }, stepKey: 'notified', label: 'Customer notified' },
    ...(ticketId ? [{ key: 'ticket', tool: 'close_ticket', params: { ticketId, note: `Settla/Rhea ${fresh.caseNumber}: ${plan.decision} verified` }, stepKey: 'ticket', label: 'Freshdesk ticket closed' }] : []),
    { key: 'crm', tool: 'update_crm', params: { fields: { lastCaseId: fresh.caseNumber, lastResolutionAt: ctx.clock.now().toISOString() } }, stepKey: 'outcome', label: 'CRM updated' },
  ];
  const pending = [];
  for (const j of jobs) {
    ctx.clock.advance(STEP_MS[j.stepKey]);
    const r = await runTool({ ...ctx, actor: agentActor() }, { caseDoc: fresh, tool: j.tool, params: j.params, idempotencyKey: sha256(`${fresh._id}:${j.tool}:${plan.idempotency_key}`).slice(0, 40) });
    if (r.status === 'VERIFIED' || r.status === 'REPLAY') {
      await addEvent(ctx, c._id, { type: `followup.${j.key}`, system: 'rhea', action: j.label, metadata: { result: r.result } });
      if (j.key === 'notify' && !fresh.firstResponseMs) await patchCase(ctx, c._id, { firstResponseMs: ctx.clock.now().getTime() - new Date(fresh.createdAt).getTime() });
      if (j.key === 'notify') await repos.messages.insert(ctx.tenantId, { caseId: c._id, direction: 'outbound', channel: r.result.channel, template, status: 'sent', createdAt: ctx.clock.now() });
    } else {
      pending.push(j.key);
      await enqueue('retry', 'followup-retry', { tenantId: ctx.tenantId, caseId: c._id, tool: j.tool, params: j.params }, { delay: 60_000 });
      await addEvent(ctx, c._id, { type: 'followup.pending', system: 'rhea', action: `${j.label} pending: will retry (case remains resolved)`, status: 'warn' });
    }
  }
  if (pending.length) await patchCase(ctx, c._id, { followUpsPending: pending });
  return pending;
}

async function learn(ctx, c, plan, result) {
  const done = await repos.cases.findById(ctx.tenantId, c._id);
  const resolutionMs = ctx.clock.now().getTime() - new Date(done.createdAt).getTime();
  await patchCase(ctx, c._id, { resolutionMs });
  await addEvent(ctx, c._id, { type: 'outcome.recorded', system: 'settla', action: plan.tool === 'refund_payment' ? `₹${plan.amount} refunded` : `₹${plan.amount} recovered`, metadata: { resolutionMs } });
  await repos.analyticsEvents.insert(ctx.tenantId, {
    type: plan.tool === 'refund_payment' ? 'revenue.refunded' : 'revenue.recovered', ts: ctx.clock.now(), caseId: c._id, amount: plan.amount, autonomous: done.autonomous,
    resolutionMs, decision: plan.decision, simulated: !!c.simulated, orderNumber: result.orderNumber,
  });
}
