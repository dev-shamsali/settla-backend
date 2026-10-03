import { repos } from '../repositories/index.js';
import { page } from '../repositories/base.js';
import { AppError, notFound, forbidden } from '../lib/errors.js';
import { audit } from './auditService.js';
import { transition, addEvent, patchCase } from './caseService.js';
import { execute } from '../agents/rhea.js';
import { evaluatePolicy } from '../policies/policyEngine.js';
import { createEscalation } from './escalationService.js';
import { checkPermission } from '../policies/permissionEngine.js';

export const listApprovals = (tenantId, q = {}) => page(repos.approvals, tenantId, q.status ? { status: String(q.status) } : {}, q);

/**
 * Human decision on a pending approval. The approver must hold approvals:approve AND the
 * underlying tool permission (e.g. payments:refund). Amount is re-derived from the gateway.
 */
export async function decideApproval(ctx, approvalId, { decision, note, editedAmount }) {
  const approval = await repos.approvals.findById(ctx.tenantId, approvalId);
  if (!approval) throw notFound('Approval not found', 'APPROVAL_NOT_FOUND');
  if (approval.status !== 'PENDING') throw new AppError('APPROVAL_NOT_PENDING', `Approval already ${approval.status}`, 409);
  if (approval.requestedBy === ctx.actor.id && ctx.actor.type === 'user') throw forbidden('Requester cannot approve own request', 'SELF_APPROVAL');
  const c = await repos.cases.findById(ctx.tenantId, approval.caseId);
  if (decision === 'approve') {
    const p = checkPermission({ actor: ctx.actor, tool: approval.action, amount: approval.amount, tenant: ctx.tenant, approved: true });
    if (!p.allowed) throw forbidden(`Approver cannot authorise this action: ${p.reason}`, 'APPROVER_LACKS_PERMISSION');
  }

  const claimed = await repos.approvals.updateWhere(ctx.tenantId, { _id: approvalId, status: 'PENDING' }, {
    status: decision === 'approve' ? 'APPROVED' : 'REJECTED', decidedBy: ctx.actor.id, decidedAt: ctx.clock.now(), note,
  });
  if (!claimed) throw new AppError('APPROVAL_NOT_PENDING', 'Approval already decided', 409);
  await audit(ctx, { action: `approval.${decision}`, resourceType: 'approval', resourceId: approvalId, before: { status: 'PENDING' }, after: { status: claimed.status, note } });

  if (decision === 'reject') {
    await transition(ctx, c._id, 'CLOSED', `approval rejected by ${ctx.actor.id}`);
    await addEvent(ctx, c._id, { type: 'approval.rejected', system: 'settla', actor: ctx.actor.id, action: 'Approval rejected', status: 'warn' });
    return { approval: claimed, outcome: 'REJECTED' };
  }

  const plan = { ...approval.plan, decisionId: approval.decisionId };
  if (editedAmount !== undefined && plan.tool === 'refund_payment') {
    if (!(editedAmount > 0) || editedAmount > approval.amount) throw new AppError('INVALID_EDIT', 'Edited amount must be >0 and ≤ requested', 400);
    plan.amount = editedAmount;
    plan.parameters = { ...plan.parameters, amount: editedAmount };
    plan.idempotency_key = `${plan.idempotency_key}-e${editedAmount}`;
  }
  await addEvent(ctx, c._id, { type: 'approval.approved', system: 'settla', actor: ctx.actor.id, action: `Approved by ${ctx.actor.id}`, metadata: { approvalId, note } });
  const policy = plan.decision === 'REFUND' ? evaluatePolicy('refund-v1', {
    payment: { status: 'captured', amount: plan.amount, amountRefunded: 0 }, refundAmount: plan.amount, signals: {}, limits: { autoExecuteInr: Number.POSITIVE_INFINITY },
  }) : null;
  // approver acts: their own permissions gate the tool (RBAC), approval lifts the amount limit
  const result = await execute(ctx, c, plan, policy, approval.risk ? { riskScore: approval.risk.score, riskLevel: approval.risk.level } : undefined, { approved: true, approvalId, payment: { id: approval.paymentId } });
  return { approval: claimed, outcome: result.status, result };
}

export async function escalationAction(ctx, escalationId, { action, note, amount }) {
  const esc = await repos.escalations.findById(ctx.tenantId, escalationId);
  if (!esc) throw notFound('Escalation not found', 'ESCALATION_NOT_FOUND');
  const c = await repos.cases.findById(ctx.tenantId, esc.caseId);
  await audit(ctx, { action: `escalation.${action}`, resourceType: 'escalation', resourceId: escalationId, meta: { note } });

  if (action === 'take_over') {
    await repos.escalations.update(ctx.tenantId, escalationId, { assignedTo: ctx.actor.id, status: 'IN_PROGRESS' });
    await patchCase(ctx, c._id, { assignedTo: ctx.actor.id });
    await addEvent(ctx, c._id, { type: 'escalation.taken_over', system: 'settla', actor: ctx.actor.id, action: `Taken over by ${ctx.actor.id}` });
    return { status: 'IN_PROGRESS' };
  }
  if (action === 'close') {
    await repos.escalations.update(ctx.tenantId, escalationId, { status: 'CLOSED', resolution: note, closedBy: ctx.actor.id });
    if (c.status === 'ESCALATED') await transition(ctx, c._id, 'CLOSED', `closed by ${ctx.actor.id}: ${note ?? ''}`);
    return { status: 'CLOSED' };
  }
  if (action === 'refund') {
    const payment = await repos.payments.findOne(ctx.tenantId, { gatewayPaymentId: c.paymentId });
    const live = await ctx.adapters.payments.getPayment(c.paymentId);
    const amt = amount ?? live.amount - (live.amountRefunded ?? 0);
    const plan = {
      decision: 'REFUND', tool: 'refund_payment', amount: amt, parameters: { paymentId: c.paymentId, amount: amt, reason: note ?? 'manual_refund' },
      idempotency_key: `manual-${esc._id}-${amt}`, evidence: esc.caseFile?.evidence ?? [], required_permission: 'payments:refund',
    };
    const r = await execute(ctx, c, plan, null, c.risk ? { riskScore: c.risk.score, riskLevel: c.risk.level } : undefined, { approved: true, payment });
    if (r.status === 'REFUNDED') await repos.escalations.update(ctx.tenantId, escalationId, { status: 'RESOLVED', resolution: 'manual refund', closedBy: ctx.actor.id });
    return r;
  }
  if (action === 'retry') {
    // re-enter decision loop from the escalated state; investigation is not restarted from scratch
    await repos.escalations.update(ctx.tenantId, escalationId, { status: 'IN_PROGRESS', retriedBy: ctx.actor.id });
    await transition(ctx, c._id, 'DECIDING', `retry by ${ctx.actor.id}`);
    return { status: 'DECIDING' };
  }
  throw new AppError('UNKNOWN_ACTION', `Unsupported escalation action ${action}`, 400);
}

export { createEscalation };
