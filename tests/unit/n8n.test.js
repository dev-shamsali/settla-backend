import { describe, it, expect, beforeEach } from 'vitest';
import { createN8nSimulator } from '../../src/integrations/n8n/mockN8n.js';
import { hmacSha256 } from '../../src/lib/crypto.js';
import { decideAutomation, proposeAutomation } from '../../src/agents/automationProposal.js';
import { RazorpayAdapter, assertPaymentProvider } from '../../src/integrations/payments/paymentProvider.js';
import { n8nRequestSchema, WORKFLOW_NAME } from '../../src/integrations/n8n/contract.js';
import { createMockAdapters } from '../../src/integrations/mock/adapters.js';
import { seedDemoWorld } from '../../src/integrations/index.js';

const SECRET = 'unit-test-signing-secret-0123456789abcdef';
const TOKEN = 'unit-test-auth-token-0123456789abcdef';

const body = (over = {}) => ({
  correlationId: 'corr_unit_0001', caseId: 'CASE-20914', customerId: 'TEST-CUSTOMER', paymentId: 'pay_Q7xK2', orderId: 'TEST-ORDER', amount: 3499, currency: 'INR',
  issue: 'Money debited but no order', requestedAction: 'investigate_payment',
  authorization: { approved: true, decisionId: 'd1', policyVersion: 'v2', riskLevel: 'LOW', humanApprovalSatisfied: false, approvalId: null, expiresAt: new Date(Date.now() + 300_000).toISOString() },
  ...over,
});
function signed(sim, payload, { ts = Math.floor(Date.now() / 1000), eventId = `evt_${Math.random().toString(16).slice(2)}_x`, secret = SECRET, token = TOKEN, raw } = {}) {
  const rawBody = raw ?? JSON.stringify(payload);
  return sim.handle({ headers: { 'x-settla-timestamp': ts, 'x-settla-signature': hmacSha256(secret, `${ts}.${rawBody}`), 'x-settla-event-id': eventId, 'x-settla-auth': token, 'x-correlation-id': payload?.correlationId ?? '' }, rawBody });
}

describe('n8n contract (executable spec of the workflow)', () => {
  let sim;
  beforeEach(() => { sim = createN8nSimulator({ signingSecret: SECRET, authToken: TOKEN }); });

  it('accepts a valid signed request and returns the structured result with test-only data', () => {
    const r = signed(sim, body());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, caseId: 'CASE-20914', correlationId: 'corr_unit_0001', action: 'investigate_payment', workflow: { name: WORKFLOW_NAME } });
    expect(r.body.result.mode).toBe('test-placeholder');
  });
  it('rejects an invalid signature', () => expect(signed(sim, body(), { secret: 'a-completely-different-secret-value-000000' }).body.error.code).toBe('SIGNATURE_INVALID'));
  it('rejects a tampered body', () => {
    const p = body(); const ts = Math.floor(Date.now() / 1000);
    const r = sim.handle({ headers: { 'x-settla-timestamp': ts, 'x-settla-signature': hmacSha256(SECRET, `${ts}.${JSON.stringify(p)}`), 'x-settla-event-id': 'evt_tamper_01', 'x-settla-auth': TOKEN }, rawBody: JSON.stringify({ ...p, amount: 1 }) });
    expect(r.body.error.code).toBe('SIGNATURE_INVALID');
  });
  it('rejects a missing/wrong transport auth token', () => expect(signed(sim, body(), { token: 'wrong-token-value-wrong-token-value' }).status).toBe(401));
  it('rejects stale and future timestamps', () => {
    expect(signed(sim, body(), { ts: Math.floor(Date.now() / 1000) - 3600 }).body.error.code).toBe('TIMESTAMP_INVALID');
    expect(signed(sim, body(), { ts: Math.floor(Date.now() / 1000) + 3600 }).body.error.code).toBe('TIMESTAMP_INVALID');
  });
  it('replay protection: same event id twice => 409 REPLAYED_EVENT, second never executes', () => {
    expect(signed(sim, body(), { eventId: 'evt_replay_0001' }).status).toBe(200);
    const r = signed(sim, body(), { eventId: 'evt_replay_0001' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('REPLAYED_EVENT');
  });
  it.each([
    ['missing authorization', (b) => { delete b.authorization; return b; }],
    ['authorization.approved false', (b) => { b.authorization.approved = false; return b; }],
    ['unknown field', (b) => ({ ...b, extra: 1 })],
    ['negative amount', (b) => ({ ...b, amount: -5 })],
    ['wrong currency', (b) => ({ ...b, currency: 'USD' })],
    ['bad case id', (b) => ({ ...b, caseId: '../../etc' })],
  ])('invalid payload: %s', (_n, mut) => {
    const r = signed(sim, mut(body()));
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('INVALID_PAYLOAD');
    expect(r.body.success).toBe(false);
    expect(r.body.correlationId).toBeTruthy();
  });
  it.each(['refund', 'create_refund', 'capture_payment', 'initiate_payment', 'payout'])('financial action %s is not executable', (a) => {
    expect(signed(sim, body({ requestedAction: a })).body.error.code).toBe('ACTION_NOT_ALLOWED');
  });
  it('rejects expired backend authorisation', () => {
    const b = body(); b.authorization.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect(signed(sim, b).body.error.code).toBe('AUTHORIZATION_EXPIRED');
  });
  it('does not make policy decisions: a >₹5,000 request with valid authorisation is simply executed', () => {
    expect(signed(sim, body({ amount: 90000 })).status).toBe(200); // n8n has no thresholds; the backend decides before calling
  });
  it('notify action never sends and never carries a phone number', () => {
    const r = signed(sim, body({ requestedAction: 'notify_customer', notification: { template: 'case_closed', recipientRef: 'SETTLA_TEST_WHATSAPP_NUMBER' } }));
    expect(r.body.result.data.dispatched).toBe(false);
    expect(JSON.stringify(r.body)).not.toMatch(/\+?\d{10,}/);
    expect(n8nRequestSchema.safeParse(body({ notification: { template: 'case_closed', recipientRef: '+919226539203' } })).success).toBe(false);
  });
  it('structured errors never leak stack traces or secrets', () => {
    const r = signed(sim, body(), { secret: 'a-completely-different-secret-value-000000' });
    expect(JSON.stringify(r.body)).not.toMatch(/stack| at |SECRET|secret/i);
  });
});

