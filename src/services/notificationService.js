import { repos } from '../repositories/index.js';
import { bus } from '../events/bus.js';

export async function notify(ctx, { kind, title, body, severity = 'info', caseId, link }) {
  const n = await repos.notifications.insert(ctx.tenantId, { kind, title, body, severity, caseId, link, read: false, userId: null });
  bus.publish(ctx.tenantId, { type: 'notification', notification: n });
  return n;
}
