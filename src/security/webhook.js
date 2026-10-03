import { hmacSha256, safeEqual } from '../lib/crypto.js';
import { col, C } from '../db/mongo.js';
import { AppError } from '../lib/errors.js';

export const WEBHOOK_TOLERANCE_SEC = 300;

/** Signature = hex HMAC-SHA256 over `${timestamp}.${rawBody}`. */
export function signWebhook(secret, timestamp, rawBody) {
  return hmacSha256(secret, `${timestamp}.${rawBody}`);
}

export function verifyWebhookSignature({ secret, signature, timestamp, rawBody, now = Date.now() }) {
  if (!secret) throw new AppError('WEBHOOK_NOT_CONFIGURED', 'Webhook secret not configured', 503);
  if (!signature || !timestamp) throw new AppError('WEBHOOK_SIGNATURE_MISSING', 'Missing signature', 401);
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > WEBHOOK_TOLERANCE_SEC) {
    throw new AppError('WEBHOOK_TIMESTAMP_INVALID', 'Webhook timestamp outside tolerance', 401);
  }
  const expected = signWebhook(secret, timestamp, rawBody);
  if (!safeEqual(expected, signature)) throw new AppError('WEBHOOK_SIGNATURE_INVALID', 'Invalid signature', 401);
}

/** Replay protection: each (source, eventId) accepted once. */
export async function claimWebhookEvent(source, eventId) {
  try {
    await col(C.webhookEvents).insertOne({ source, eventId, createdAt: new Date() });
    return true;
  } catch (e) {
    if (e.code === 11000) return false;
    throw e;
  }
}
