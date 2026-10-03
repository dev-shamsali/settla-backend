import { hmacSha256, safeEqual } from '../../lib/crypto.js';
import { n8nRequestSchema, N8N_ACTIONS, FINANCIAL_ACTIONS, WORKFLOW_NAME, ACTION_SERVICE } from './contract.js';

const TOLERANCE_SEC = 300;
const fail = (status, code, message, extra = {}) => ({ status, body: { success: false, caseId: extra.caseId ?? 'unknown', correlationId: extra.correlationId ?? 'unknown', error: { code, message } } });

/**
 * Executable specification of the "SETTLA - PAYMENT RESOLUTION" n8n workflow contract.
 * Used (a) in-process when N8N_MODE=mock and (b) behind a real HTTP server in tests.
 * It performs the SAME checks the workflow performs and, like the workflow, makes NO policy
 * decisions (no thresholds, no refund eligibility): it only validates and executes approved steps.
 * All data returned is test data; no external service is contacted.
 */
export function createN8nSimulator({ signingSecret, authToken, now = () => Date.now() } = {}) {
  const seenEvents = new Map();
  const calls = [];
  let fault = null;
  let execCounter = 0;

  function handle({ headers, rawBody }) {
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    calls.push({ at: now(), eventId: h['x-settla-event-id'] });
    if (fault === 'timeout') return { timeout: true };
    if (fault === 'server_error') return { status: 500, body: { success: false, caseId: 'unknown', correlationId: 'unknown', error: { code: 'INTERNAL', message: 'workflow error' } } };
    if (fault === 'bad_response') return { status: 200, body: { unexpected: true } };

    if (authToken && !safeEqual(h['x-settla-auth'] ?? '', authToken)) return fail(401, 'UNAUTHORIZED', 'Webhook authentication failed');
    const ts = Number(h['x-settla-timestamp']);
    if (!Number.isFinite(ts) || Math.abs(now() / 1000 - ts) > TOLERANCE_SEC) return fail(401, 'TIMESTAMP_INVALID', 'Timestamp outside tolerance');
    if (!signingSecret) return fail(503, 'SIGNING_NOT_CONFIGURED', 'Signing secret not configured');
    const expected = hmacSha256(signingSecret, `${ts}.${rawBody}`);
    if (!safeEqual(expected, h['x-settla-signature'] ?? '')) return fail(401, 'SIGNATURE_INVALID', 'Invalid signature');
    const eventId = h['x-settla-event-id'];
    if (!eventId || eventId.length < 8) return fail(400, 'EVENT_ID_MISSING', 'Missing event id');

    let json;
    try { json = JSON.parse(rawBody); } catch { return fail(400, 'INVALID_JSON', 'Body is not valid JSON'); }
    const corr = typeof json?.correlationId === 'string' ? json.correlationId : 'unknown';
    const caseId = typeof json?.caseId === 'string' ? json.caseId : 'unknown';
    if (h['x-correlation-id'] && h['x-correlation-id'] !== corr) return fail(400, 'CORRELATION_MISMATCH', 'Correlation id mismatch', { caseId, correlationId: corr });

    if (seenEvents.has(eventId)) return fail(409, 'REPLAYED_EVENT', 'Event already processed', { caseId, correlationId: corr });

    if (FINANCIAL_ACTIONS.includes(json?.requestedAction)) return fail(422, 'ACTION_NOT_ALLOWED', 'Financial actions are not executable through n8n', { caseId, correlationId: corr });
    const parsed = n8nRequestSchema.safeParse(json);
    if (!parsed.success) return fail(422, 'INVALID_PAYLOAD', `Invalid payload: ${parsed.error.issues[0]?.path.join('.') || 'body'}`, { caseId, correlationId: corr });
    const req = parsed.data;
    if (!N8N_ACTIONS.includes(req.requestedAction)) return fail(422, 'ACTION_NOT_ALLOWED', 'Action not allow-listed', { caseId, correlationId: corr });
    if (new Date(req.authorization.expiresAt).getTime() < now()) return fail(422, 'AUTHORIZATION_EXPIRED', 'Backend authorisation expired', { caseId, correlationId: corr });

    seenEvents.set(eventId, now());
    execCounter += 1;
    const service = ACTION_SERVICE[req.requestedAction];
    const data = {
      investigate_payment: { paymentId: req.paymentId, status: 'captured', amount: req.amount, orderLinked: !!req.orderId, note: 'TEST DATA - no provider contacted' },
      payment_lookup: { paymentId: req.paymentId, status: 'captured', amount: req.amount, note: 'TEST DATA - no provider contacted' },
      order_lookup: { orderId: req.orderId ?? null, found: !!req.orderId, note: 'TEST DATA' },
      notify_customer: { template: req.notification?.template ?? null, recipientRef: 'SETTLA_TEST_WHATSAPP_NUMBER', dispatched: false, note: 'NOT SENT - WhatsApp not connected' },
      sync_crm: { synced: false, note: 'NOT SENT - HubSpot not connected (placeholder)' },
      update_ticket: { updated: false, note: 'NOT SENT - Freshdesk not connected (placeholder)' },
    }[req.requestedAction];
    return {
      status: 200,
      body: {
        success: true, caseId: req.caseId, correlationId: req.correlationId, action: req.requestedAction, signatureVerified: true,
        workflow: { name: WORKFLOW_NAME, executionId: `sim-${execCounter}` },
        result: { externalService: service, mode: 'test-placeholder', data },
      },
    };
  }

  return { handle, calls, seenEvents, setFault: (f) => { fault = f; }, reset() { seenEvents.clear(); calls.length = 0; fault = null; } };
}
