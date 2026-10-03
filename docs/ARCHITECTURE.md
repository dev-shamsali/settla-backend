# Settla architecture

Principle: **the LLM proposes. Rules, policy, risk, permissions and limits decide. Typed tools execute. Verification confirms.**

## System

```
Next.js console (settla-frontend)  ──REST + SSE──▶  Express API (settla-backend)
                                                      │ auth · RBAC · tenancy · idempotency · audit
                                                      ▼
                       Rhea:  ingest → investigate → plan(LLM) → hard rules → policy → risk → permission
                                                      │                                  │
                                                      ▼                          approval / escalation
                                          typed tool executor ──▶ adapters (Razorpay, Shopify, Freshdesk, HubSpot, WhatsApp, Slack, Email)
                                                      ▼
                                          read-after-write verification ▶ compensation
                       MongoDB (all state) · BullMQ/Redis (jobs) · OpenTelemetry (traces)
```

## Backend layers (`src/`)
Route → Controller → Service → Repository. `repositories/base.js` forces `tenantId` on every query.
`agents/` (planner, hard rules, Rhea orchestrator), `policies/` (policy, risk, permission engines), `tools/` (registry + executor), `integrations/` (mock + live adapters), `domain/` (state machines), `queues/`, `workers/`, `security/`, `observability/`.

## Rhea flow
1. **Observe** – case created from API/webhook; customer text analysed as untrusted data (injection / human / legal / chargeback / hostile signals).
2. **Understand** – authoritative reads: gateway payment, OMS order, CRM customer, ticket, cart, inventory, duplicate-payment check. Each lookup retried (bounded, exponential backoff); persistent failure ⇒ escalate.
3. **Decide** – LLM returns JSON; validated by Ajv (strict). Malformed/unknown tool/extra fields ⇒ rejected ⇒ escalate.
4. **Hard rules** – deterministic: tool must match decision; amount re-derived from gateway; idempotency key derived server-side; escalation forced on confidence < 0.75, human request, chargeback/legal, systems disagree, hostile, injection.
5. **Policy** (`recover-order-v2`, `refund-v1`) → **risk** (additive, explainable) → **permission** (RBAC + tenant `executionMode` + limits).
6. **Gate** – escalate / request approval / execute.
7. **Act** – `runTool`: idempotent action row (unique key) → RUNNING → execute with retry → SUCCEEDED → VERIFYING → VERIFIED. Failed verification: one re-read, then **compensation** (e.g. cancel created order + restock) then escalate.
8. **Follow up** – notify, close ticket, CRM (allow-listed fields). Failures here never un-resolve the case; they are queued for retry and shown as pending.
9. **Learn** – analytics events (recovered/refunded revenue, resolution time).

## State machines
Case: NEW → OBSERVING → INVESTIGATING → DECIDING → (AWAITING_APPROVAL | EXECUTING | WAITING_REVERSAL | ESCALATED) → VERIFYING → RESOLVED/REFUNDED → CLOSED (+FAILED). Action: PENDING → RUNNING → SUCCEEDED → VERIFYING → VERIFIED, with FAILED → COMPENSATING → COMPENSATED / ESCALATED. All transitions go through `domain/stateMachines.js` and are recorded (`case_state_transitions`).

## Multi-tenancy
MongoDB has no RLS. Isolation is enforced in `tenantRepo` (tenantId always overrides the filter), tenant derived only from the verified token + DB, webhook tenants derived from the integration key. Cross-tenant tests in `tests/integration/api.test.js`.

## Queues
`case-processing, ai-planning, tool-execution, verification, notifications, webhooks, analytics, retry, escalations`. BullMQ when `REDIS_URL` is set (4 attempts, exponential backoff, failed-job retention = dead-letter). Without Redis a bounded in-process fallback is used (dev/test only).

## Realtime
`GET /api/v1/stream` SSE (per-tenant event bus). Multi-instance deployments should replace `events/bus.js` with Redis pub/sub (same interface).

## Frontend (`settla-frontend`)
Next.js App Router, TypeScript strict, Redux Toolkit (auth/ui/live feed), TanStack Query (server state), typed API client (timeouts, GET-only retries, request IDs, single-flight token refresh), authenticated SSE over fetch.

## Deployment
Docker images for backend; `docker-compose.yml` runs MongoDB (replica set), Redis, backend. Frontend: `next build && next start` or any Node host. Set secrets via environment, never commit.
