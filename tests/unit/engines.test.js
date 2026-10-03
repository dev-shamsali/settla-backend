import { describe, it, expect } from 'vitest';
import { evaluatePolicy } from '../../src/policies/policyEngine.js';
import { assessRisk } from '../../src/policies/riskEngine.js';
import { checkPermission, AGENT_PERMISSIONS } from '../../src/policies/permissionEngine.js';
import { caseMachine, actionMachine } from '../../src/domain/stateMachines.js';
import { enforceHardRules } from '../../src/agents/hardRules.js';
import { validatePlan, parsePlanText } from '../../src/agents/planSchema.js';
import { deterministicPlan } from '../../src/agents/llm.js';
import { ROLE_PERMISSIONS, effectivePermissions } from '../../src/security/rbac.js';

const payment = { id: 'pay_1', status: 'captured', amount: 3499, amountRefunded: 0 };
const cart = { items: [{ sku: 'A', qty: 1, price: 3499 }], total: 3499, hash: 'h' };
const base = { payment, cart, inventory: { A: 4 }, existingOrder: null, recentOrders: [], customer: {}, signals: {}, limits: { autoExecuteInr: 5000 } };

describe('policy engine', () => {
  it('recover-order-v2 passes with clean evidence and lists every rule', () => {
    const r = evaluatePolicy('recover-order-v2', base);
    expect(r.passed).toBe(true);
    expect(r.policyVersion).toBe('v2');
    expect(r.evaluatedRules.length).toBeGreaterThanOrEqual(9);
  });
  it.each([
    ['payment not captured', { payment: { ...payment, status: 'failed' } }, 'payment_captured'],
    ['order exists', { existingOrder: { orderNumber: '#1' } }, 'no_existing_order'],
    ['cart mismatch', { cart: { ...cart, total: 100 } }, 'cart_matches_payment'],
    ['no stock', { inventory: { A: 0 } }, 'inventory_available'],
    ['over limit', { payment: { ...payment, amount: 9000 }, cart: { ...cart, total: 9000 } }, 'within_auto_limit'],
    ['blocked customer', { customer: { blocked: true } }, 'customer_not_blocked'],
    ['fraud', { signals: { fraud: true } }, 'no_fraud_signal'],
    ['legal', { signals: { legal: true } }, 'no_legal_chargeback'],
    ['duplicate in 72h', { recentOrders: [{ cartHash: 'h', createdAt: new Date() }] }, 'no_duplicate_72h'],
  ])('recover-order-v2 fails: %s', (_n, patch, ruleId) => {
    const r = evaluatePolicy('recover-order-v2', { ...base, ...patch });
    expect(r.passed).toBe(false);
    expect(r.failedRules).toContain(ruleId);
  });
  it('refund-v1 over auto limit requires approval (not a hard failure)', () => {
    const r = evaluatePolicy('refund-v1', { payment: { ...payment, amount: 18750 }, refundAmount: 18750, signals: {}, limits: { autoExecuteInr: 5000 } });
    expect(r.passed).toBe(false);
    expect(r.requiresApproval).toBe(true);
    expect(r.failedRules).toEqual([]);
  });
  it('refund-v1 blocks refund above refundable balance', () => {
    const r = evaluatePolicy('refund-v1', { payment: { ...payment, amountRefunded: 3000 }, refundAmount: 1000, signals: {}, limits: {} });
    expect(r.failedRules).toContain('refundable_balance');
  });
});

describe('risk engine', () => {
  it('scores the demo case 0.08 LOW', () => {
    const r = assessRisk({ amount: 3499, payment, customer: { paymentsLast24h: 1 }, signals: {} });
    expect(r.riskScore).toBe(0.08);
    expect(r.riskLevel).toBe('LOW');
  });
  it('escalates level with fraud + legal + chargeback and caps at 1', () => {
    const r = assessRisk({ amount: 500000, signals: { fraud: true, legal: true, chargeback: true, injection: true, systemsDisagree: true } });
    expect(r.riskScore).toBeLessThanOrEqual(1);
    expect(r.riskLevel).toBe('CRITICAL');
    expect(r.factors.map((f) => f.name)).toContain('fraud_signal');
  });
});

