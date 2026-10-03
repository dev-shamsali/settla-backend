# n8n integration layer

**Rule:** the Settla backend is authoritative. n8n is an executor of backend-approved, non-financial integration steps. n8n never decides refund eligibility, risk, approval, capture or refund, and it holds no business data (MongoDB is the source of truth).

```
Frontend → Backend (auth · RBAC · policy · risk · idempotency · verification · audit) → Rhea proposal
        → backend decision gate → signed request → n8n "SETTLA - PAYMENT RESOLUTION" → structured result
        → backend verifies response → automation_runs + audit_logs + case event (MongoDB)
```

## Workflow
**SETTLA - PAYMENT RESOLUTION** — n8n workflow id `OegVTXtJIYo5upSV`, **inactive**, personal project. Nodes: `Webhook` (POST `settla/payment-resolution`, Header Auth, responseMode=responseNode) → `Validate request` (Code) → `Request valid?` (IF) → true: `Extract case information` → `Perform approved integration action` (test placeholders) → `Respond success`; false: `Respond error`.
`SETTLA - MCP CONNECTION TEST` (`XD8RbMiCXut5puor`) is separate and untouched.

Before activation an operator must create the n8n credential **"Settla Webhook Header Auth"** (header `x-settla-auth`, value = backend `N8N_WEBHOOK_AUTH_TOKEN`). No secret is stored in any workflow node.

## Backend API
- `GET /api/v1/cases/:id/automation/proposal` (`automation:read`) — Rhea proposal plus the backend verdict.
- `POST /api/v1/cases/:id/automation` (`automation:dispatch`, **Idempotency-Key required**) body `{ "proposal": {...} }`.
- `GET /api/v1/cases/:id/automation` (`automation:read`) — audit view of runs.

### Rhea proposal (untrusted input)
```json
{ "caseId": "CASE-20914", "decision": "investigate", "action": "payment_lookup", "riskLevel": "low", "requiresHumanApproval": false }
```
Strict schema. The backend recomputes amount (from the payment record), risk and approval requirement; the proposal may only be tightened, never loosened.

### Backend decision rules (`src/agents/automationProposal.js`)
Allowed actions: read-only `investigate_payment`, `payment_lookup`, `order_lookup`; side effects `notify_customer`, `sync_crm`, `update_ticket`. Financial actions (`refund`, `create_refund`, `capture_payment`, `initiate_payment`, instant settlement, payout) are **always refused** (403 `FINANCIAL_ACTION_NOT_ALLOWED`). Also enforced: case match, tenant `executionMode` (RECOMMEND_ONLY ⇒ read-only only; DISABLED ⇒ none), RBAC (`automation:dispatch` + `messages:send` / `crm:write` / `tickets:write` per action), risk CRITICAL ⇒ read-only only, and **amount > ₹5,000 ⇒ side-effect actions need an APPROVED human approval** (409 `HUMAN_APPROVAL_REQUIRED`). Read-only investigation is always allowed.

## Webhook contract (backend → n8n)
Headers: `x-settla-timestamp` (unix s, ±300 s) · `x-settla-signature` = hex HMAC-SHA256(`N8N_SIGNING_SECRET`, `"{timestamp}.{rawBody}"`) · `x-settla-event-id` (stable per idempotency key) · `x-correlation-id` · `x-settla-auth` (transport token).

Request body (strict, no extra fields, no phone numbers, no secrets):
```json
{ "correlationId": "corr_…", "caseId": "CASE-20914", "customerId": "…", "paymentId": "pay_Q7xK2", "orderId": "…|null",
  "amount": 3499, "currency": "INR", "issue": "Money debited but no order", "requestedAction": "payment_lookup",
  "authorization": { "approved": true, "decisionId": "…", "policyVersion": "v2", "riskLevel": "LOW", "humanApprovalSatisfied": false, "approvalId": null, "expiresAt": "ISO-8601 (5 min)" },
  "notification": { "template": "case_closed", "recipientRef": "SETTLA_TEST_WHATSAPP_NUMBER" } }
```
Success `200`: `{ success:true, caseId, correlationId, action, signatureVerified, workflow:{name,executionId}, result:{externalService, mode:"test-placeholder", data} }`.
Failure: `{ "success": false, "caseId": "…", "correlationId": "…", "error": { "code": "…", "message": "…" } }` — codes `UNAUTHORIZED 401, TIMESTAMP_INVALID 401, SIGNATURE_INVALID 401, EVENT_ID_MISSING 400, CORRELATION_MISMATCH 400, REPLAYED_EVENT 409, ACTION_NOT_ALLOWED 422, INVALID_PAYLOAD 422, AUTHORIZATION_EXPIRED 422, WORKFLOW_ERROR 500`. No stack traces or secrets.

## Security properties
- **Signing** (backend client `src/integrations/n8n/client.js`; verified by the contract simulator and, when the secret is provisioned, by the workflow).
- **Timestamp validation** ±300 s, **replay protection**: backend idempotency store (authoritative) + n8n event-id cache (best effort) + backend event id derived from the idempotency key.
- **Idempotency**: `Idempotency-Key` ⇒ exactly-once per (tenant, action, key); same key + different body ⇒ 422; replay returns the stored result without calling n8n.
- **Transport auth** via n8n Header Auth credential; HTTPS-only, host allow-list (`N8N_ALLOWED_HOSTS`), no redirects, 15 s timeout, bounded retries for retryable failures only.
- **Response verification**: schema, `success`, `correlationId`, `caseId`, `action`, workflow name must match; otherwise `VERIFICATION_FAILED` / 502.
- **WhatsApp**: only the *reference name* `SETTLA_TEST_WHATSAPP_NUMBER` ever travels; the number is resolved inside n8n from its own configuration. Nothing is sent: the notify branch returns `dispatched:false`.

## Audit (MongoDB `automation_runs`, `audit_logs`, `case_events`)
Per run: `caseId, caseNumber, correlationId, requestedAction, actor, actorType, rheaProposal, backendDecision{allowed,code,reasons,backend{amount,riskLevel,requiresApproval}}, workflow{name}, n8nExecutionId, externalService, status, verification{checks}, request, error, idempotencyKey (hashed), traceId, createdAt, finishedAt`. Blocked attempts are recorded too. Secrets and raw signatures are never stored (only a 8-char signature prefix is kept in memory for diagnostics).

## Payment provider abstraction
`src/integrations/payments/paymentProvider.js`: `PaymentProvider` (`fetchPayment, fetchOrder, paymentStatus, refundEligibility, refund, refundStatus`) implemented by `RazorpayAdapter`. `refundEligibility` delegates to the backend policy engine; `refund()` is **hard-disabled** (`FINANCIAL_WRITES_DISABLED`) in this phase. Razorpay MCP is not installed.

## Environment (names only)
`N8N_MODE` (mock|live), `N8N_WEBHOOK_URL`, `N8N_SIGNING_SECRET` (≥32 chars), `N8N_WEBHOOK_AUTH_TOKEN`, `N8N_ALLOWED_HOSTS`, `SETTLA_TEST_WHATSAPP_NUMBER` (resolved in n8n only).

## Known limits
- n8n Cloud may block `$env`; HMAC verification inside the workflow runs only if `SETTLA_N8N_SIGNING_SECRET` is readable there (otherwise `signatureVerified:false` and Header Auth is the gate). The backend contract simulator enforces signatures strictly and is what the automated tests exercise.
- n8n's replay cache lives in workflow static data (production executions only); the backend store is the authoritative control.
- The workflow has not been activated or called over real HTTP.
