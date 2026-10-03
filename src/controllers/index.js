import { col, C } from '../db/mongo.js';
import * as auth from '../services/authService.js';
import * as cases from '../services/caseService.js';
import * as payments from '../services/paymentService.js';
import * as approvals from '../services/approvalService.js';
import * as analytics from '../services/analyticsService.js';
import * as tenants from '../services/tenantService.js';
import * as knowledge from '../services/knowledgeService.js';
import * as demo from '../services/demoService.js';
import { listAudit, countAudit } from '../services/auditService.js';
import { listPolicies } from '../policies/policyEngine.js';
import { repos } from '../repositories/index.js';
import { page } from '../repositories/base.js';
import { processCase } from '../agents/rhea.js';
import { createCase } from '../services/caseService.js';
import { notFound, badRequest, unauthorized, forbidden } from '../lib/errors.js';
import { revokeUserSessions } from '../security/tokens.js';
import { bus } from '../events/bus.js';
import { enqueue } from '../queues/index.js';
import { audit } from '../services/auditService.js';
import { makeCtx, makeClock } from '../lib/context.js';
import { env, isProd } from '../config/env.js';
import { effectivePermissions } from '../security/rbac.js';

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const REFRESH_COOKIE = 'settla_rt';
const cookieOpts = { httpOnly: true, secure: isProd, sameSite: 'strict', path: '/api/v1/auth', maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400_000 };

export const authCtl = {
  async login(req, res) {
    const r = await auth.login(req.body.email, req.body.password);
    res.cookie(REFRESH_COOKIE, r.refreshToken, cookieOpts);
    ok(res, { accessToken: r.accessToken, refreshToken: r.refreshToken, user: r.user, tenant: r.tenant });
  },
  async refresh(req, res) {
    const token = req.body.refreshToken ?? req.cookies?.[REFRESH_COOKIE];
    if (!token) throw unauthorized('Missing refresh token', 'REFRESH_MISSING');
    if (!req.body.refreshToken && req.headers['x-requested-with'] !== 'settla') throw unauthorized('CSRF check failed', 'CSRF_FAILED'); // cookie flow needs custom header
    const r = await auth.refresh(token);
    res.cookie(REFRESH_COOKIE, r.refreshToken, cookieOpts);
    ok(res, r);
  },
  async logout(req, res) {
    await revokeUserSessions(req.user._id);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
    ok(res, { loggedOut: true });
  },
  me: (req, res) => ok(res, { user: auth.publicUser(req.user), tenant: { id: req.ctx.tenant._id, name: req.ctx.tenant.name, executionMode: req.ctx.tenant.executionMode, limits: req.ctx.tenant.limits } }),
};

export const caseCtl = {
  list: async (req, res) => ok(res, await cases.listCases(req.ctx.tenantId, req.query)),
  async create(req, res) {
    const b = req.body;
    const c = await createCase(req.ctx, { ...b, customerMessage: b.customerMessage });
    await audit(req.ctx, { action: 'case.create_api', resourceType: 'case', resourceId: c._id });
    await enqueue('case-processing', 'process', { tenantId: req.ctx.tenantId, caseId: c._id });
    ok(res, c, 201);
  },
  get: async (req, res) => ok(res, await cases.getCaseDetail(req.ctx.tenantId, req.params.id)),
  async timeline(req, res) {
    ok(res, await repos.caseEvents.find(req.ctx.tenantId, { caseId: req.params.id }, { sort: { ts: 1 }, limit: 200 }));
  },
  async process(req, res) {
    const c = await repos.cases.findById(req.ctx.tenantId, req.params.id);
    if (!c) throw notFound('Case not found', 'CASE_NOT_FOUND');
    if (c.status !== 'NEW') throw badRequest(`Case already ${c.status}`, 'CASE_NOT_NEW');
    const ctx = makeCtx({ tenant: req.ctx.tenant, traceId: req.traceId, clock: makeClock({ simulated: c.simulated }) });
    ok(res, await processCase(ctx, c._id));
  },
};

export const paymentCtl = {
  list: async (req, res) => ok(res, await payments.listPayments(req.ctx.tenantId, req.query)),
  get: async (req, res) => ok(res, await payments.getPaymentDetail(req.ctx, req.params.id)),
  async refund(req, res) {
    const r = await payments.requestRefund(req.ctx, req.params.id, req.body, req.headers['idempotency-key']);
    ok(res, r, r.status === 'APPROVAL_REQUIRED' ? 202 : 200);
  },
};

