import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { startDb, stopDb, makeTenant, loginAs } from '../helpers.js';
import { createApp } from '../../src/app.js';
import { getSimulator, resetSimulator } from '../../src/integrations/n8n/client.js';
import { col, C } from '../../src/db/mongo.js';

let app; let A; let B; const tok = {};
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
let seq = 0;
const key = () => `n8n-test-key-${Date.now()}-${seq += 1}`;
const prop = (caseNumber, over = {}) => ({ caseId: caseNumber, decision: 'investigate', action: 'payment_lookup', riskLevel: 'low', requiresHumanApproval: false, ...over });
const post = (caseId, t, proposal, k = key()) => request(app).post(`/api/v1/cases/${caseId}/automation`).set(bearer(t)).set('Idempotency-Key', k).send({ proposal });

async function demoCase(token, scenario) {
  const r = await request(app).post(`/api/v1/demo/run${scenario ? `?scenario=${scenario}` : ''}`).set(bearer(token));
  return r.body.data.case.case;
}

beforeAll(async () => {
  await startDb();
  app = createApp();
  A = await makeTenant('n8nalpha');
  B = await makeTenant('n8nbeta');
  for (const r of ['TENANT_ADMIN', 'CX_AGENT', 'AUDITOR', 'VIEWER', 'FINANCE']) tok[r] = await loginAs(app, request, `${r.toLowerCase()}@n8nalpha.test`);
  tok.B = await loginAs(app, request, 'tenant_admin@n8nbeta.test');
});
afterAll(stopDb);
beforeEach(() => { resetSimulator(); });

describe('Rhea proposal -> backend decision', () => {
  it('GET proposal returns Rhea proposal plus the backend verdict', async () => {
    const c = await demoCase(tok.TENANT_ADMIN);
    const r = await request(app).get(`/api/v1/cases/${c._id}/automation/proposal`).set(bearer(tok.TENANT_ADMIN));
    expect(r.status).toBe(200);
    expect(r.body.data.proposal).toMatchObject({ caseId: c.caseNumber, decision: 'investigate', action: 'payment_lookup', requiresHumanApproval: false });
    expect(r.body.data.backendDecision).toMatchObject({ allowed: true, code: 'ALLOWED' });
    expect(r.body.data.backendDecision.backend.autoLimit).toBe(5000);
  });
});