describe('permission engine', () => {
  const agent = { type: 'agent', permissions: new Set(AGENT_PERMISSIONS), id: 'rhea' };
  it('allows agent order recovery in AUTONOMOUS', () => expect(checkPermission({ actor: agent, tool: 'recover_order', tenant: { executionMode: 'AUTONOMOUS', status: 'active' } }).allowed).toBe(true));
  it('blocks sensitive agent actions in RECOMMEND_ONLY', () => {
    const r = checkPermission({ actor: agent, tool: 'recover_order', tenant: { executionMode: 'RECOMMEND_ONLY' } });
    expect(r.allowed).toBe(false);
    expect(r.recommendOnly).toBe(true);
  });
  it('blocks everything when DISABLED', () => expect(checkPermission({ actor: agent, tool: 'notify_customer', tenant: { executionMode: 'DISABLED' } }).allowed).toBe(false));
  it('refund over limit needs approval unless approved', () => {
    const t = { executionMode: 'AUTONOMOUS', limits: { autoExecuteInr: 5000 } };
    expect(checkPermission({ actor: agent, tool: 'refund_payment', amount: 6000, tenant: t }).requiresApproval).toBe(true);
    expect(checkPermission({ actor: agent, tool: 'refund_payment', amount: 6000, tenant: t, approved: true }).allowed).toBe(true);
  });
  it('rejects non-allow-listed tools', () => expect(checkPermission({ actor: agent, tool: 'wire_transfer', tenant: {} }).allowed).toBe(false));
  it('user without permission denied', () => expect(checkPermission({ actor: { type: 'user', permissions: new Set(['cases:read']) }, tool: 'refund_payment', amount: 10, tenant: {} }).allowed).toBe(false));
});

describe('state machines', () => {
  it('allows the happy path', () => {
    ['OBSERVING', 'INVESTIGATING', 'DECIDING', 'EXECUTING', 'VERIFYING', 'RESOLVED', 'CLOSED'].reduce((from, to) => { caseMachine.assert(from, to); return to; }, 'NEW');
  });
  it.each([['NEW', 'RESOLVED'], ['CLOSED', 'NEW'], ['RESOLVED', 'EXECUTING'], ['REFUNDED', 'DECIDING']])('rejects %s -> %s', (a, b) => {
    expect(() => caseMachine.assert(a, b)).toThrow(/cannot move/);
  });
  it('action machine enforces verify-before-verified and compensation path', () => {
    expect(() => actionMachine.assert('RUNNING', 'VERIFIED')).toThrow();
    ['RUNNING', 'SUCCEEDED', 'VERIFYING', 'FAILED', 'COMPENSATING', 'COMPENSATED'].reduce((f, t) => { actionMachine.assert(f, t); return t; }, 'PENDING');
    expect(actionMachine.isTerminal('VERIFIED')).toBe(true);
  });
});

describe('hard rules + plan schema', () => {
  const ctx = { tenantId: 't', caseId: 'c', payment, cart, signals: {} };
  const plan = deterministicPlan({ caseId: 'c', payment, cart, cartMatchesPayment: true, stockAvailable: true, signals: {} });
  it('deterministic mock plan is schema-valid', () => expect(validatePlan(plan).ok).toBe(true));
  it('derives amount and idempotency key from trusted data, ignoring model values', () => {
    const { plan: out } = enforceHardRules({ ...plan, amount: 999999, idempotency_key: 'attacker-chosen-key' }, ctx);
    expect(out.amount).toBe(3499);
    expect(out.idempotency_key).not.toBe('attacker-chosen-key');
  });
  it('forces escalation below 0.75 confidence', () => {
    const { plan: out, overrides } = enforceHardRules({ ...plan, confidence: 0.6 }, ctx);
    expect(out.decision).toBe('ESCALATE');
    expect(overrides.join()).toContain('low_confidence');
  });
  it.each(['requestsHuman', 'chargeback', 'legal', 'systemsDisagree', 'hostile', 'injection'])('forces escalation on %s', (sig) => {
    expect(enforceHardRules(plan, { ...ctx, signals: { [sig]: true } }).plan.decision).toBe('ESCALATE');
  });
  it('corrects a mismatched tool and clamps refund above balance', () => {
    const refund = { ...plan, decision: 'REFUND', tool: 'recover_order', parameters: { amount: 50000 }, amount: 50000 };
    const { plan: out } = enforceHardRules(refund, ctx);
    expect(out.tool).toBe('refund_payment');
    expect(out.amount).toBe(3499);
  });
  it('rejects malformed / invented tools / extra fields', () => {
    expect(parsePlanText('{"decision":').ok).toBe(false);
    expect(validatePlan({ ...plan, tool: 'rm_rf' }).ok).toBe(false);
    expect(validatePlan({ ...plan, extra: 1 }).ok).toBe(false);
    expect(validatePlan({ ...plan, confidence: 4 }).ok).toBe(false);
  });
});

describe('rbac', () => {
  it('VIEWER cannot refund; FINANCE can', () => {
    expect(ROLE_PERMISSIONS.VIEWER).not.toContain('payments:refund');
    expect(ROLE_PERMISSIONS.FINANCE).toContain('payments:refund');
  });
  it('grants/revocations apply to effective permissions', () => {
    const p = effectivePermissions({ role: 'VIEWER', grantedPermissions: ['audit:read'], revokedPermissions: ['cases:read'] });
    expect(p.has('audit:read')).toBe(true);
    expect(p.has('cases:read')).toBe(false);
  });
});
