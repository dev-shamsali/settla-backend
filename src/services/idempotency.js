import { col, C } from '../db/mongo.js';
import { AppError, badRequest } from '../lib/errors.js';
import { hashRequest } from '../lib/crypto.js';

/**
 * Exactly-once execution per (tenant, actionType, key).
 * - first caller claims the key (unique index) and runs fn
 * - same key + same payload: returns stored response (no re-execution)
 * - same key + different payload: 422
 * - same key while first still running: 409
 */
export async function withIdempotency(tenantId, actionType, key, requestPayload, fn) {
  if (!key || typeof key !== 'string' || key.length < 8 || key.length > 128) {
    throw badRequest('Idempotency-Key header required (8-128 chars)', 'IDEMPOTENCY_KEY_REQUIRED');
  }
  const requestHash = hashRequest(requestPayload);
  const c = col(C.idempotency);
  try {
    await c.insertOne({ tenantId, actionType, key, requestHash, status: 'IN_PROGRESS', createdAt: new Date() });
  } catch (e) {
    if (e.code !== 11000) throw e;
    const existing = await c.findOne({ tenantId, actionType, key });
    if (existing.requestHash !== requestHash) {
      throw new AppError('IDEMPOTENCY_KEY_REUSED', 'Idempotency key reused with different request', 422);
    }
    if (existing.status === 'COMPLETED') return { ...existing.response, idempotentReplay: true };
    throw new AppError('IDEMPOTENCY_IN_PROGRESS', 'Request with this key is in progress', 409);
  }
  try {
    const response = await fn();
    await c.updateOne({ tenantId, actionType, key }, { $set: { status: 'COMPLETED', response: JSON.parse(JSON.stringify(response ?? null)) } });
    return response;
  } catch (e) {
    // release the key so a corrected retry is possible
    await c.deleteOne({ tenantId, actionType, key });
    throw e;
  }
}
