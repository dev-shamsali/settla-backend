# Database (MongoDB)

Original spec called for PostgreSQL + pgvector; the project owner switched to **MongoDB**. Consequences: no row-level security (tenancy enforced in the repository layer), no SQL constraints (enforced with unique/TTL indexes + application checks), vector search is in-process cosine until an Atlas Vector Search index is added.

IDs are UUID strings (`_id`). Every tenant-owned document has `tenantId`, `createdAt`, `updatedAt`.

| Collection | Purpose | Key indexes |
|---|---|---|
| tenants | tenant config, `executionMode`, limits, `caseCounter` | `slug` unique |
| users | accounts, role, grants/revocations | `email` unique; `(tenantId, role)` |
| sessions | hashed refresh tokens (rotation + family) | `tokenHash` unique; TTL `expiresAt` |
| cases | case aggregate (status, risk, confidence, decision) | `(tenantId, caseNumber)` unique; `(tenantId,status,createdAt)` |
| case_events | timeline | `(tenantId, caseId, ts)` |
| case_state_transitions | every state change | `(tenantId, caseId, ts)` |
| customers / payments / orders / cart_snapshots | system-of-record mirrors | `(tenantId,email)`, `(tenantId,gatewayPaymentId)` unique, `(tenantId,orderNumber)` unique |
| decisions / decision_traces | AI proposal, enforced plan, policy + risk, trace | `(tenantId, caseId, createdAt)` |
| policies / policy_evaluations / risk_assessments | versioned policies and evaluations | `(tenantId,key,version)` unique |
| actions / action_attempts / action_verifications | tool executions | `(tenantId, idempotencyKey)` unique |
| approvals / escalations | human gates | `(tenantId,status,createdAt)` |
| messages | outbound communication log | `(tenantId,caseId,createdAt)` |
| integrations | per-tenant config; credentials AES-256-GCM encrypted | `(tenantId,type)` unique |
| audit_logs | append-only (no update/delete code path) | `(tenantId,createdAt)`, `(tenantId,resourceType,resourceId)` |
| knowledge_documents | docs + chunk embeddings | `(tenantId,kind)` |
| analytics_events, notifications | metrics and inbox | by tenant + time |
| idempotency_keys | exactly-once financial endpoints | `(tenantId,actionType,key)` unique; TTL 7d |
| webhook_events | replay protection | `(source,eventId)` unique; TTL 3d |

## Tenant isolation
`tenantRepo(name)` requires `tenantId` for every call and overrides any `tenantId` in the filter. Raw collection access (`col()`) is limited to auth, tenants and webhook resolution. User-supplied objects pass `assertSafeObject` (rejects `$`/`.`/`__proto__` keys).

## Not implemented
Multi-document transactions (single-document atomicity + unique indexes are used), Atlas Vector Search index, `api_keys` collection.