describe('backend decision layer (authoritative over Rhea proposal)', () => {
  const caseDoc = { _id: 'c1', caseNumber: 'CASE-20914', status: 'ESCALATED', amount: 3499 };
  const agent = { permissions: new Set(['automation:dispatch', 'messages:send', 'crm:write', 'tickets:write']) };
  const tenant = { executionMode: 'AUTONOMOUS', status: 'active', limits: { autoExecuteInr: 5000 } };
  const prop = (o = {}) => ({ caseId: 'CASE-20914', decision: 'investigate', action: 'payment_lookup', riskLevel: 'low', requiresHumanApproval: false, ...o });
  const run = (o = {}) => decideAutomation({ proposal: prop(), caseDoc, tenant, actor: agent, payment: { amount: 3499 }, customer: {}, ...o });

  it('allows a clean read-only investigation', () => expect(run().allowed).toBe(true));
  it('rejects malformed proposals', () => {
    expect(run({ proposal: { nope: 1 } }).code).toBe('INVALID_PROPOSAL');
    expect(run({ proposal: { ...prop(), extra: 'x' } }).code).toBe('INVALID_PROPOSAL');
  });
  it('rejects a proposal for another case', () => expect(run({ proposal: prop({ caseId: 'CASE-99999' }) }).code).toBe('CASE_MISMATCH'));
  it('never allows financial actions, however they are phrased', () => {
    expect(run({ proposal: prop({ decision: 'refund', action: 'create_refund' }) }).code).toBe('FINANCIAL_ACTION_NOT_ALLOWED');
    expect(run({ proposal: prop({ action: 'refund' }) }).code).toBe('FINANCIAL_ACTION_NOT_ALLOWED');
  });
  it('rejects non-allow-listed actions', () => expect(run({ proposal: prop({ action: 'drop_database' }) }).code).toBe('ACTION_NOT_ALLOWED'));
  it('amount comes from the payment record, not the proposal', () => {
    const d = run({ payment: { amount: 18750 }, proposal: prop({ action: 'notify_customer', decision: 'notify' }) });
    expect(d.code).toBe('HUMAN_APPROVAL_REQUIRED');
    expect(d.backend.amount).toBe(18750);
  });
  it('proposal claiming low risk / no approval cannot loosen the backend verdict', () => {
    const d = run({ payment: { amount: 18750 }, proposal: prop({ action: 'sync_crm', decision: 'sync', riskLevel: 'low', requiresHumanApproval: false }) });
    expect(d.allowed).toBe(false);
    expect(d.reasons.join(' ')).toMatch(/claimed no approval needed/);
  });
  it('an approved human approval unlocks side effects above the limit', () => {
    const d = run({ payment: { amount: 18750 }, approvedApproval: { _id: 'a1' }, proposal: prop({ action: 'notify_customer', decision: 'notify' }) });
    expect(d.allowed).toBe(true);
    expect(d.humanApprovalSatisfied).toBe(true);
  });
  it('read-only investigation is allowed above the limit', () => expect(run({ payment: { amount: 18750 } }).allowed).toBe(true));
  it('kill switch: RECOMMEND_ONLY blocks side effects, DISABLED blocks everything', () => {
    expect(run({ tenant: { ...tenant, executionMode: 'RECOMMEND_ONLY' }, proposal: prop({ action: 'notify_customer', decision: 'notify' }) }).code).toBe('RECOMMEND_ONLY');
    expect(run({ tenant: { ...tenant, executionMode: 'RECOMMEND_ONLY' } }).allowed).toBe(true);
    expect(run({ tenant: { ...tenant, executionMode: 'DISABLED' } }).code).toBe('EXECUTION_DISABLED');
  });
  it('permissions: missing dispatch or side-effect permission is denied', () => {
    expect(run({ actor: { permissions: new Set() } }).code).toBe('PERMISSION_DENIED');
    expect(run({ actor: { permissions: new Set(['automation:dispatch']) }, proposal: prop({ action: 'notify_customer', decision: 'notify' }) }).code).toBe('PERMISSION_DENIED');
  });
  it('closed cases are refused', () => expect(run({ caseDoc: { ...caseDoc, status: 'CLOSED' } }).code).toBe('CASE_CLOSED'));
  it('Rhea default proposal is read-only and flags approval need from the amount', () => {
    const p = proposeAutomation({ caseNumber: 'CASE-1', amount: 18750, risk: { level: 'HIGH' } }, tenant);
    expect(p).toMatchObject({ action: 'payment_lookup', riskLevel: 'high', requiresHumanApproval: true });
  });
});

