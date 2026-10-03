import { randomUUID } from 'node:crypto';
import { repos } from '../repositories/index.js';
import { AppError, notFound } from '../lib/errors.js';
import { withIdempotency } from './idempotency.js';
import { audit } from './auditService.js';
import { addEvent } from './caseService.js';
import { decideAutomation, proposeAutomation } from '../agents/automationProposal.js';
import { dispatchToN8n } from '../integrations/n8n/client.js';
import { ACTION_SERVICE, WORKFLOW_NAME } from '../integrations/n8n/contract.js';
import { withRetry } from '../tools/executor.js';
import { sha256 } from '../lib/crypto.js';
import { IntegrationError } from '../integrations/errors.js';
import { env } from '../config/env.js';
import { bus } from '../events/bus.js';

export const listRuns = (tenantId, caseId) => repos.automationRuns.find(tenantId, { caseId }, { limit: 50 });

export async function getProposal(ctx, caseId) {
  const c = await repos.cases.findById(ctx.tenantId, caseId);
  if (!c) throw notFound('Case not found', 'CASE_NOT_FOUND');
  const proposal = proposeAutomation(c, ctx.tenant);
  const decision = await evaluate(ctx, c, proposal);
  return { proposal, backendDecision: publicDecision(decision) };
}

async function evaluate(ctx, c, proposal) {
  const [payment, customer, approved] = await Promise.all([
    repos.payments.findOne(ctx.tenantId, { gatewayPaymentId: c.paymentId }),
    c.customerId ? repos.customers.findById(ctx.tenantId, c.customerId) : null,
    repos.approvals.findOne(ctx.tenantId, { caseId: c._id, status: 'APPROVED' }),
  ]);
  return decideAutomation({ proposal, caseDoc: c, tenant: ctx.tenant, actor: ctx.actor, payment, customer, approvedApproval: approved });
}

const publicDecision = (d) => ({ allowed: d.allowed, code: d.code, reasons: d.reasons, backend: d.backend });

/**
 * Backend-gated dispatch to n8n. Order of authority:
 * schema -> backend decision (policy/risk/RBAC/mode) -> idempotency -> signed n8n call -> response verification -> audit.
 * n8n never decides policy; every attempt (allowed or blocked) is recorded in automation_runs + audit_logs.
 */
