import { IntegrationError, timeoutErr, rateErr, notConfigured } from './errors.js';

const breakers = new Map();
const THRESHOLD = 5;
const COOLDOWN_MS = 30_000;

function breaker(system) {
  if (!breakers.has(system)) breakers.set(system, { fails: 0, openUntil: 0 });
  return breakers.get(system);
}

/** SSRF guard: https only, host must be on the adapter's allow-list, no IP literals. */
export function assertAllowedUrl(url, allowedHosts) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new IntegrationError('http', 'SSRF_BLOCKED', 'Only https allowed');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) || u.hostname.includes('[') || u.hostname === 'localhost') {
    throw new IntegrationError('http', 'SSRF_BLOCKED', 'IP/localhost targets blocked');
  }
  if (!allowedHosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) {
    throw new IntegrationError('http', 'SSRF_BLOCKED', `Host ${u.hostname} not allow-listed`);
  }
  return u;
}

export async function httpJson(system, { url, method = 'GET', headers = {}, body, timeoutMs = 8000, allowedHosts, retries = 2 }) {
  if (!url) throw notConfigured(system);
  assertAllowedUrl(url, allowedHosts);
  const b = breaker(system);
  if (Date.now() < b.openUntil) throw new IntegrationError(system, 'CIRCUIT_OPEN', `${system} circuit open`, { retryable: true });

  let attempt = 0;
  for (;;) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        redirect: 'error',
      });
      clearTimeout(timer);
      if (res.status === 429) throw rateErr(system);
      if (res.status >= 500) throw new IntegrationError(system, 'INTEGRATION_FAILURE', `${system} ${res.status}`, { retryable: true, status: res.status });
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (!res.ok) throw new IntegrationError(system, 'INTEGRATION_FAILURE', `${system} ${res.status}`, { status: res.status });
      b.fails = 0;
      return json;
    } catch (e) {
      clearTimeout(timer);
      const err = e.name === 'AbortError' ? timeoutErr(system) : e;
      if (!(err instanceof IntegrationError)) throw new IntegrationError(system, 'INTEGRATION_FAILURE', `${system} ${err.message}`);
      if (err.retryable && attempt < retries) {
        attempt += 1;
        await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
        continue;
      }
      if (err.retryable) {
        b.fails += 1;
        if (b.fails >= THRESHOLD) b.openUntil = Date.now() + COOLDOWN_MS;
      }
      throw err;
    }
  }
}
