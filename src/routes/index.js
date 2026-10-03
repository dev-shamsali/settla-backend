import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission as P, requireSuperAdmin, validate, asyncH as h, authLimiter, webhookLimiter } from '../middlewares/index.js';
import { v } from '../validators/index.js';
import * as K from '../controllers/index.js';
import { authenticateWebhook, handleRazorpay, handleInboundMessage } from '../services/webhookService.js';
import { enqueue } from '../queues/index.js';
import { logger } from '../lib/logger.js';

export function apiRouter({ authLimit = 10 } = {}) {
  const r = Router();

  r.post('/auth/login', authLimiter(authLimit), validate({ body: v.login }), h(K.authCtl.login));
  r.post('/auth/refresh', authLimiter(authLimit * 3), validate({ body: v.refresh }), h(K.authCtl.refresh));

  r.use(authenticate);
  r.post('/auth/logout', h(K.authCtl.logout));
  r.get('/auth/me', K.authCtl.me);
  r.get('/stream', K.stream);

  r.get('/cases', P('cases:read'), validate({ query: v.listCases }), h(K.caseCtl.list));
  r.post('/cases', P('cases:create'), validate({ body: v.createCase }), h(K.caseCtl.create));
  r.get('/cases/:id', P('cases:read'), validate({ params: v.idParam }), h(K.caseCtl.get));
  r.get('/cases/:id/timeline', P('cases:read'), validate({ params: v.idParam }), h(K.caseCtl.timeline));
  r.post('/cases/:id/process', P('cases:update'), validate({ params: v.idParam }), h(K.caseCtl.process));

  r.get('/cases/:id/automation', P('automation:read'), validate({ params: v.idParam }), h(K.automationCtl.list));
  r.get('/cases/:id/automation/proposal', P('automation:read'), validate({ params: v.idParam }), h(K.automationCtl.proposal));
  r.post('/cases/:id/automation', P('automation:dispatch'), validate({ params: v.idParam, body: v.automationDispatch }), h(K.automationCtl.dispatch));

  r.get('/payments', P('payments:read'), validate({ query: v.listGeneric }), h(K.paymentCtl.list));
  r.get('/payments/:id', P('payments:read'), validate({ params: z.object({ id: z.string().regex(/^[\w-]{3,64}$/) }) }), h(K.paymentCtl.get));
  r.post('/payments/:id/refund', P('payments:refund'), validate({ params: z.object({ id: z.string().regex(/^[\w-]{3,64}$/) }), body: v.refund }), h(K.paymentCtl.refund));

  r.get('/orders', P('orders:read'), validate({ query: v.listGeneric }), h(K.listCtl('orders')));
  r.get('/orders/:id', P('orders:read'), validate({ params: v.idParam }), h(K.getCtl('orders', 'Order')));

  r.get('/customers', P('customers:read'), validate({ query: v.listGeneric }), h(K.listCtl('customers')));
  r.get('/customers/:id', P('customers:read'), validate({ params: v.idParam }), h(K.customerCtl.get));

  r.get('/escalations', P('escalations:read'), validate({ query: v.listGeneric }), h(K.listCtl('escalations', (q) => (q.query.status ? { status: q.query.status } : {}))));
  r.get('/escalations/:id', P('escalations:read'), validate({ params: v.idParam }), h(K.getCtl('escalations', 'Escalation')));
  r.post('/escalations/:id/actions', validate({ params: v.idParam, body: v.escalationAction }), h(K.escalationCtl.action));

  r.get('/approvals', P('approvals:read'), validate({ query: v.listGeneric }), h(K.approvalCtl.list));
  r.post('/approvals/:id/decision', P('approvals:approve'), validate({ params: v.idParam, body: v.approvalDecision }), h(K.approvalCtl.decide));

  r.get('/decisions', P('cases:read'), validate({ query: v.listGeneric }), h(K.decisionCtl.list));
  r.get('/decisions/:id', P('cases:read'), validate({ params: v.idParam }), h(K.decisionCtl.get));

  r.get('/policies', P('policies:read'), h(K.policyCtl.list));
  r.get('/policies/:id', P('policies:read'), h(K.policyCtl.get));

  r.get('/integrations', P('integrations:read'), h(K.integrationCtl.list));
  r.put('/integrations/:type', P('integrations:write'), validate({ params: v.integrationParam, body: v.integrationPut }), h(K.integrationCtl.put));
  r.post('/integrations/:type/test', P('integrations:write'), validate({ params: v.integrationParam }), h(K.integrationCtl.test));

  r.get('/analytics/summary', P('analytics:read'), validate({ query: v.analytics }), h(K.analyticsCtl.summary));
  r.get('/analytics/timeseries', P('analytics:read'), validate({ query: v.analytics }), h(K.analyticsCtl.timeseries));

  r.get('/audit', P('audit:read'), validate({ query: v.auditQ }), h(K.auditCtl.list));

  r.get('/notifications', validate({ query: v.listGeneric }), h(K.notificationCtl.list));
  r.post('/notifications/:id/read', validate({ params: v.idParam }), h(K.notificationCtl.read));

  r.get('/tenant', P('tenant:read'), K.tenantCtl.get);
  r.patch('/tenant/execution-mode', P('tenant:write'), validate({ body: v.executionMode }), h(K.tenantCtl.setMode));

  r.get('/users', P('users:read'), h(K.userCtl.list));
  r.post('/users', P('users:write'), validate({ body: v.createUser }), h(K.userCtl.create));
  r.patch('/users/:id', P('users:write'), validate({ params: v.idParam, body: v.patchUser }), h(K.userCtl.patch));

  r.get('/knowledge', P('knowledge:read'), h(K.knowledgeCtl.list));
  r.post('/knowledge', P('knowledge:write'), validate({ body: v.knowledge }), h(K.knowledgeCtl.add));
  r.get('/knowledge/search', P('knowledge:read'), validate({ query: v.knowledgeSearch }), h(K.knowledgeCtl.search));

  r.post('/demo/run', P('cases:create'), validate({ query: z.object({ scenario: z.enum(['recover', 'out_of_stock', 'high_value', 'injection', 'human']).optional() }).strict() }), h(K.demoCtl.run));
  r.post('/demo/reset', P('cases:create'), h(K.demoCtl.reset));

  r.get('/admin/tenants', requireSuperAdmin, P('admin:tenants'), h(K.adminCtl.tenants));
  r.patch('/admin/tenants/:id', requireSuperAdmin, P('admin:tenants'), validate({ params: v.idParam, body: z.object({ status: z.enum(['active', 'disabled']) }).strict() }), h(K.adminCtl.setTenantStatus));
  r.get('/admin/system', requireSuperAdmin, P('admin:system'), h(K.adminCtl.system));
  return r;
}

export function webhookRouter() {
  const r = Router();
  r.use(webhookLimiter(300));
  const handler = (type, fn) => async (req, res, next) => {
    try {
      const { tenant, replay } = await authenticateWebhook(type, req);
      if (replay) return res.status(200).json({ success: true, data: { accepted: true, replay: true } });
      const out = await fn(tenant, req.body, req.traceId);
      logger.info({ type, tenant: tenant._id, requestId: req.id }, 'webhook accepted');
      res.status(202).json({ success: true, data: out });
    } catch (e) { next(e); }
  };
  r.post('/razorpay', handler('razorpay', handleRazorpay));
  r.post('/shopify', handler('shopify', async (t) => ({ accepted: true, tenant: t._id })));
  r.post('/freshdesk', handler('freshdesk', (t, b, tr) => handleInboundMessage(t, 'freshdesk', b, tr)));
  r.post('/whatsapp', handler('whatsapp', (t, b, tr) => handleInboundMessage(t, 'whatsapp', b, tr)));
  return r;
}
export { enqueue };
