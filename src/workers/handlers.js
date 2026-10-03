import { col, C } from '../db/mongo.js';
import { makeCtx, makeClock } from '../lib/context.js';
import { processCase } from '../agents/rhea.js';
import { registerHandler, enqueue } from '../queues/index.js';
import { repos } from '../repositories/index.js';
import { runTool } from '../tools/executor.js';
import { agentActor } from '../lib/context.js';
import { sha256 } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';

const loadCtx = async (tenantId, extra = {}) => {
  const tenant = await col(C.tenants).findOne({ _id: tenantId });
  if (!tenant) throw new Error('tenant gone');
  return makeCtx({ tenant, actor: agentActor(), ...extra });
};

export function registerAllHandlers() {
  registerHandler('case-processing', async ({ data }) => {
    const ctx = await loadCtx(data.tenantId);
    const c = await repos.cases.findById(data.tenantId, data.caseId);
    if (!c || c.status !== 'NEW') return; // idempotent: already processed
    await processCase(makeCtx({ tenant: ctx.tenant, clock: makeClock({ simulated: c.simulated }) }), data.caseId);
  });

  registerHandler('retry', async ({ name, data }) => {
    const ctx = await loadCtx(data.tenantId);
    const c = await repos.cases.findById(data.tenantId, data.caseId);
    if (!c) return;
    if (name === 'followup-retry') {
      const r = await runTool(ctx, { caseDoc: c, tool: data.tool, params: data.params, idempotencyKey: sha256(`${c._id}:${data.tool}:retry`).slice(0, 40) });
      if (r.status !== 'VERIFIED' && r.status !== 'REPLAY') throw new Error(`follow-up ${data.tool} still failing`); // BullMQ backoff, bounded attempts, then DLQ
      await repos.cases.update(data.tenantId, c._id, { followUpsPending: (c.followUpsPending ?? []).filter((k) => !data.tool.includes(k === 'notify' ? 'notify' : k === 'ticket' ? 'ticket' : 'crm')) });
    }
    if (name === 'reversal-recheck' && c.status === 'WAITING_REVERSAL') {
      const p = await ctx.adapters.payments.getPayment(c.paymentId);
      logger.info({ caseId: c._id, status: p?.status }, 'reversal recheck');
      if (p?.status === 'captured') await enqueue('escalations', 'reversal-now-captured', { tenantId: data.tenantId, caseId: c._id });
    }
  });

  registerHandler('escalations', async ({ data }) => {
    const ctx = await loadCtx(data.tenantId);
    const c = await repos.cases.findById(data.tenantId, data.caseId);
    const { createEscalation } = await import('../services/escalationService.js');
    if (c) await createEscalation(ctx, c, { reason: 'payment_captured_after_wait', detail: 'Payment became captured while waiting for reversal' });
  });
}
