const sec = [{ bearerAuth: [] }];
const op = (summary, permission, extra = {}) => ({ summary, security: sec, 'x-permission': permission, responses: { 200: { description: 'OK' }, 401: { description: 'Unauthenticated' }, 403: { description: 'Forbidden' } }, ...extra });
const idem = { parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 } }] };

export const openapi = {
  openapi: '3.0.3',
  info: { title: 'Settla API', version: '1.0.0', description: 'Rhea autonomous payment resolution. All success bodies: {success:true,data}. Errors: {success:false,error:{code,message,requestId}}.' },
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
  paths: {
    '/api/v1/auth/login': { post: { summary: 'Login (rate limit 10/min)', responses: { 200: { description: 'tokens' }, 401: { description: 'INVALID_CREDENTIALS' } } } },
    '/api/v1/auth/refresh': { post: { summary: 'Rotate refresh token (reuse revokes family)', responses: { 200: { description: 'tokens' } } } },
    '/api/v1/auth/me': { get: op('Current user + tenant', 'authenticated') },
    '/api/v1/cases': { get: op('List cases (filter/sort/paginate)', 'cases:read'), post: op('Create case and queue Rhea', 'cases:create') },
    '/api/v1/cases/{id}': { get: op('Case detail (timeline, trace, policy, risk, actions, audit)', 'cases:read') },
    '/api/v1/payments': { get: op('List payments', 'payments:read') },
    '/api/v1/payments/{id}': { get: op('Payment (authoritative from gateway)', 'payments:read') },
    '/api/v1/payments/{id}/refund': { post: op('Refund. Amount re-derived from gateway; >₹5,000 => 202 approval', 'payments:refund', idem) },
    '/api/v1/orders': { get: op('List orders', 'orders:read') },
    '/api/v1/customers': { get: op('List customers', 'customers:read') },
    '/api/v1/escalations': { get: op('List escalations', 'escalations:read') },
    '/api/v1/escalations/{id}/actions': { post: op('take_over | retry | refund | close', 'escalations:update / payments:refund') },
    '/api/v1/approvals': { get: op('Approval queue', 'approvals:read') },
    '/api/v1/approvals/{id}/decision': { post: op('approve | reject (approver also needs tool permission)', 'approvals:approve') },
    '/api/v1/decisions': { get: op('Decision traces', 'cases:read') },
    '/api/v1/policies': { get: op('Versioned policies', 'policies:read') },
    '/api/v1/integrations': { get: op('Integrations (credentials never returned)', 'integrations:read') },
    '/api/v1/analytics/summary': { get: op('KPI summary', 'analytics:read') },
    '/api/v1/audit': { get: op('Append-only audit log', 'audit:read') },
    '/api/v1/tenant/execution-mode': { patch: op('Kill switch: AUTONOMOUS | RECOMMEND_ONLY | DISABLED', 'tenant:write') },
    '/api/v1/stream': { get: op('Server-sent events: case.event, case.transition, action.state, notification', 'authenticated') },
    '/api/v1/demo/run': { post: op('Run deterministic UrbanStep demo (mock integrations)', 'cases:create') },
    '/webhooks/{source}': { post: { summary: 'razorpay|shopify|freshdesk|whatsapp. Headers: x-settla-key-id, x-settla-timestamp, x-settla-signature (HMAC-SHA256 of "{ts}.{rawBody}"), x-event-id. 300s tolerance, replay-protected.', responses: { 202: { description: 'accepted' }, 401: { description: 'bad signature/timestamp' } } } },
  },
};
