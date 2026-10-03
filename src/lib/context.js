import { randomUUID } from 'node:crypto';
import { getAdapters } from '../integrations/index.js';
import { AGENT_PERMISSIONS } from '../policies/permissionEngine.js';

/** Real clock, or a deterministic simulated clock for the demo timeline. */
export function makeClock({ simulated = false, start = new Date() } = {}) {
  let t = start.getTime();
  return {
    simulated,
    now: () => (simulated ? new Date(t) : new Date()),
    advance(ms) { if (simulated) t += ms; },
  };
}

export const agentActor = () => ({ id: 'rhea', type: 'agent', permissions: new Set(AGENT_PERMISSIONS) });

/** Execution context threaded through every service. tenantId always comes from here. */
export function makeCtx({ tenant, actor = agentActor(), traceId, ip, userAgent, clock = makeClock(), creds } = {}) {
  return {
    tenant,
    tenantId: tenant._id,
    actor,
    traceId: traceId ?? randomUUID().replace(/-/g, ''),
    ip, userAgent, clock,
    adapters: getAdapters(tenant, creds),
  };
}
