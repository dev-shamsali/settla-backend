import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { startDb, stopDb, makeTenant, loginAs } from '../helpers.js';
import { createApp } from '../../src/app.js';
import { seedDemoWorld, getWorld } from '../../src/integrations/index.js';
import { signWebhook } from '../../src/security/webhook.js';
import { col, C } from '../../src/db/mongo.js';

let app; let A; let B; const tok = {};
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const bigPayment = (w, id, amount) => w.payments.set(id, { id, status: 'captured', amount, currency: 'INR', amountRefunded: 0, email: 'vikram@example.test' });

beforeAll(async () => {
  await startDb();
  app = createApp();
  A = await makeTenant('alpha');
  B = await makeTenant('beta');
  for (const r of ['TENANT_ADMIN', 'CX_AGENT', 'FINANCE', 'VIEWER', 'AUDITOR', 'CX_LEAD']) tok[`A_${r}`] = await loginAs(app, request, `${r.toLowerCase()}@alpha.test`);
  tok.B_ADMIN = await loginAs(app, request, 'tenant_admin@beta.test');
  seedDemoWorld(A.tenant._id);
  seedDemoWorld(B.tenant._id);
});
afterAll(stopDb);

describe('authentication', () => {
  it('rejects bad credentials generically', async () => {
    const r = await request(app).post('/api/v1/auth/login').send({ email: 'tenant_admin@alpha.test', password: 'wrong-password' });
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ success: false, error: { code: 'INVALID_CREDENTIALS' } });
    expect(r.body.error.requestId).toBeTruthy();
  });
  it('requires a token', async () => expect((await request(app).get('/api/v1/cases')).status).toBe(401));
  it('rejects expired token', async () => {
    const u = await col(C.users).findOne({ email: 'tenant_admin@alpha.test' });
    const expired = jwt.sign({ sub: u._id, tid: u.tenantId, role: u.role }, process.env.JWT_ACCESS_SECRET, { expiresIn: -10, issuer: 'settla', audience: 'settla-api' });
    expect((await request(app).get('/api/v1/cases').set(bearer(expired))).status).toBe(401);
  });
  it('rejects forged token (wrong secret) and alg=none', async () => {
    const u = await col(C.users).findOne({ email: 'tenant_admin@alpha.test' });
    const forged = jwt.sign({ sub: u._id, tid: u.tenantId }, 'not-the-secret-not-the-secret-not-the-secret', { issuer: 'settla', audience: 'settla-api' });
    expect((await request(app).get('/api/v1/cases').set(bearer(forged))).status).toBe(401);
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: u._id, tid: u.tenantId })).toString('base64url')}.`;
    expect((await request(app).get('/api/v1/cases').set(bearer(none))).status).toBe(401);
  });
  it('refresh rotates and detects reuse', async () => {
    const l = await request(app).post('/api/v1/auth/login').send({ email: 'viewer@alpha.test', password: 'Test!Passw0rd123' });
    const rt = l.body.data.refreshToken;
    const r1 = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: rt });
    expect(r1.status).toBe(200);
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: rt })).body.error.code).toBe('REFRESH_REUSED');
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: r1.body.data.refreshToken })).status).toBe(401); // family revoked
  });
});

describe('RBAC', () => {
  it('VIEWER cannot create cases or refund', async () => {
    expect((await request(app).post('/api/v1/cases').set(bearer(tok.A_VIEWER)).send({ paymentId: 'pay_Q7xK2' })).status).toBe(403);
    expect((await request(app).post('/api/v1/payments/pay_Q7xK2/refund').set(bearer(tok.A_VIEWER)).set('Idempotency-Key', 'k-viewer-0001').send({})).status).toBe(403);
  });
  it('unauthorized refund blocked for CX_AGENT', async () => {
    const r = await request(app).post('/api/v1/payments/pay_Q7xK2/refund').set(bearer(tok.A_CX_AGENT)).set('Idempotency-Key', 'k-agent-00001').send({});
    expect(r.status).toBe(403);
    expect(getWorld(A.tenant._id).refunds.size).toBe(0);
  });
  it('AUDITOR can read audit but not mutate', async () => {
    expect((await request(app).get('/api/v1/audit').set(bearer(tok.A_AUDITOR))).status).toBe(200);
    expect((await request(app).patch('/api/v1/tenant/execution-mode').set(bearer(tok.A_AUDITOR)).send({ mode: 'DISABLED' })).status).toBe(403);
  });
  it('revoked permission takes effect immediately on an existing token', async () => {
    expect((await request(app).get('/api/v1/cases').set(bearer(tok.A_CX_LEAD))).status).toBe(200);
    const lead = await col(C.users).findOne({ email: 'cx_lead@alpha.test' });
    const r = await request(app).patch(`/api/v1/users/${lead._id}`).set(bearer(tok.A_TENANT_ADMIN)).send({ revokedPermissions: ['cases:read'] });
    expect(r.status).toBe(200);
    expect((await request(app).get('/api/v1/cases').set(bearer(tok.A_CX_LEAD))).status).toBe(403);
  });
  it('disabled user is rejected on next request', async () => {
    const v = await col(C.users).findOne({ email: 'viewer@alpha.test' });
    await col(C.users).updateOne({ _id: v._id }, { $set: { status: 'disabled' } });
    expect((await request(app).get('/api/v1/cases').set(bearer(tok.A_VIEWER))).status).toBe(401);
  });
});

describe('tenant isolation', () => {
  let caseA;
  beforeAll(async () => {
    const r = await request(app).post('/api/v1/demo/run').set(bearer(tok.A_TENANT_ADMIN));
    expect(r.status).toBe(200);
    caseA = r.body.data.case.case;
  });
  it('tenant A sees its case, tenant B does not', async () => {
    expect((await request(app).get(`/api/v1/cases/${caseA._id}`).set(bearer(tok.A_TENANT_ADMIN))).status).toBe(200);
    expect((await request(app).get(`/api/v1/cases/${caseA._id}`).set(bearer(tok.B_ADMIN))).status).toBe(404);
    const list = await request(app).get('/api/v1/cases').set(bearer(tok.B_ADMIN));
    expect(list.body.data.total).toBe(0);
  });
  it('B cannot read A customers/orders/payments/audit/decisions/approvals', async () => {
    for (const path of ['customers', 'orders', 'payments', 'audit', 'decisions', 'approvals', 'escalations', 'notifications']) {
      const r = await request(app).get(`/api/v1/${path}`).set(bearer(tok.B_ADMIN));
      expect(r.status, path).toBe(200);
      expect(r.body.data.items ?? r.body.data, path).toHaveLength(0);
    }
    const custA = await request(app).get('/api/v1/customers').set(bearer(tok.A_TENANT_ADMIN));
    expect((await request(app).get(`/api/v1/customers/${custA.body.data.items[0]._id}`).set(bearer(tok.B_ADMIN))).status).toBe(404);
  });
  it('tenant_id in body/query is rejected or ignored — never trusted', async () => {
    const r = await request(app).post('/api/v1/cases').set(bearer(tok.B_ADMIN)).send({ paymentId: 'pay_Q7xK2', tenantId: A.tenant._id });
    expect(r.status).toBe(400); // strict schema rejects unknown key
    const spoof = await request(app).get(`/api/v1/cases?tenantId=${A.tenant._id}`).set(bearer(tok.B_ADMIN));
    expect(spoof.status).toBe(400);
  });
  it('B cannot refund A payment (gateway world is tenant-partitioned)', async () => {
    const r = await request(app).post('/api/v1/payments/pay_Q7xK2/refund').set(bearer(tok.B_ADMIN)).set('Idempotency-Key', 'k-b-cross-0001').send({ amount: 100 });
    expect([200, 202, 404, 409, 422]).toContain(r.status);
    expect(getWorld(A.tenant._id).refunds.size).toBe(0);
  });
  it('disabled tenant: existing tokens stop working', async () => {
    const c = await makeTenant('gamma');
    const t = await loginAs(app, request, 'tenant_admin@gamma.test');
    expect((await request(app).get('/api/v1/cases').set(bearer(t))).status).toBe(200);
    await col(C.tenants).updateOne({ _id: c.tenant._id }, { $set: { status: 'disabled' } });
    const r = await request(app).get('/api/v1/cases').set(bearer(t));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('TENANT_DISABLED');
  });
});

describe('financial safety: refunds', () => {
  it('requires an Idempotency-Key', async () => {
    const r = await request(app).post('/api/v1/payments/pay_Q7xK2/refund').set(bearer(tok.A_FINANCE)).send({ amount: 100 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
  it('duplicate refund request replays, never double-refunds', async () => {
    seedDemoWorld(A.tenant._id);
    const send = () => request(app).post('/api/v1/payments/pay_Q7xK2/refund').set(bearer(tok.A_FINANCE)).set('Idempotency-Key', 'dup-refund-0001').send({ amount: 1000, reason: 'test' });
    const r1 = await send();
    expect(r1.status).toBe(200);
    expect(r1.body.data.status).toBe('REFUNDED');
    const r2 = await send();
    expect(r2.status).toBe(200);
    expect(r2.body.data.idempotentReplay).toBe(true);
    expect(getWorld(A.tenant._id).refunds.size).toBe(1);
    expect(getWorld(A.tenant._id).payments.get('pay_Q7xK2').amountRefunded).toBe(1000);
  });
  it('same key with different body is rejected (422)', async () => {
    const r = await request(app).post('/api/v1/payments/pay_Q7xK2/refund').set(bearer(tok.A_FINANCE)).set('Idempotency-Key', 'dup-refund-0001').send({ amount: 2000 });
    expect(r.status).toBe(422);
  });
  it('client cannot exceed the gateway balance (amount is not trusted)', async () => {
    const r = await request(app).post('/api/v1/payments/pay_Q7xK2/refund').set(bearer(tok.A_FINANCE)).set('Idempotency-Key', 'over-refund-0001').send({ amount: 999999 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('REFUND_EXCEEDS_BALANCE');
  });
  it('> ₹5,000 requires approval; requester cannot self-approve; second approver executes', async () => {
    bigPayment(getWorld(A.tenant._id), 'pay_BIG1', 18750);
    const r = await request(app).post('/api/v1/payments/pay_BIG1/refund').set(bearer(tok.A_FINANCE)).set('Idempotency-Key', 'big-refund-0001').send({ reason: 'Duplicate capture' });
    expect(r.status).toBe(202);
    expect(r.body.data.status).toBe('APPROVAL_REQUIRED');
    expect(getWorld(A.tenant._id).payments.get('pay_BIG1').amountRefunded).toBe(0);
    const approvalId = r.body.data.approvalId;
    const self = await request(app).post(`/api/v1/approvals/${approvalId}/decision`).set(bearer(tok.A_FINANCE)).send({ decision: 'approve' });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('SELF_APPROVAL');
    const ok = await request(app).post(`/api/v1/approvals/${approvalId}/decision`).set(bearer(tok.A_TENANT_ADMIN)).send({ decision: 'approve', note: 'verified duplicate' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.outcome).toBe('REFUNDED');
    expect(getWorld(A.tenant._id).payments.get('pay_BIG1').amountRefunded).toBe(18750);
    const again = await request(app).post(`/api/v1/approvals/${approvalId}/decision`).set(bearer(tok.A_TENANT_ADMIN)).send({ decision: 'approve' });
    expect(again.status).toBe(409);
  });
  it('rejected approval moves nothing and closes the case', async () => {
    bigPayment(getWorld(A.tenant._id), 'pay_BIG2', 9000);
    const r = await request(app).post('/api/v1/payments/pay_BIG2/refund').set(bearer(tok.A_FINANCE)).set('Idempotency-Key', 'big-refund-0002').send({});
    const rej = await request(app).post(`/api/v1/approvals/${r.body.data.approvalId}/decision`).set(bearer(tok.A_TENANT_ADMIN)).send({ decision: 'reject', note: 'not duplicate' });
    expect(rej.body.data.outcome).toBe('REJECTED');
    expect(getWorld(A.tenant._id).payments.get('pay_BIG2').amountRefunded).toBe(0);
  });
  it('approver lacking refund permission cannot execute an approved refund', async () => {
    bigPayment(getWorld(A.tenant._id), 'pay_BIG3', 9000);
    const r = await request(app).post('/api/v1/payments/pay_BIG3/refund').set(bearer(tok.A_FINANCE)).set('Idempotency-Key', 'big-refund-0003').send({});
    const lead = await request(app).post(`/api/v1/approvals/${r.body.data.approvalId}/decision`).set(bearer(tok.A_CX_LEAD)).send({ decision: 'approve' });
    expect(lead.status).toBe(403);
    expect(lead.body.error.code).toBe('APPROVER_LACKS_PERMISSION');
    const still = await request(app).get('/api/v1/approvals?status=PENDING').set(bearer(tok.A_TENANT_ADMIN));
    expect(still.body.data.items.some((x) => x._id === r.body.data.approvalId)).toBe(true); // not consumed
    expect(getWorld(A.tenant._id).payments.get('pay_BIG3').amountRefunded).toBe(0);
  });
});

describe('kill switch via API', () => {
  it('admin sets RECOMMEND_ONLY and it is audited; sensitive agent action blocked', async () => {
    const r = await request(app).patch('/api/v1/tenant/execution-mode').set(bearer(tok.A_TENANT_ADMIN)).send({ mode: 'RECOMMEND_ONLY', reason: 'incident' });
    expect(r.status).toBe(200);
    const audit = await request(app).get('/api/v1/audit?action=tenant.execution_mode').set(bearer(tok.A_AUDITOR));
    expect(audit.body.data.items[0].after.mode).toBe('RECOMMEND_ONLY');
    const demo = await request(app).post('/api/v1/demo/run').set(bearer(tok.A_TENANT_ADMIN));
    expect(demo.body.data.result.reason).toBe('recommend_only_mode');
    await request(app).patch('/api/v1/tenant/execution-mode').set(bearer(tok.A_TENANT_ADMIN)).send({ mode: 'AUTONOMOUS' });
  });
});

describe('webhooks', () => {
  let keyId; let secret;
  const send = (body, { sig, ts = String(Math.floor(Date.now() / 1000)), eventId = `evt_${Math.random()}`, key = keyId, s = secret } = {}) => {
    const raw = JSON.stringify(body);
    return request(app).post('/webhooks/razorpay').set('content-type', 'application/json').set('x-settla-key-id', key ?? '').set('x-settla-timestamp', ts)
      .set('x-settla-signature', sig ?? signWebhook(s ?? 'x', ts, raw)).set('x-event-id', eventId).send(raw);
  };
  const captured = (id) => ({ event: 'payment.captured', payload: { payment: { entity: { id, amount: 349900, email: 'ananya@example.test', contact: '+919800000001' } } } });
  beforeAll(async () => {
    const r = await request(app).put('/api/v1/integrations/razorpay').set(bearer(tok.A_TENANT_ADMIN)).send({ mode: 'mock' });
    ({ keyId, webhookSecret: secret } = r.body.data);
    seedDemoWorld(A.tenant._id);
  });
  it('accepts a valid signed event and creates a case for the right tenant', async () => {
    const r = await send(captured('pay_WH1'));
    expect(r.status).toBe(202);
    const c = await col(C.cases).findOne({ _id: r.body.data.caseId });
    expect(c.tenantId).toBe(A.tenant._id);
  });
  it('rejects invalid signature', async () => expect((await send(captured('pay_WH2'), { sig: 'deadbeef' })).status).toBe(401));
  it('rejects unknown key id', async () => expect((await send(captured('pay_WH3'), { key: 'wk_unknown' })).status).toBe(401));
  it('rejects stale timestamp', async () => {
    const ts = String(Math.floor(Date.now() / 1000) - 7200);
    expect((await send(captured('pay_WH4'), { ts })).body.error.code).toBe('WEBHOOK_TIMESTAMP_INVALID');
  });
  it('replayed event id is not processed twice', async () => {
    const body = captured('pay_WH5');
    const a = await send(body, { eventId: 'evt_replay_1' });
    const b = await send(body, { eventId: 'evt_replay_1' });
    expect(a.status).toBe(202);
    expect(b.body.data.replay).toBe(true);
    expect(await col(C.cases).countDocuments({ tenantId: A.tenant._id, paymentId: 'pay_WH5' })).toBe(1);
  });
  it('tenant is taken from the key, never from the body', async () => {
    const r = await send({ ...captured('pay_WH6'), tenantId: B.tenant._id });
    const c = await col(C.cases).findOne({ _id: r.body.data.caseId });
    expect(c.tenantId).toBe(A.tenant._id);
  });
});

describe('input hardening', () => {
  it('rejects oversized body (413)', async () => {
    const r = await request(app).post('/api/v1/cases').set(bearer(tok.A_TENANT_ADMIN)).send({ paymentId: 'pay_x1', customerMessage: 'a'.repeat(200_000) });
    expect(r.status).toBe(413);
  });
  it('rejects NoSQL operator injection in body and query', async () => {
    const login = await request(app).post('/api/v1/auth/login').send({ email: { $ne: null }, password: { $ne: null } });
    expect(login.status).toBe(400);
    const q = await request(app).get('/api/v1/cases?status[$ne]=x').set(bearer(tok.A_TENANT_ADMIN));
    expect(q.status).toBe(400);
  });
  it('SQL-injection style strings are inert (validated/escaped)', async () => {
    const r = await request(app).get(`/api/v1/cases?search=${encodeURIComponent("'; DROP TABLE cases;--")}`).set(bearer(tok.A_TENANT_ADMIN));
    expect(r.status).toBe(200);
    expect(r.body.data.total).toBe(0);
    const p = await request(app).get(`/api/v1/payments/${encodeURIComponent("pay_1' OR '1'='1")}`).set(bearer(tok.A_TENANT_ADMIN));
    expect(p.status).toBe(400);
  });
  it('regex special chars in search do not cause ReDoS/injection', async () => {
    expect((await request(app).get('/api/v1/cases?search=(a%2B)%2B%24').set(bearer(tok.A_TENANT_ADMIN))).status).toBe(200);
  });
  it('XSS payload in customer message is neutralised before storage/prompting', async () => {
    const r = await request(app).post('/api/v1/cases').set(bearer(tok.A_TENANT_ADMIN)).send({ paymentId: 'pay_xss1', customerMessage: '<img src=x onerror=alert(1)>' });
    expect(r.status).toBe(201);
    const { analyzeUntrusted } = await import('../../src/security/untrusted.js');
    expect(analyzeUntrusted(r.body.data.customerMessage).text).not.toContain('<img');
  });
  it('malformed JSON -> 400 and no stack leak', async () => {
    const r = await request(app).post('/api/v1/auth/login').set('content-type', 'application/json').send('{"email":');
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toMatch(/at .*\.js/);
  });
  it('unknown route -> standard 404 envelope; security headers present', async () => {
    const r = await request(app).get('/api/v1/nope').set(bearer(tok.A_TENANT_ADMIN));
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('ROUTE_NOT_FOUND');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });
  it('audit log has no mutation endpoints and never stores secrets', async () => {
    expect((await request(app).delete('/api/v1/audit').set(bearer(tok.A_TENANT_ADMIN))).status).toBe(404);
    expect((await request(app).put('/api/v1/integrations/slack').set(bearer(tok.A_TENANT_ADMIN)).send({ credentials: { SLACK_WEBHOOK_URL: 'https://hooks.slack.com/SECRETVALUE' } })).status).toBe(200);
    const logs = await col(C.auditLogs).find({ tenantId: A.tenant._id }).toArray();
    expect(JSON.stringify(logs)).not.toContain('SECRETVALUE');
    const ints = await request(app).get('/api/v1/integrations').set(bearer(tok.A_TENANT_ADMIN));
    expect(JSON.stringify(ints.body)).not.toContain('SECRETVALUE');
  });
  it('health endpoint', async () => expect((await request(app).get('/health')).body.status).toBe('ok'));
});

describe('core read APIs', () => {
  it('cases list supports filter/sort/pagination; detail has the 15 required sections', async () => {
    await request(app).patch('/api/v1/tenant/execution-mode').set(bearer(tok.A_TENANT_ADMIN)).send({ mode: 'AUTONOMOUS' });
    const run = await request(app).post('/api/v1/demo/run').set(bearer(tok.A_TENANT_ADMIN));
    const list = await request(app).get('/api/v1/cases?status=RESOLVED&sort=amount&order=desc&pageSize=5').set(bearer(tok.A_TENANT_ADMIN));
    expect(list.body.data.items.length).toBeGreaterThan(0);
    const id = run.body.data.case.case._id;
    const d = (await request(app).get(`/api/v1/cases/${id}`).set(bearer(tok.A_TENANT_ADMIN))).body.data;
    for (const k of ['case', 'customer', 'payment', 'orders', 'events', 'transitions', 'decisions', 'traces', 'actions', 'approvals', 'escalations', 'messages', 'audit']) expect(d, k).toHaveProperty(k);
    expect(d.events.length).toBeGreaterThanOrEqual(10);
    expect(d.events[0]).toMatchObject({ type: expect.any(String), system: expect.any(String), traceId: expect.any(String) });
  });
  it('analytics summary reports real (non-fabricated) numbers', async () => {
    const s = (await request(app).get('/api/v1/analytics/summary').set(bearer(tok.A_TENANT_ADMIN))).body.data;
    expect(s.recoveredRevenue).toBeGreaterThan(0);
    expect(s.csat).toBeNull();
    const ts = await request(app).get('/api/v1/analytics/timeseries').set(bearer(tok.A_TENANT_ADMIN));
    expect(ts.status).toBe(200);
  });
  it('policies, openapi, knowledge search', async () => {
    expect((await request(app).get('/api/v1/policies').set(bearer(tok.A_TENANT_ADMIN))).body.data.map((p) => p.id)).toContain('recover-order-v2');
    expect((await request(app).get('/api/v1/openapi.json')).body.openapi).toBe('3.0.3');
    const k = await request(app).get('/api/v1/knowledge/search?q=refund%20limit').set(bearer(tok.A_TENANT_ADMIN));
    expect(k.body.data[0].title).toBe('Refund policy');
  });
  it('escalation take_over / close actions', async () => {
    const run = await request(app).post('/api/v1/demo/run?scenario=human').set(bearer(tok.A_TENANT_ADMIN));
    const escId = run.body.data.case.escalations[0]._id;
    expect((await request(app).post(`/api/v1/escalations/${escId}/actions`).set(bearer(tok.A_CX_AGENT)).send({ action: 'take_over' })).body.data.status).toBe('IN_PROGRESS');
    expect((await request(app).post(`/api/v1/escalations/${escId}/actions`).set(bearer(tok.A_CX_AGENT)).send({ action: 'refund' })).status).toBe(403);
    expect((await request(app).post(`/api/v1/escalations/${escId}/actions`).set(bearer(tok.A_CX_AGENT)).send({ action: 'close', note: 'handled by phone' })).body.data.status).toBe('CLOSED');
  });
});

describe('rate limiting (runs last: exhausts the login limiter)', () => {
  it('login is rate limited', async () => {
    const limited = createApp({ authLimit: 5 });
    let last;
    for (let i = 0; i < 8; i += 1) last = await request(limited).post('/api/v1/auth/login').send({ email: 'x@alpha.test', password: 'nope' });
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe('RATE_LIMITED');
  });
});
