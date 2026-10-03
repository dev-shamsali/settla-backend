import { randomUUID } from 'node:crypto';
import { timeoutErr, rateErr, failErr } from '../errors.js';

/**
 * Deterministic in-memory third-party world, partitioned by tenant.
 * Faults: timeout | failure | rate_limit | duplicate | verification_mismatch
 */
const worlds = new Map();

export const EMPTY = () => ({
  payments: new Map(), refunds: new Map(), orders: new Map(), tickets: new Map(), customers: new Map(),
  inventory: {}, outbox: [], escalationPosts: [], crmWrites: [], faults: [], calls: [],
});

export const getWorld = (tenantId) => {
  if (!worlds.has(tenantId)) worlds.set(tenantId, EMPTY());
  return worlds.get(tenantId);
};
export const resetWorld = (tenantId) => worlds.set(tenantId, EMPTY());

export function injectFault(tenantId, { system, method, kind, times = 1 }) {
  getWorld(tenantId).faults.push({ system, method, kind, times });
}

/** Called at top of every mock method. Returns the 'soft' fault kind for non-throwing faults. */
export function checkFault(tenantId, system, method) {
  const w = getWorld(tenantId);
  w.calls.push({ system, method, at: Date.now() });
  const f = w.faults.find((x) => x.system === system && x.method === method && x.times > 0);
  if (!f) return null;
  f.times -= 1;
  if (f.kind === 'timeout') throw timeoutErr(system);
  if (f.kind === 'rate_limit') throw rateErr(system);
  if (f.kind === 'failure') throw failErr(system);
  return f.kind;
}

export const callCount = (tenantId, system, method) =>
  getWorld(tenantId).calls.filter((c) => c.system === system && (!method || c.method === method)).length;

export const newId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;

export function seedDemoWorld(tenantId, overrides = {}) {
  const w = resetWorld(tenantId) && getWorld(tenantId);
  const cart = { items: [{ sku: 'URB-SNK-8', name: 'UrbanStep Runner (Size 8)', qty: 1, price: 3499 }], total: 3499 };
  const customer = { id: 'cus_ananya', name: 'Ananya', email: 'ananya@example.test', phone: '+919800000001', blocked: false, demo: true };
  w.customers.set(customer.id, customer);
  w.payments.set('pay_Q7xK2', {
    id: 'pay_Q7xK2', status: 'captured', amount: 3499, currency: 'INR', amountRefunded: 0, email: customer.email,
    contact: customer.phone, createdAt: new Date().toISOString(), cart, demo: true, ...overrides.payment,
  });
  w.inventory = { 'URB-SNK-8': 4, ...overrides.inventory };
  w.tickets.set('FD-1001', { id: 'FD-1001', status: 'open', subject: 'Money debited, no order', customerId: customer.id, notes: [], demo: true });
  return w;
}