export const listCtl = (repoName, filterFn = () => ({})) => async (req, res) => ok(res, await page(repos[repoName], req.ctx.tenantId, filterFn(req), req.query));
export const getCtl = (repoName, label) => async (req, res) => {
  const d = await repos[repoName].findById(req.ctx.tenantId, req.params.id);
  if (!d) throw notFound(`${label} not found`, `${label.toUpperCase()}_NOT_FOUND`);
  ok(res, d);
};

export const customerCtl = {
  async get(req, res) {
    const c = await repos.customers.findById(req.ctx.tenantId, req.params.id);
    if (!c) throw notFound('Customer not found', 'CUSTOMER_NOT_FOUND');
    const [payments_, cases_, orders] = await Promise.all([
      repos.payments.find(req.ctx.tenantId, { customerId: c._id }, { limit: 20 }), repos.cases.find(req.ctx.tenantId, { customerId: c._id }, { limit: 20 }), repos.orders.find(req.ctx.tenantId, { customerId: c._id }, { limit: 20 }),
    ]);
    ok(res, { customer: c, payments: payments_, cases: cases_, orders });
  },
};

export const approvalCtl = {
  list: async (req, res) => ok(res, await approvals.listApprovals(req.ctx.tenantId, req.query)),
  async decide(req, res) {
    ok(res, await approvals.decideApproval(req.ctx, req.params.id, req.body));
  },
};

export const escalationCtl = {
  async action(req, res) {
    const needs = { refund: 'payments:refund', close: 'escalations:update', take_over: 'escalations:update', retry: 'escalations:update' }[req.body.action];
    if (!req.permissions.has(needs)) throw forbidden(`Missing permission: ${needs}`, 'PERMISSION_DENIED');
    ok(res, await approvals.escalationAction(req.ctx, req.params.id, req.body));
  },
};

export const decisionCtl = {
  list: listCtl('decisionTraces'),
  async get(req, res) {
    const t = await repos.decisionTraces.findById(req.ctx.tenantId, req.params.id);
    if (!t) throw notFound('Trace not found', 'TRACE_NOT_FOUND');
    const decision = await repos.decisions.findById(req.ctx.tenantId, t.decisionId);
    ok(res, { trace: t, decision });
  },
};

export const policyCtl = {
  list: async (req, res) => ok(res, listPolicies()),
  get: async (req, res) => {
    const p = listPolicies().find((x) => x.id === req.params.id);
    if (!p) throw notFound('Policy not found', 'POLICY_NOT_FOUND');
    ok(res, { ...p, evaluations: await repos.policyEvaluations.find(req.ctx.tenantId, { policy: p.id }, { limit: 20 }) });
  },
};

export const integrationCtl = {
  list: async (req, res) => ok(res, await tenants.listIntegrations(req.ctx.tenantId)),
  put: async (req, res) => ok(res, await tenants.putIntegration(req.ctx, req.params.type, req.body)),
  test: async (req, res) => ok(res, await tenants.testIntegration(req.ctx, req.params.type)),
};

export const analyticsCtl = {
  summary: async (req, res) => ok(res, await analytics.summary(req.ctx.tenantId, req.query)),
  timeseries: async (req, res) => ok(res, await analytics.timeseries(req.ctx.tenantId, req.query)),
};

export const auditCtl = {
  async list(req, res) {
    const { page: p = 1, pageSize = 50, resourceType, resourceId, action } = req.query;
    const filter = { ...(resourceType && { resourceType }), ...(resourceId && { resourceId }), ...(action && { action }) };
    const items = await listAudit(req.ctx.tenantId, filter, { skip: (p - 1) * pageSize, limit: pageSize });
    ok(res, { items, page: p, pageSize, total: await countAudit(req.ctx.tenantId, filter) });
  },
};

export const notificationCtl = {
  list: listCtl('notifications'),
  async read(req, res) {
    await repos.notifications.update(req.ctx.tenantId, req.params.id, { read: true });
    ok(res, { read: true });
  },
};

