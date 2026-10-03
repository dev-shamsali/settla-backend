import { env } from '../config/env.js';
import { createMockAdapters } from './mock/adapters.js';
import { createLiveAdapters } from './live/index.js';

const cache = new Map();

/** INTEGRATION_MODE=mock|live. Per-tenant override via tenant.integrationMode. */
export function getAdapters(tenant, creds = {}) {
  const mode = tenant.integrationMode ?? env.INTEGRATION_MODE;
  const key = `${tenant._id}:${mode}`;
  if (mode === 'live') return createLiveAdapters(creds);
  if (!cache.has(key)) cache.set(key, createMockAdapters(tenant._id));
  return cache.get(key);
}

export { injectFault, resetWorld, seedDemoWorld, getWorld, callCount } from './mock/world.js';
export { IntegrationError } from './errors.js';
