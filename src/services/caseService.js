import { col, C } from '../db/mongo.js';
import { repos } from '../repositories/index.js';
import { page } from '../repositories/base.js';
import { caseMachine } from '../domain/stateMachines.js';
import { AppError, notFound } from '../lib/errors.js';
import { bus } from '../events/bus.js';
import { audit } from './auditService.js';

export async function nextCaseNumber(tenantId) {
  const t = await col(C.tenants).findOneAndUpdate({ _id: tenantId }, { $inc: { caseCounter: 1 } }, { returnDocument: 'after' });
  return `CASE-${20900 + (t?.caseCounter ?? 1)}`;
}

export async function addEvent(ctx, caseId, { type, system, actor, action, status = 'ok', metadata = {} }) {
  const ev = await repos.caseEvents.insert(ctx.tenantId, {
    caseId, ts: ctx.clock.now(), type, system, actor: actor ?? ctx.actor.id, action, status, metadata, traceId: ctx.traceId,
  });
  bus.publish(ctx.tenantId, { type: 'case.event', caseId, event: ev });
  return ev;
}

export async function createCase(ctx, input) {
  const caseNumber = await nextCaseNumber(ctx.tenantId);
  const doc = await repos.cases.insert(ctx.tenantId, {
    caseNumber,
    status: 'NEW',
    channel: input.channel ?? 'api',
    paymentId: input.paymentId,
    customerId: input.customerId,
    customerName: input.customerName,
    customerEmail: input.customerEmail,
    customerPhone: input.customerPhone,
    ticketId: input.ticketId,
    customerMessage: input.customerMessage,
    amount: input.amount ?? 0,
    currency: 'INR',
    gateway: 'razorpay',
    risk: null,
    confidence: null,
    decision: null,
    autonomous: null,
    demo: !!input.demo,
    simulated: !!input.simulated,
    traceId: ctx.traceId,
    executionModeAtCreation: ctx.tenant.executionMode,
    followUpsPending: [],
    createdAt: ctx.clock.now(),
  });
  await audit(ctx, { action: 'case.create', resourceType: 'case', resourceId: doc._id, after: { caseNumber } });
  bus.publish(ctx.tenantId, { type: 'case.created', caseId: doc._id, caseNumber });
  return doc;
}

/** Only entry point for status changes. Validates the edge, applies it atomically, records it. */
export async function transition(ctx, caseId, to, reason, metadata = {}) {
  const current = await repos.cases.findById(ctx.tenantId, caseId);
  if (!current) throw notFound('Case not found', 'CASE_NOT_FOUND');
  caseMachine.assert(current.status, to);
  const patch = { status: to };
  if (['RESOLVED', 'REFUNDED', 'CLOSED'].includes(to) && !current.resolvedAt && to !== 'CLOSED') {
    patch.resolvedAt = ctx.clock.now();
    patch.resolutionMs = patch.resolvedAt.getTime() - new Date(current.createdAt).getTime();
  }
  const updated = await repos.cases.updateWhere(ctx.tenantId, { _id: caseId, status: current.status }, patch);
  if (!updated) throw new AppError('CASE_CONCURRENT_UPDATE', 'Case changed concurrently', 409);
  await repos.caseTransitions.insert(ctx.tenantId, {
    caseId, fromState: current.status, toState: to, actor: ctx.actor.id, actorType: ctx.actor.type, reason, metadata, ts: ctx.clock.now(),
  });
  bus.publish(ctx.tenantId, { type: 'case.transition', caseId, from: current.status, to, reason });
  return updated;
}

export const patchCase = (ctx, caseId, set) => repos.cases.update(ctx.tenantId, caseId, set);

export async function getCaseDetail(tenantId, caseId) {
  const c = await repos.cases.findById(tenantId, caseId);
  if (!c) throw notFound('Case not found', 'CASE_NOT_FOUND');
  const [events, transitions, decisions, traces, actions, approvals, escalations, messages, audits, customer, payment, orders] = await Promise.all([
    repos.caseEvents.find(tenantId, { caseId }, { sort: { ts: 1 }, limit: 200 }),
    repos.caseTransitions.find(tenantId, { caseId }, { sort: { ts: 1 }, limit: 200 }),
    repos.decisions.find(tenantId, { caseId }, { sort: { createdAt: -1 }, limit: 10 }),
    repos.decisionTraces.find(tenantId, { caseId }, { sort: { createdAt: -1 }, limit: 10 }),
    repos.actions.find(tenantId, { caseId }, { sort: { createdAt: 1 }, limit: 50 }),
    repos.approvals.find(tenantId, { caseId }, { sort: { createdAt: -1 }, limit: 20 }),
    repos.escalations.find(tenantId, { caseId }, { sort: { createdAt: -1 }, limit: 10 }),
    repos.messages.find(tenantId, { caseId }, { sort: { createdAt: 1 }, limit: 100 }),
    repos.auditLogs.find(tenantId, { resourceType: 'case', resourceId: caseId }, { limit: 100 }),
    c.customerId ? repos.customers.findById(tenantId, c.customerId) : null,
    c.paymentId ? repos.payments.findOne(tenantId, { gatewayPaymentId: c.paymentId }) : null,
    c.paymentId ? repos.orders.find(tenantId, { paymentRef: c.paymentId }, { limit: 5 }) : [],
  ]);
  let cart = await repos.cartSnapshots.find(tenantId, { caseId }, { limit: 1 }); // this case's own cart first
  if (!cart.length && c.customerId) cart = await repos.cartSnapshots.find(tenantId, { customerId: c.customerId }, { limit: 1 });
  return { case: c, events, transitions, decisions, traces, actions, approvals, escalations, messages, audit: audits, customer, payment, orders, cart: cart[0] ?? null };
}

const SORTABLE = new Set(['createdAt', 'amount', 'status', 'resolutionMs', 'confidence']);
export function listCases(tenantId, q = {}) {
  const filter = {};
  if (q.status) filter.status = { $in: String(q.status).split(',').filter(Boolean) };
  if (q.risk) filter['risk.level'] = String(q.risk);
  if (q.autonomous !== undefined && q.autonomous !== '') filter.autonomous = q.autonomous === 'true';
  if (q.customerId) filter.customerId = String(q.customerId);
  if (q.search) {
    const s = String(q.search).slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = ['caseNumber', 'customerName', 'paymentId', 'customerEmail'].map((f) => ({ [f]: { $regex: s, $options: 'i' } }));
  }
  const sortKey = SORTABLE.has(q.sort) ? q.sort : 'createdAt';
  return page(repos.cases, tenantId, filter, { page: q.page, pageSize: q.pageSize, sort: { [sortKey]: q.order === 'asc' ? 1 : -1 } });
}
