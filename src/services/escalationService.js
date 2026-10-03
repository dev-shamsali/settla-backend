import { repos } from '../repositories/index.js';
import { transition, addEvent, patchCase } from './caseService.js';
import { notify } from './notificationService.js';
import { audit } from './auditService.js';
import { caseMachine } from '../domain/stateMachines.js';
import { logger } from '../lib/logger.js';

/** Complete case file so a human never restarts the investigation. */
export async function buildCaseFile(tenantId, caseDoc) {
  const [decisions, actions, approvals, events] = await Promise.all([
    repos.decisions.find(tenantId, { caseId: caseDoc._id }, { limit: 1 }),
    repos.actions.find(tenantId, { caseId: caseDoc._id }, { sort: { createdAt: 1 } }),
    repos.approvals.find(tenantId, { caseId: caseDoc._id }, { limit: 5 }),
    repos.caseEvents.find(tenantId, { caseId: caseDoc._id }, { sort: { ts: 1 }, limit: 100 }),
  ]);
  const d = decisions[0];
  return {
    caseNumber: caseDoc.caseNumber,
    customer: { id: caseDoc.customerId, name: caseDoc.customerName },
    payment: { id: caseDoc.paymentId, amount: caseDoc.amount, currency: caseDoc.currency },
    evidence: d?.plan?.evidence ?? [],
    reasoningSummary: d?.plan?.reasoning_summary ?? null,
    risk: caseDoc.risk,
    policy: d?.policyEvaluation ? { policy: d.policyEvaluation.policy, version: d.policyEvaluation.policyVersion, passed: d.policyEvaluation.passed, reason: d.policyEvaluation.reason } : null,
    actionsPerformed: actions.filter((a) => ['VERIFIED', 'SUCCEEDED', 'COMPENSATED'].includes(a.state)).map((a) => ({ tool: a.tool, state: a.state })),
    failedActions: actions.filter((a) => ['FAILED', 'ESCALATED'].includes(a.state)).map((a) => ({ tool: a.tool, state: a.state, error: a.error })),
    pendingApprovals: approvals.filter((a) => a.status === 'PENDING').map((a) => a._id),
    recommendedAction: d?.plan?.decision ?? null,
    timelineLength: events.length,
  };
}

export async function createEscalation(ctx, caseDoc, { reason, detail, recommended }) {
  const existing = await repos.escalations.findOne(ctx.tenantId, { caseId: caseDoc._id, status: 'OPEN' });
  if (existing) return existing;

  const caseFile = await buildCaseFile(ctx.tenantId, caseDoc);
  caseFile.reason = reason;
  caseFile.recommendedAction = recommended ?? caseFile.recommendedAction;
  const esc = await repos.escalations.insert(ctx.tenantId, {
    caseId: caseDoc._id, caseNumber: caseDoc.caseNumber, reason, detail, status: 'OPEN', caseFile,
    amount: caseDoc.amount, risk: caseDoc.risk, assignedTo: null, openedAt: ctx.clock.now(),
  });

  if (caseMachine.canTransition(caseDoc.status, 'ESCALATED')) {
    await transition(ctx, caseDoc._id, 'ESCALATED', `escalated: ${reason}`, { escalationId: esc._id });
  }
  await patchCase(ctx, caseDoc._id, { autonomous: false, escalationId: esc._id, escalationReason: reason });
  await addEvent(ctx, caseDoc._id, { type: 'escalation.created', system: 'settla', action: `Escalated to human: ${reason}`, status: 'warn', metadata: { escalationId: esc._id } });

  try {
    const post = await ctx.adapters.escalationChannel.postEscalation({ ...caseFile, amount: caseDoc.amount });
    await addEvent(ctx, caseDoc._id, { type: 'integration.slack', system: 'slack', action: `Posted case file to ${post.channel}`, metadata: { postId: post.id } });
  } catch (e) {
    logger.warn({ err: e.message }, 'slack post failed');
    await addEvent(ctx, caseDoc._id, { type: 'integration.failed', system: 'slack', action: 'Slack escalation post failed (escalation still recorded)', status: 'error', metadata: { code: e.code } });
  }
  await notify(ctx, { kind: 'escalation', title: `Escalation: ${caseDoc.caseNumber}`, body: reason, severity: 'warning', caseId: caseDoc._id, link: `/escalations/${esc._id}` });
  await audit(ctx, { action: 'escalation.create', resourceType: 'escalation', resourceId: esc._id, after: { reason } });
  return esc;
}