describe('PaymentProvider / RazorpayAdapter', () => {
  const t = 'tenant-provider-test';
  const adapters = () => { seedDemoWorld(t); return createMockAdapters(t); };
  it('implements the full interface', () => expect(() => assertPaymentProvider(new RazorpayAdapter(adapters()))).not.toThrow());
  it('fetches payment/order/status through the gateway adapter', async () => {
    const p = new RazorpayAdapter(adapters());
    expect((await p.fetchPayment('pay_Q7xK2')).amount).toBe(3499);
    expect(await p.paymentStatus('pay_Q7xK2')).toBe('captured');
    expect(await p.fetchOrder('pay_Q7xK2')).toBeNull();
  });
  it('refund eligibility is the backend policy verdict (small = autonomous, large = approval)', async () => {
    const p = new RazorpayAdapter(adapters());
    expect(await p.refundEligibility('pay_Q7xK2', 1000)).toMatchObject({ eligible: true, autonomous: true, requiresApproval: false });
    expect(await p.refundEligibility('pay_Q7xK2', 6000)).toMatchObject({ eligible: false });
    expect(await p.refundEligibility('pay_missing')).toMatchObject({ eligible: false, code: 'PAYMENT_NOT_FOUND' });
  });
  it('real refunds are hard-disabled', async () => {
    const a = adapters(); const p = new RazorpayAdapter(a);
    await expect(p.refund({ paymentId: 'pay_Q7xK2', amount: 100 })).rejects.toMatchObject({ code: 'FINANCIAL_WRITES_DISABLED' });
    expect(a.payments).toBeTruthy();
  });
});

describe('Gemini provider', () => {
  it('sends the key in a header (never the URL), requests JSON, and returns the model text', async () => {
    const { geminiProvider, getProvider } = await import('../../src/agents/llm.js');
    const { env } = await import('../../src/config/env.js');
    const original = globalThis.fetch;
    let seen;
    const orig = env.GEMINI_API_KEY;
    // env is frozen: exercise via a temporary fetch stub and a patched copy of the provider call
    globalThis.fetch = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), { status: 200 }); };
    try {
      expect(getProvider('gemini')).toBe(geminiProvider);
      if (!env.GEMINI_API_KEY) {
        await expect(geminiProvider.complete({ system: 's', user: 'u' })).rejects.toThrow(/GEMINI_API_KEY not set/);
      } else {
        const out = await geminiProvider.complete({ system: 's', user: 'u' });
        expect(out).toBe('{"ok":true}');
        expect(seen.url).not.toContain(orig);
        expect(seen.url).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[\w.-]+:generateContent$/);
        expect(seen.init.headers['x-goog-api-key']).toBe(orig);
        expect(JSON.parse(seen.init.body).generationConfig.responseMimeType).toBe('application/json');
      }
    } finally { globalThis.fetch = original; }
  });
  it('unknown provider names fall back to the deterministic mock', async () => {
    const { getProvider, mockProvider } = await import('../../src/agents/llm.js');
    expect(getProvider('does-not-exist')).toBe(mockProvider);
  });
});
