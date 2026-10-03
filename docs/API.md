# API (v1)

Base `/api/v1`. Success `{success:true,data}`; error `{success:false,error:{code,message,requestId,details?}}`. Auth: `Authorization: Bearer <access JWT>`. Machine-readable summary: `GET /api/v1/openapi.json`.

| Method & path | Permission | Notes |
|---|---|---|
| POST /auth/login | – | 10/min/IP (configurable `AUTH_RATE_LIMIT`). Sets httpOnly refresh cookie |
| POST /auth/refresh | – | rotates; reuse ⇒ family revoked. Cookie flow needs `x-requested-with` header |
| POST /auth/logout, GET /auth/me | auth | |
| GET /cases, POST /cases | cases:read / cases:create | filters `status,risk,autonomous,search,customerId`; sort+paginate |
| GET /cases/:id, /cases/:id/timeline | cases:read | full detail incl. events, trace, policy, risk, actions, audit |
| POST /cases/:id/process | cases:update | only for NEW cases |
| GET /payments, /payments/:id | payments:read | detail re-reads the gateway |
| POST /payments/:id/refund | payments:refund | **Idempotency-Key required**; amount ≤ live balance; > ₹5,000 ⇒ 202 approval |
| GET /orders, /orders/:id; /customers, /customers/:id | *:read | |
| GET /approvals; POST /approvals/:id/decision | approvals:read / approvals:approve | approver must also hold the tool permission; no self-approval |
| GET /escalations, /escalations/:id; POST /escalations/:id/actions | escalations:read / escalations:update (refund: payments:refund) | take_over, retry, refund, close |
| GET /decisions, /decisions/:id | cases:read | decision traces |
| GET /policies, /policies/:id | policies:read | |
| GET/PUT /integrations, POST /integrations/:type/test | integrations:read/write | credentials never returned; webhook secret shown once |
| GET /analytics/summary, /analytics/timeseries | analytics:read | |
| GET /audit | audit:read | read-only |
| GET /notifications; POST /notifications/:id/read | auth | |
| GET /tenant; PATCH /tenant/execution-mode | tenant:read / tenant:write | kill switch, audited |
| GET/POST /users; PATCH /users/:id | users:read / users:write | role/status change revokes sessions |
| GET/POST /knowledge; GET /knowledge/search | knowledge:* | |
| POST /demo/run?scenario=recover\|out_of_stock\|high_value\|injection\|human | cases:create | mock integrations, simulated clock |
| GET /stream | auth | SSE: case.event, case.transition, action.state, notification, tenant.mode |
| GET /admin/tenants, PATCH /admin/tenants/:id, GET /admin/system | SUPER_ADMIN | |

## Webhooks
`POST /webhooks/{razorpay|shopify|freshdesk|whatsapp}` headers: `x-settla-key-id`, `x-settla-timestamp` (±300 s), `x-settla-signature` = hex HMAC-SHA256(secret, `"{timestamp}.{rawBody}"`), `x-event-id` (replay-protected). Tenant is derived from the key id. 300/min.

## Error codes (selection)
`VALIDATION_ERROR, UNSAFE_INPUT, UNAUTHORIZED, TOKEN_INVALID, PERMISSION_DENIED, TENANT_DISABLED, IDEMPOTENCY_KEY_REQUIRED, IDEMPOTENCY_KEY_REUSED (422), REFUND_EXCEEDS_BALANCE, POLICY_REJECTED, APPROVER_LACKS_PERMISSION, SELF_APPROVAL, INVALID_TRANSITION, RATE_LIMITED, PAYLOAD_TOO_LARGE, WEBHOOK_*`.
