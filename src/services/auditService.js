import { repos } from '../repositories/index.js';
import { col, C } from '../db/mongo.js';

const SENSITIVE = /password|token|secret|apikey|authorization|cvv|cardnumber/i;
const scrub = (v) => {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Date) return v;
  if (Array.isArray(v)) return v.map(scrub);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SENSITIVE.test(k) ? '[REDACTED]' : scrub(x)]));
};

/** Append-only: this module exposes no update/delete. */
export async function audit(ctx, { action, resourceType, resourceId, before, after, meta }) {
  return repos.auditLogs.insert(ctx.tenantId, {
    actor: ctx.actor?.id ?? 'system',
    actorType: ctx.actor?.type ?? 'system',
    action,
    resourceType,
    resourceId: resourceId ? String(resourceId) : undefined,
    before: scrub(before),
    after: scrub(after),
    meta: scrub(meta),
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    traceId: ctx.traceId,
  });
}

export const listAudit = (tenantId, filter = {}, opts) => repos.auditLogs.find(tenantId, filter, opts);
export const countAudit = (tenantId, filter = {}) => repos.auditLogs.count(tenantId, filter);
export { col, C };
