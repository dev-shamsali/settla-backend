import { randomUUID } from 'node:crypto';
import { col, C } from '../db/mongo.js';
import { repos } from '../repositories/index.js';
import { audit } from './auditService.js';
import { encrypt, decrypt, randomToken, sha256 } from '../lib/crypto.js';
import { createUser } from './authService.js';
import { listPolicies, POLICIES } from '../policies/policyEngine.js';
import { notFound } from '../lib/errors.js';
import { bus } from '../events/bus.js';
import { ROLES } from '../security/rbac.js';

export async function createTenant({ name, slug, integrationMode, limits }) {
  const doc = {
    _id: randomUUID(), name, slug, status: 'active', executionMode: 'AUTONOMOUS', integrationMode, limits: { autoExecuteInr: 5000, ...limits }, caseCounter: 0, createdAt: new Date(),
  };
  await col(C.tenants).insertOne(doc);
  for (const [id, p] of Object.entries(POLICIES)) {
    await repos.policies.insert(doc._id, { key: p.key, version: p.version, policyId: id, description: p.description, rules: listPolicies().find((x) => x.id === id).rules, active: true });
  }
  return doc;
}

export async function createTenantWithUsers(opts, password) {
  const tenant = await createTenant(opts);
  const users = {};
  for (const role of ROLES.filter((r) => r !== 'SUPER_ADMIN')) {
    users[role] = await createUser({ tenantId: tenant._id, email: `${role.toLowerCase()}@${opts.slug}.test`, name: role.replace('_', ' '), password, role });
  }
  return { tenant, users };
}

export async function setExecutionMode(ctx, mode, reason) {
  const before = ctx.tenant.executionMode;
  const t = await col(C.tenants).findOneAndUpdate({ _id: ctx.tenantId }, { $set: { executionMode: mode, executionModeReason: reason, executionModeChangedBy: ctx.actor.id, executionModeChangedAt: new Date() } }, { returnDocument: 'after' });
  await audit(ctx, { action: 'tenant.execution_mode', resourceType: 'tenant', resourceId: ctx.tenantId, before: { mode: before }, after: { mode }, meta: { reason } });
  bus.publish(ctx.tenantId, { type: 'tenant.mode', mode });
  return t;
}

export async function listIntegrations(tenantId) {
  const rows = await repos.integrations.find(tenantId, {}, { limit: 50 });
  return rows.map((r) => ({ type: r.type, enabled: r.enabled, mode: r.mode, configured: !!r.credentialsEnc, keyId: r.keyId, updatedAt: r.updatedAt, lastTest: r.lastTest }));
}

export async function putIntegration(ctx, type, { credentials, mode, enabled }) {
  const existing = await repos.integrations.findOne(ctx.tenantId, { type });
  const set = { type, enabled: enabled ?? existing?.enabled ?? true, mode: mode ?? existing?.mode ?? 'mock' };
  if (credentials) set.credentialsEnc = encrypt(credentials);
  let webhookSecret;
  if (!existing?.keyId) {
    set.keyId = `wk_${randomToken(8)}`;
    webhookSecret = randomToken(24);
    set.webhookSecretEnc = encrypt(webhookSecret);
  }
  await repos.integrations.upsert(ctx.tenantId, { type }, set);
  await audit(ctx, { action: 'integration.update', resourceType: 'integration', resourceId: type, after: { type, mode: set.mode, enabled: set.enabled, credentialsChanged: !!credentials } });
  return { type, ...(webhookSecret ? { keyId: set.keyId, webhookSecret } : {}) };
}

export async function getCredentials(tenantId, type) {
  const r = await repos.integrations.findOne(tenantId, { type });
  return r?.credentialsEnc ? decrypt(r.credentialsEnc) : {};
}

/** Webhook tenant resolution: keyId -> integration -> tenant. Tenant never comes from the payload. */
export async function resolveWebhookIntegration(type, keyId) {
  if (!keyId) return null;
  const r = await col(C.integrations).findOne({ type, keyId });
  if (!r || r.enabled === false) return null;
  const tenant = await col(C.tenants).findOne({ _id: r.tenantId });
  if (!tenant || tenant.status !== 'active') return null;
  return { tenant, secret: decrypt(r.webhookSecretEnc) };
}

export async function testIntegration(ctx, type) {
  const probes = {
    razorpay: () => ctx.adapters.payments.findPayment({ reference: 'pay_healthcheck' }),
    shopify: () => ctx.adapters.orders.getInventory([]),
    freshdesk: () => ctx.adapters.ticketing.findTicket('0'),
    hubspot: () => ctx.adapters.crm.findCustomer({ email: 'healthcheck@example.test' }),
    whatsapp: () => Promise.resolve({ ok: true }),
    slack: () => Promise.resolve({ ok: true }),
    email: () => Promise.resolve({ ok: true }),
  };
  let result;
  try { await probes[type](); result = { ok: true, at: new Date() }; } catch (e) { result = { ok: false, code: e.code, message: e.message, at: new Date() }; }
  await repos.integrations.upsert(ctx.tenantId, { type }, { lastTest: result });
  return result;
}

export const requireTenant = async (id) => {
  const t = await col(C.tenants).findOne({ _id: id });
  if (!t) throw notFound('Tenant not found');
  return t;
};
export { sha256 };
