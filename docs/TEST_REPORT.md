# Test report (2026-10-03)

## Backend (`settla-backend`) — Vitest, in-memory MongoDB (mongodb-memory-server)
| Suite | Tests | Passed | Failed | Skipped |
|---|---|---|---|---|
| unit/engines (policy, risk, permission, state machines, hard rules, schema, RBAC) | 40+ | all | 0 | 0 |
| unit/security (injection, webhook HMAC, crypto, NoSQL/SSRF guards, tool params, redaction) | 24 | all | 0 | 0 |
| integration/rhea (8 AI fixtures, prompt injection, 4 LLM-failure modes, integration failures, kill switch, idempotency) | 28 | all | 0 | 0 |
| integration/demo (UrbanStep / Ananya / pay_Q7xK2, 27 s) | 1 | all | 0 | 0 |
| integration/api (auth, RBAC, tenant isolation, refunds/approvals, webhooks, hardening, read APIs, rate limit) | 43 | all | 0 | 0 |
| **Total** | **135** | **135** | **0** | **0** |

Coverage (v8): statements 75.21 %, branches 64.68 %, functions 70.26 %, lines 80.59 %.
Lint: clean. `npm audit --omit=dev`: 0 vulnerabilities.

Also verified manually against **MongoDB Atlas** (not only in-memory): seed, server boot, login, `/demo/run` ⇒ RESOLVED, 27 000 ms, 19 timeline events.

## Frontend (`settla-frontend`)
| Check | Result |
|---|---|
| `tsc --noEmit` (strict) | clean |
| ESLint | clean |
| `next build` | success, 33 routes |
| Vitest unit (formatters, API client: envelope, typed errors, no retry for non-GET, idempotency header, network mapping) | 9 / 9 |
| Playwright E2E (Chromium desktop) | 12 / 12: login (bad+good), auth redirect, dashboard→demo recovery→timeline/Rhea/policy/verification/audit, case list search+filter, escalation take-over, >₹5,000 approval visibility, Ctrl+K + `g c` + `?`, kill switch + audit, RBAC (viewer), landing, zero console errors on 10 pages, escalated-case regression |
| Playwright (Pixel 7 mobile) | 1 / 1: no horizontal overflow on 5 pages, drawer nav |
| `npm audit --omit=dev` | 0 vulnerabilities |

E2E runs against the live backend + Atlas dev database (demo data only).

## Defects found and fixed during testing
Approver without refund permission consumed the approval and caused a 500 (now 403, approval stays pending); tag-based prompt injection undetected after sanitisation; velocity risk over-counted a single payment; CRM follow-up used the wrong customer id; React Compiler crash in the optimised build on escalated case detail.

## Not tested / known gaps
- BullMQ against a real Redis, Docker/compose, OpenTelemetry export (no Docker/Redis on the build machine).
- Live vendor adapters (Razorpay/Shopify/Freshdesk/HubSpot/WhatsApp/Slack) and the Anthropic provider (no credentials).
- Cross-browser (only Chromium), screen-reader testing, load/performance testing.
- Coverage is below 85 % for branches; live adapters and workers are largely uncovered.

## Update: n8n integration layer (2026-10-03)
- Backend: **189 / 189** pass (7 files). New:  (contract simulator: valid, bad/tampered signature, wrong auth token, stale/future timestamp, replay, 6 invalid-payload cases, 5 financial actions, expired authorisation; backend decision layer; PaymentProvider/RazorpayAdapter) and  (propose, dispatch + full audit trail, duplicate key replay, key reuse 422, missing key, invalid proposals never reach n8n, financial actions blocked + audited, RBAC, per-action permission, >₹5,000 approval rule overriding Rhea, kill switch, tenant isolation, n8n failure modes, retry-after-failure).
- Coverage: statements 76.55 %, branches 66.66 %, functions 71.56 %, lines 81.87 %.
- Frontend: tsc/eslint clean, 9 / 9 unit; Playwright E2E 15 / 15 (adds automation panel flow and presentation page).
- n8n (workflow , inactive) tested through the n8n MCP  with pinned, backend-signed requests: valid ⇒ 200 success (exec 4); stale timestamp ⇒ TIMESTAMP_INVALID 401 (exec 5); missing authorization ⇒ INVALID_PAYLOAD 422 (exec 6); refund action ⇒ ACTION_NOT_ALLOWED 422 (exec 7).
- **Not verified:** HMAC verification inside n8n (secret not available there ⇒ ; strict signature checks are tested in the backend simulator); n8n-side replay (workflow static data does not persist across manual test runs); a real HTTP call to the activated webhook.