export const tenantCtl = {
  get: (req, res) => { const t = req.ctx.tenant; ok(res, { id: t._id, name: t.name, slug: t.slug, status: t.status, executionMode: t.executionMode, limits: t.limits, integrationMode: t.integrationMode ?? env.INTEGRATION_MODE }); },
  async setMode(req, res) {
    const t = await tenants.setExecutionMode(req.ctx, req.body.mode, req.body.reason);
    ok(res, { executionMode: t.executionMode });
  },
};

export const userCtl = {
  async list(req, res) {
    const users = await col(C.users).find({ tenantId: req.ctx.tenantId }, { projection: { passwordHash: 0 } }).limit(200).toArray();
    ok(res, users.map((u) => ({ id: u._id, email: u.email, name: u.name, role: u.role, status: u.status, lastLoginAt: u.lastLoginAt, permissions: [...effectivePermissions(u)] })));
  },
  async create(req, res) {
    const u = await auth.createUser({ tenantId: req.ctx.tenantId, ...req.body });
    await audit(req.ctx, { action: 'user.create', resourceType: 'user', resourceId: u._id, after: { email: u.email, role: u.role } });
    ok(res, auth.publicUser(u), 201);
  },
  async patch(req, res) {
    const before = await col(C.users).findOne({ _id: req.params.id, tenantId: req.ctx.tenantId });
    if (!before) throw notFound('User not found', 'USER_NOT_FOUND');
    if (before.role === 'SUPER_ADMIN') throw badRequest('Cannot modify super admin', 'IMMUTABLE');
    const u = await auth.setUserAccess(req.ctx.tenantId, req.params.id, req.body);
    await audit(req.ctx, { action: 'user.update', resourceType: 'user', resourceId: u._id, before: { role: before.role, status: before.status }, after: req.body });
    ok(res, auth.publicUser(u));
  },
};

export const knowledgeCtl = {
  list: async (req, res) => ok(res, (await repos.knowledge.find(req.ctx.tenantId, {}, { limit: 100, projection: { chunks: 0 } }))),
  add: async (req, res) => ok(res, await knowledge.addDocument(req.ctx.tenantId, req.body, req.user._id).then((d) => ({ id: d._id, title: d.title })), 201),
  search: async (req, res) => ok(res, await knowledge.searchKnowledge(req.ctx.tenantId, req.query.q)),
};

export const demoCtl = {
  async run(req, res) {
    await demo.seedKnowledge(req.ctx.tenantId);
    ok(res, await demo.runDemoCase(req.ctx, { scenario: req.query.scenario }));
  },
  async reset(req, res) { await demo.resetDemo(req.ctx); ok(res, { reset: true }); },
};

export const adminCtl = {
  async tenants(req, res) { ok(res, (await col(C.tenants).find({}).limit(200).toArray()).map((t) => ({ id: t._id, name: t.name, slug: t.slug, status: t.status, executionMode: t.executionMode }))); },
  async setTenantStatus(req, res) {
    const t = await col(C.tenants).findOneAndUpdate({ _id: req.params.id }, { $set: { status: req.body.status } }, { returnDocument: 'after' });
    if (!t) throw notFound('Tenant not found');
    await audit({ ...req.ctx, tenantId: t._id }, { action: 'admin.tenant_status', resourceType: 'tenant', resourceId: t._id, after: { status: req.body.status }, meta: { by: req.user._id } });
    ok(res, { id: t._id, status: t.status });
  },
  async system(req, res) {
    const db = col(C.cases).s?.db;
    ok(res, { uptime: process.uptime(), node: process.version, mode: env.INTEGRATION_MODE, llm: env.LLM_PROVIDER, redis: !!env.REDIS_URL, db: db ? 'connected' : 'unknown', memoryMb: Math.round(process.memoryUsage().rss / 1e6) });
  },
};

export function stream(req, res) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(`event: ready\ndata: {"tenant":"${req.ctx.tenantId}"}\n\n`);
  const off = bus.subscribe(req.ctx.tenantId, (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { off(); clearInterval(ping); });
}

export const healthCtl = async (req, res) => {
  let dbOk = false;
  try { await col(C.tenants).findOne({}, { projection: { _id: 1 } }); dbOk = true; } catch { /* reported below */ }
  res.status(dbOk ? 200 : 503).json({ status: dbOk ? 'ok' : 'degraded', db: dbOk, uptime: Math.round(process.uptime()) });
};