export async function dispatchAutomation(ctx, caseId, proposal, idempotencyKey) {
  const c = await repos.cases.findById(ctx.tenantId, caseId);
  if (!c) throw notFound('Case not found', 'CASE_NOT_FOUND');
  const correlationId = `corr_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

  const decision = await evaluate(ctx, c, proposal);
  const base = {
    caseId: c._id, caseNumber: c.caseNumber, correlationId, requestedAction: proposal?.action, actor: ctx.actor.id, actorType: ctx.actor.type,
    rheaProposal: proposal, backendDecision: publicDecision(decision), workflow: { name: WORKFLOW_NAME }, traceId: ctx.traceId,
    idempotencyKey: sha256(`${ctx.tenantId}:${idempotencyKey ?? randomUUID()}`).slice(0, 40), createdAt: ctx.clock.now(),
  };

  if (!decision.allowed) {
    await recordRun(ctx, { ...base, status: 'BLOCKED', externalService: ACTION_SERVICE[proposal?.action] ?? null, result: { blockedBy: decision.code } });
    await audit(ctx, { action: 'automation.blocked', resourceType: 'case', resourceId: c._id, meta: { code: decision.code, action: proposal?.action, correlationId } });
    await addEvent(ctx, c._id, { type: 'automation.blocked', system: 'settla', action: `Backend blocked automation "${proposal?.action}": ${decision.code}`, status: 'warn', metadata: { correlationId, reasons: decision.reasons } });
    throw new AppError(decision.code, decision.reasons.at(-1) ?? 'Automation blocked', decision.httpStatus, { correlationId, backendDecision: publicDecision(decision) });
  }

  return withIdempotency(ctx.tenantId, 'automation.dispatch', idempotencyKey, { caseId, proposal }, async () => {
    const customerId = c.customerId ?? 'unknown';
    const orderId = c.orderNumber ? String(c.orderNumber).replace(/[^\w-]/g, '') : null;
    const payload = {
      correlationId, caseId: c.caseNumber, customerId, paymentId: c.paymentId, orderId, amount: decision.backend.amount, currency: 'INR',
      issue: 'Money debited but no order', requestedAction: decision.action,
      authorization: {
        approved: true, decisionId: c.decisionId ?? 'none', policyVersion: c.policyId ?? 'n/a', riskLevel: decision.backend.riskLevel,
        humanApprovalSatisfied: decision.humanApprovalSatisfied, approvalId: c.approvalId ?? null, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      },
      ...(decision.action === 'notify_customer' ? { notification: { template: String(decision.proposal.notification?.template ?? 'case_closed'), recipientRef: 'SETTLA_TEST_WHATSAPP_NUMBER' } } : {}),
    };

    const run = await recordRun(ctx, { ...base, status: 'DISPATCHED', externalService: ACTION_SERVICE[decision.action], request: { ...payload }, n8nMode: env.N8N_MODE });
    let out;
    try {
      out = await withRetry(() => dispatchToN8n({ payload, eventId: base.idempotencyKey, correlationId }), { attempts: 3 });
    } catch (e) {
      return finish(ctx, run, c, { status: 'FAILED', error: { code: e.code ?? 'N8N_ERROR', message: e instanceof IntegrationError ? e.message : 'n8n dispatch failed' } }, true);
    }

    const r = out.response;
    const checks = [
      { name: 'http_ok', passed: out.httpStatus >= 200 && out.httpStatus < 300 },
      { name: 'success_flag', passed: r.success === true },
      { name: 'correlation_matches', passed: r.correlationId === correlationId },
      { name: 'case_matches', passed: r.caseId === c.caseNumber },
      { name: 'action_matches', passed: r.action === decision.action },
      { name: 'workflow_matches', passed: r.workflow?.name === WORKFLOW_NAME },
    ];
    const verification = { passed: checks.every((x) => x.passed), checks };

    if (!r.success) {
      return finish(ctx, run, c, { status: 'FAILED', n8nExecutionId: r.workflow?.executionId ?? null, httpStatus: out.httpStatus, error: r.error ?? { code: 'N8N_REJECTED', message: 'n8n rejected the request' }, verification, signaturePrefix: out.signaturePrefix }, true);
    }
    return finish(ctx, run, c, { status: verification.passed ? 'SUCCEEDED' : 'VERIFICATION_FAILED', n8nExecutionId: r.workflow?.executionId ?? null, httpStatus: out.httpStatus, result: r.result, verification, signaturePrefix: out.signaturePrefix }, !verification.passed);
  });
}

async function recordRun(ctx, doc) {
  return repos.automationRuns.insert(ctx.tenantId, doc);
}

async function finish(ctx, run, c, patch, isError) {
  const updated = await repos.automationRuns.update(ctx.tenantId, run._id, { ...patch, finishedAt: ctx.clock.now() });
  await audit(ctx, {
    action: `automation.${patch.status.toLowerCase()}`, resourceType: 'case', resourceId: c._id,
    after: { runId: run._id, correlationId: run.correlationId, requestedAction: run.requestedAction, workflow: run.workflow.name, n8nExecutionId: patch.n8nExecutionId ?? null, externalService: run.externalService, status: patch.status, verification: patch.verification?.passed },
  });
  await addEvent(ctx, c._id, {
    type: `automation.${patch.status.toLowerCase()}`, system: 'n8n', action: `n8n ${run.requestedAction}: ${patch.status}`, status: patch.status === 'SUCCEEDED' ? 'ok' : 'error',
    metadata: { correlationId: run.correlationId, n8nExecutionId: patch.n8nExecutionId ?? null, externalService: run.externalService, verification: patch.verification },
  });
  bus.publish(ctx.tenantId, { type: 'automation.run', caseId: c._id, status: patch.status });
  if (isError) throw new AppError(patch.error?.code ?? 'N8N_VERIFICATION_FAILED', patch.error?.message ?? 'n8n response failed verification', 502, { correlationId: run.correlationId, runId: run._id });
  return { runId: updated._id, status: patch.status, correlationId: run.correlationId, n8nExecutionId: patch.n8nExecutionId ?? null, externalService: run.externalService, result: patch.result, verification: patch.verification };
}