describe('dispatch to n8n (signed, backend-gated)', () => {
  it('executes an approved read-only step, verifies the response, and writes the full audit trail', async () => {
    const c = await demoCase(tok.TENANT_ADMIN);
    const r = await post(c._id, tok.TENANT_ADMIN, prop(c.caseNumber));
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'SUCCEEDED', externalService: 'razorpay', verification: { passed: true } });
    expect(r.body.data.n8nExecutionId).toMatch(/^sim-/);
    expect(r.body.data.result.mode).toBe('test-placeholder');

    const run = await col(C.automationRuns).findOne({ tenantId: A.tenant._id, caseId: c._id });
    expect(run).toMatchObject({
      correlationId: r.body.data.correlationId, requestedAction: 'payment_lookup', actor: expect.any(String), status: 'SUCCEEDED',
      workflow: { name: 'SETTLA - PAYMENT RESOLUTION' }, n8nExecutionId: r.body.data.n8nExecutionId, externalService: 'razorpay',
    });
    expect(run.rheaProposal.action).toBe('payment_lookup');
    expect(run.backendDecision.allowed).toBe(true);
    expect(run.verification.passed).toBe(true);
    expect(run.createdAt).toBeTruthy();
    expect(JSON.stringify(run)).not.toContain(process.env.N8N_SIGNING_SECRET); // secrets never persisted
    expect(JSON.stringify(run)).not.toContain(process.env.N8N_WEBHOOK_AUTH_TOKEN);

    const audit = await col(C.auditLogs).findOne({ tenantId: A.tenant._id, action: 'automation.succeeded', resourceId: c._id });
    expect(audit.after).toMatchObject({ correlationId: run.correlationId, workflow: 'SETTLA - PAYMENT RESOLUTION', verification: true });
    const ev = await col(C.caseEvents).findOne({ tenantId: A.tenant._id, caseId: c._id, type: 'automation.succeeded' });
    expect(ev.metadata.correlationId).toBe(run.correlationId);

    const list = await request(app).get(`/api/v1/cases/${c._id}/automation`).set(bearer(tok.AUDITOR));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
  });

  it('duplicate request with the same Idempotency-Key replays and does not call n8n twice', async () => {
    const c = await demoCase(tok.TENANT_ADMIN);
    const k = key();
    const before = getSimulator().calls.length;
    const r1 = await post(c._id, tok.TENANT_ADMIN, prop(c.caseNumber), k);
    const r2 = await post(c._id, tok.TENANT_ADMIN, prop(c.caseNumber), k);
    expect(r1.status).toBe(200);
    expect(r2.body.data.idempotentReplay).toBe(true);
    expect(r2.body.data.n8nExecutionId).toBe(r1.body.data.n8nExecutionId);
    expect(getSimulator().calls.length - before).toBe(1);
    expect(await col(C.automationRuns).countDocuments({ tenantId: A.tenant._id, caseId: c._id, status: 'SUCCEEDED' })).toBe(1);
  });

  it('same key with a different proposal is rejected (422)', async () => {
    const c = await demoCase(tok.TENANT_ADMIN);
    const k = key();
    await post(c._id, tok.TENANT_ADMIN, prop(c.caseNumber), k);
    const r = await post(c._id, tok.TENANT_ADMIN, prop(c.caseNumber, { action: 'order_lookup' }), k);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('requires an Idempotency-Key', async () => {
    const c = await demoCase(tok.TENANT_ADMIN);
    const r = await request(app).post(`/api/v1/cases/${c._id}/automation`).set(bearer(tok.TENANT_ADMIN)).send({ proposal: prop(c.caseNumber) });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('invalid proposals are rejected by the backend before n8n is called', async () => {
    const c = await demoCase(tok.TENANT_ADMIN);
    const calls = getSimulator().calls.length;
    for (const bad of [{ nonsense: true }, { ...prop(c.caseNumber), extra: 'x' }, prop(c.caseNumber, { riskLevel: 'catastrophic' }), prop(c.caseNumber, { action: 'drop_database' })]) {
      const r = await post(c._id, tok.TENANT_ADMIN, bad);
      expect([403, 422]).toContain(r.status);
      expect(r.body.success).toBe(false);
    }
    expect(getSimulator().calls.length).toBe(calls);
  });

  it('financial actions are blocked by the backend and never reach n8n', async () => {
    const c = await demoCase(tok.TENANT_ADMIN);
    const calls = getSimulator().calls.length;
    for (const a of ['refund', 'create_refund', 'capture_payment']) {
      const r = await post(c._id, tok.TENANT_ADMIN, prop(c.caseNumber, { decision: 'refund', action: a }));
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('FINANCIAL_ACTION_NOT_ALLOWED');
    }
    expect(getSimulator().calls.length).toBe(calls);
    const blocked = await col(C.automationRuns).countDocuments({ tenantId: A.tenant._id, caseId: c._id, status: 'BLOCKED' });
    expect(blocked).toBe(3); // blocked attempts are audited too
  });

  it('unauthorized roles are rejected by the backend', async () => {
    const c = await demoCase(tok.TENANT_ADMIN);
    expect((await post(c._id, tok.VIEWER, prop(c.caseNumber))).status).toBe(403); // no automation:dispatch
    expect((await post(c._id, tok.AUDITOR, prop(c.caseNumber))).status).toBe(403); // read-only role
    expect((await post(c._id, tok.FINANCE, prop(c.caseNumber))).status).toBe(403);
    expect((await request(app).get(`/api/v1/cases/${c._id}/automation`).set(bearer(tok.VIEWER))).status).toBe(403);
    expect((await request(app).post(`/api/v1/cases/${c._id}/automation`).send({ proposal: prop(c.caseNumber) })).status).toBe(401);
  });

  it('a side-effect action needs its own permission (CX_AGENT cannot sync CRM)', async () => {
    const c = await demoCase(tok.TENANT_ADMIN);
    const r = await post(c._id, tok.CX_AGENT, prop(c.caseNumber, { decision: 'sync', action: 'sync_crm' }));
    expect(r.status).toBe(403);
    expect(r.body.error.message).toMatch(/crm:write/);
  });

  it('amount > ₹5,000: Rhea claiming "no approval needed" is overruled; read-only still allowed', async () => {
    const c = await demoCase(tok.TENANT_ADMIN, 'high_value'); // ₹18,750 escalated case
    const side = await post(c._id, tok.TENANT_ADMIN, prop(c.caseNumber, { decision: 'notify', action: 'notify_customer', riskLevel: 'low', requiresHumanApproval: false }));
    expect(side.status).toBe(409);
    expect(side.body.error.code).toBe('HUMAN_APPROVAL_REQUIRED');
    expect(side.body.error.details.backendDecision.backend).toMatchObject({ amount: 18750, requiresApproval: true });
    expect((await post(c._id, tok.TENANT_ADMIN, prop(c.caseNumber))).status).toBe(200); // payment_lookup is read-only

    await col(C.approvals).insertOne({ _id: 'appr-n8n-1', tenantId: A.tenant._id, caseId: c._id, status: 'APPROVED', createdAt: new Date() });
    const ok = await post(c._id, tok.TENANT_ADMIN, prop(c.caseNumber, { decision: 'notify', action: 'notify_customer', notification: { template: 'case_closed' } }));
    expect(ok.status).toBe(200);
    expect(ok.body.data.result.data).toMatchObject({ dispatched: false, recipientRef: 'SETTLA_TEST_WHATSAPP_NUMBER' });
  });

  it('kill switch: RECOMMEND_ONLY allows read-only only; DISABLED blocks all', async () => {
    const c = await demoCase(tok.TENANT_ADMIN);
    await request(app).patch('/api/v1/tenant/execution-mode').set(bearer(tok.TENANT_ADMIN)).send({ mode: 'RECOMMEND_ONLY' });
    expect((await post(c._id, tok.TENANT_ADMIN, prop(c.caseNumber, { decision: 'notify', action: 'notify_customer' }))).body.error.code).toBe('RECOMMEND_ONLY');
    expect((await post(c._id, tok.TENANT_ADMIN, prop(c.caseNumber))).status).toBe(200);
    await request(app).patch('/api/v1/tenant/execution-mode').set(bearer(tok.TENANT_ADMIN)).send({ mode: 'DISABLED' });
    expect((await post(c._id, tok.TENANT_ADMIN, prop(c.caseNumber))).body.error.code).toBe('EXECUTION_DISABLED');
    await request(app).patch('/api/v1/tenant/execution-mode').set(bearer(tok.TENANT_ADMIN)).send({ mode: 'AUTONOMOUS' });
  });

  it('tenant isolation: tenant B cannot dispatch to or read tenant A cases', async () => {
    const c = await demoCase(tok.TENANT_ADMIN);
    expect((await post(c._id, tok.B, prop(c.caseNumber))).status).toBe(404);
    expect((await request(app).get(`/api/v1/cases/${c._id}/automation`).set(bearer(tok.B))).body.data).toHaveLength(0);
    expect(B.tenant._id).not.toBe(A.tenant._id);
  });
});

describe('n8n failure handling', () => {
  it.each([['server_error', 'FAILED'], ['bad_response', 'FAILED'], ['timeout', 'FAILED']])('n8n %s => 502 and a FAILED audited run, no phantom success', async (fault) => {
    const c = await demoCase(tok.TENANT_ADMIN);
    getSimulator().setFault(fault);
    const r = await post(c._id, tok.TENANT_ADMIN, prop(c.caseNumber));
    expect(r.status).toBe(502);
    expect(r.body.success).toBe(false);
    expect(r.body.error.requestId).toBeTruthy();
    expect(JSON.stringify(r.body)).not.toMatch(/stack|secret/i);
    const run = await col(C.automationRuns).findOne({ tenantId: A.tenant._id, caseId: c._id, status: 'FAILED' });
    expect(run).toBeTruthy();
    expect(run.correlationId).toBeTruthy();
    getSimulator().setFault(null);
  });

  it('after a failure the same key can be retried; n8n replay protection prevents double execution', async () => {
    const c = await demoCase(tok.TENANT_ADMIN);
    const k = key();
    getSimulator().setFault('server_error');
    expect((await post(c._id, tok.TENANT_ADMIN, prop(c.caseNumber), k)).status).toBe(502);
    getSimulator().setFault(null);
    const retry = await post(c._id, tok.TENANT_ADMIN, prop(c.caseNumber), k);
    expect(retry.status).toBe(200); // never executed before, so the event id is still fresh
    const again = await post(c._id, tok.TENANT_ADMIN, prop(c.caseNumber), k);
    expect(again.body.data.idempotentReplay).toBe(true);
  });
});
