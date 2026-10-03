import { env } from '../../config/env.js';
import { hmacSha256, sha256 } from '../../lib/crypto.js';
import { IntegrationError, timeoutErr, notConfigured } from '../errors.js';
import { assertAllowedUrl } from '../http.js';
import { n8nResponseSchema } from './contract.js';
import { createN8nSimulator } from './mockN8n.js';

let simulator;
/** In-process contract simulator used when N8N_MODE=mock (default). */
export function getSimulator() {
  simulator ??= createN8nSimulator({ signingSecret: env.N8N_SIGNING_SECRET, authToken: env.N8N_WEBHOOK_AUTH_TOKEN });
  return simulator;
}
export const resetSimulator = () => { simulator = undefined; };

const TIMEOUT_MS = 15_000;

/**
 * Signed dispatch to n8n. Headers: x-settla-timestamp, x-settla-signature (HMAC-SHA256 of "ts.rawBody"),
 * x-settla-event-id (= backend idempotency key), x-correlation-id, x-settla-auth (transport token).
 * The response is schema-validated; a non-conforming or mismatched response is an integration failure.
 */
export async function dispatchToN8n({ payload, eventId, correlationId, secret = env.N8N_SIGNING_SECRET, authToken = env.N8N_WEBHOOK_AUTH_TOKEN, mode = env.N8N_MODE, fetchImpl = fetch }) {
  if (!secret || secret.length < 32) throw notConfigured('n8n signing secret (>=32 chars)');
  const rawBody = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const headers = {
    'content-type': 'application/json',
    'x-settla-timestamp': String(ts),
    'x-settla-signature': hmacSha256(secret, `${ts}.${rawBody}`),
    'x-settla-event-id': eventId,
    'x-correlation-id': correlationId,
    ...(authToken ? { 'x-settla-auth': authToken } : {}),
  };

  let status; let body;
  if (mode === 'mock') {
    const r = getSimulator().handle({ headers, rawBody });
    if (r.timeout) throw timeoutErr('n8n');
    ({ status, body } = r);
  } else {
    if (!env.N8N_WEBHOOK_URL) throw notConfigured('n8n webhook url');
    assertAllowedUrl(env.N8N_WEBHOOK_URL, env.N8N_ALLOWED_HOSTS.split(',').map((s) => s.trim()).filter(Boolean));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(env.N8N_WEBHOOK_URL, { method: 'POST', headers, body: rawBody, signal: ctrl.signal, redirect: 'error' });
      status = res.status;
      body = await res.json().catch(() => null);
    } catch (e) {
      throw e.name === 'AbortError' ? timeoutErr('n8n') : new IntegrationError('n8n', 'INTEGRATION_FAILURE', 'n8n request failed', { retryable: true });
    } finally { clearTimeout(timer); }
  }

  const parsed = n8nResponseSchema.safeParse(body);
  if (!parsed.success) throw new IntegrationError('n8n', 'N8N_BAD_RESPONSE', 'n8n returned a non-conforming response');
  return { httpStatus: status, response: parsed.data, requestHash: sha256(rawBody), signaturePrefix: headers['x-settla-signature'].slice(0, 8) };
}
