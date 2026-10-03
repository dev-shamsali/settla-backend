# Security audit (self-assessment, 2026-10-03)

Scope: both repositories as built. This is an engineering self-review, **not** an independent penetration test.

| Area | Control | Evidence |
|---|---|---|
| A01 Broken access control | RBAC from DB each request; tenant from verified identity; tool permission re-checked for approvers | `api.test.js` RBAC, revoked-permission, approver tests |
| A02 Crypto | bcrypt(12) passwords; AES-256-GCM credentials; HS256 JWT with issuer/audience, alg pinned | `security.test.js` |
| A03 Injection | zod strict schemas; `$`/`.` key rejection; regex-escaped search; no string-built queries | NoSQL/SQL payload tests |
| A04 Insecure design | LLM cannot execute; schema gate + hard rules + policy + permission; idempotency; verification + compensation | `rhea.test.js` |
| A05 Misconfiguration | Helmet + CSP, CORS allow-list, 100 KB body cap, no stack traces, x-powered-by off | header test |
| A06 Components | `npm audit --omit=dev`: 0 vulnerabilities (both repos) | CI step |
| A07 Auth failures | rate-limited login; refresh rotation + reuse detection; disabled user/tenant effective immediately | tests |
| A08 Integrity | HMAC webhooks, timestamp window, replay table | webhook tests |
| A09 Logging | pino redaction (passwords, tokens, auth headers, cvv, credentials); append-only audit scrubs secrets | test asserts secret absent from audit + API |
| A10 SSRF | live adapters: https only, host allow-list, IP/localhost blocked, redirects errors | unit tests |
| Prompt injection | untrusted text sanitised, fenced as data, detected ⇒ risk +0.5 and forced escalation | injection tests |
| Financial safety | gateway-authoritative amount, idempotency keys, ₹5,000 limit, self-approval blocked, verify-after-write | refund tests |
| CSRF | bearer tokens in memory; refresh cookie SameSite=Strict plus required custom header | `controllers` refresh |
| XSS | React escaping; untrusted text neutralised; `escapeHtml` for any HTML sink; no `dangerouslySetInnerHTML` | grep + tests |

## Findings / residual risk
1. **Credential exposure:** the MongoDB Atlas password was shared in chat. It is only in the gitignored `.env`. **Rotate it.**
2. No independent pen-test; no DAST. Dependency monitoring should be automated (Dependabot).
3. Live vendor adapters are unexercised against real vendor sandboxes.
4. Anthropic provider path untested without an API key.
5. In-process SSE bus and rate limiter are per-instance; use Redis stores when scaling horizontally.
6. Tenant isolation relies on application code (no database-level RLS in MongoDB). Raw `col()` use must remain code-reviewed.
7. Policies are code-versioned; there is no UI to edit them (by design for this release).
