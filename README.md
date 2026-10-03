# settla-backend

Rhea — autonomous payment resolution for "money debited, no order". Node.js + Express (JavaScript ESM) + MongoDB + BullMQ.

**The LLM proposes. Rules, policy, risk, permissions and limits decide. Typed tools execute. Verification confirms.**

## Quick start

```bash
cp .env.example .env        # set MONGODB_URI (Atlas or local replica set) and secrets
npm install
npm run migrate             # idempotent index creation
npm run seed                # demo tenant "UrbanStep Support (DEMO)" + users
npm run dev                 # http://localhost:4000  (GET /health, /api/v1/openapi.json)
npm test                    # unit + integration + security (in-memory Mongo)
```

Demo logins (seed data only): `tenant_admin@urbanstep.test`, `cx_lead@…`, `finance@…`, `cx_agent@…`, `auditor@…`, `viewer@…` — password `Settla!Demo123`.
Run the scripted demo: `POST /api/v1/demo/run` (mock integrations, simulated 27 s clock).

## Docker
`docker compose up` starts MongoDB (replica set), Redis, backend. Add `--profile observability` for an OTel collector.

## Modes
- `INTEGRATION_MODE=mock|live` — mock adapters simulate success, timeout, failure, duplicate, verification mismatch, rate limit.
- `LLM_PROVIDER=mock|anthropic` — mock is deterministic; anthropic needs `ANTHROPIC_API_KEY`.
- `REDIS_URL` empty → in-process queue fallback (dev only). Set it in production for BullMQ.

## Layout
`src/{config,controllers,routes,services,repositories,middlewares,validators,policies,agents,tools,integrations,queues,workers,events,security,observability,lib,db}` — Route → Controller → Service → Repository; Agent → Planner → Hard rules → Policy → Risk → Permission → Tool executor → Verification.

See `docs/ARCHITECTURE.md`, `docs/DATABASE.md`, `docs/SECURITY_AUDIT.md`, `docs/API.md`, `docs/TEST_REPORT.md`.

## Security notes
Tenant isolation is enforced in the repository layer (every query forced to the authenticated tenant). MongoDB has no row-level security. Never commit `.env`. Rotate any credential that has been shared in chat.
