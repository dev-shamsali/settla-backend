import { AUTO_REFUND_LIMIT_INR } from '../config/env.js';

export const TOOL_PERMISSIONS = Object.freeze({
  recover_order: 'orders:create',
  refund_payment: 'payments:refund',
  wait_for_reversal: 'cases:update',
  escalate: 'cases:update',
  notify_customer: 'messages:send',
  close_ticket: 'tickets:write',
  update_crm: 'crm:write',
});

/** Permissions the autonomous agent actor holds. Refund is deliberately absent unless limit-gated. */
export const AGENT_PERMISSIONS = new Set([
  'cases:update', 'orders:read', 'orders:create', 'payments:read', 'customers:read',
  'tickets:write', 'messages:send', 'crm:write', 'payments:refund',
]);

const SENSITIVE_TOOLS = new Set(['recover_order', 'refund_payment']);

export const EXECUTION_MODES = ['AUTONOMOUS', 'RECOMMEND_ONLY', 'DISABLED'];

/**
 * actor: { type: 'agent'|'user', permissions:Set, id }
 * Returns { allowed, reason, requiresApproval }.
 */
export function checkPermission({ actor, tool, amount = 0, tenant, approved = false }) {
  const required = TOOL_PERMISSIONS[tool];
  if (!required) return { allowed: false, reason: `Tool ${tool} not allow-listed`, required: null };
  const mode = tenant?.executionMode ?? 'AUTONOMOUS';
  if (mode === 'DISABLED') return { allowed: false, reason: 'Tenant execution disabled', required };
  if (tenant?.status && tenant.status !== 'active') return { allowed: false, reason: 'Tenant not active', required };
  if (mode === 'RECOMMEND_ONLY' && SENSITIVE_TOOLS.has(tool) && actor.type === 'agent') {
    return { allowed: false, reason: 'Tenant is in RECOMMEND_ONLY mode', required, recommendOnly: true };
  }
  if (!actor.permissions.has(required)) return { allowed: false, reason: `Missing permission ${required}`, required };
  const limit = tenant?.limits?.autoExecuteInr ?? AUTO_REFUND_LIMIT_INR;
  if (tool === 'refund_payment' && amount > limit && !approved) {
    return { allowed: false, reason: `Refund ₹${amount} exceeds auto limit ₹${limit}; approval required`, required, requiresApproval: true };
  }
  return { allowed: true, reason: 'ok', required };
}
