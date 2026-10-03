import { resolveWebhookIntegration } from './tenantService.js';
import { verifyWebhookSignature, claimWebhookEvent } from '../security/webhook.js';
import { AppError } from '../lib/errors.js';
import { makeCtx } from '../lib/context.js';
import { createCase } from './caseService.js';
import { enqueue } from '../queues/index.js';
import { repos } from '../repositories/index.js';
import { analyzeUntrusted } from '../security/untrusted.js';

/** Verifies signature + timestamp + replay, resolves tenant from the integration key (never the body). */
export async function authenticateWebhook(type, req) {
  const keyId = req.headers['x-settla-key-id'];
  const resolved = await resolveWebhookIntegration(type, String(keyId ?? ''));
  if (!resolved) throw new AppError('WEBHOOK_UNKNOWN_KEY', 'Unknown webhook key', 401);
  verifyWebhookSignature({
    secret: resolved.secret, signature: req.headers['x-settla-signature'], timestamp: req.headers['x-settla-timestamp'], rawBody: req.rawBody ?? '',
  });
  const eventId = String(req.headers['x-event-id'] ?? req.body?.id ?? '');
  if (!eventId) throw new AppError('WEBHOOK_EVENT_ID_MISSING', 'Missing event id', 400);
  const fresh = await claimWebhookEvent(`${resolved.tenant._id}:${type}`, eventId);
  return { tenant: resolved.tenant, eventId, replay: !fresh };
}

export async function handleRazorpay(tenant, body, traceId) {
  const ctx = makeCtx({ tenant, traceId });
  if (body.event !== 'payment.captured') return { accepted: true, ignored: body.event };
  const p = body.payload?.payment?.entity;
  if (!p?.id) throw new AppError('WEBHOOK_PAYLOAD_INVALID', 'Missing payment entity', 400);
  const order = await ctx.adapters.orders.findOrderByPaymentRef(p.id).catch(() => null);
  if (order) return { accepted: true, ignored: 'order_exists' };
  const dup = await repos.cases.findOne(tenant._id, { paymentId: p.id, status: { $nin: ['CLOSED'] } });
  if (dup) return { accepted: true, caseId: dup._id, duplicate: true };
  const c = await createCase(ctx, { paymentId: p.id, customerEmail: p.email, customerPhone: p.contact, channel: 'api', amount: Math.round((p.amount ?? 0) / 100) });
  await enqueue('case-processing', 'process', { tenantId: tenant._id, caseId: c._id });
  return { accepted: true, caseId: c._id };
}

export async function handleInboundMessage(tenant, type, body, traceId) {
  const ctx = makeCtx({ tenant, traceId });
  const text = analyzeUntrusted(body.message ?? body.text ?? '');
  const paymentId = String(body.paymentId ?? '').match(/pay_[\w]+/)?.[0] ?? text.text.match(/pay_[\w]+/)?.[0];
  if (!paymentId) return { accepted: true, ignored: 'no_payment_reference' };
  const c = await createCase(ctx, { paymentId, customerPhone: body.from, customerEmail: body.email, customerMessage: text.text, ticketId: body.ticketId, channel: type });
  await enqueue('case-processing', 'process', { tenantId: tenant._id, caseId: c._id });
  return { accepted: true, caseId: c._id, injectionFlagged: text.injectionDetected };
}
