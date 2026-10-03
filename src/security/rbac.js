export const ROLES = ['SUPER_ADMIN', 'TENANT_ADMIN', 'CX_LEAD', 'CX_AGENT', 'FINANCE', 'AUDITOR', 'VIEWER'];

export const ALL_PERMISSIONS = [
  'cases:read', 'cases:update', 'cases:create',
  'payments:read', 'payments:refund',
  'orders:read', 'orders:create',
  'customers:read',
  'crm:write', 'tickets:write', 'messages:send',
  'policies:read', 'policies:write',
  'approvals:read', 'approvals:approve',
  'escalations:read', 'escalations:update',
  'integrations:read', 'integrations:write',
  'analytics:read', 'audit:read',
  'users:read', 'users:write', 'tenant:read', 'tenant:write',
  'knowledge:read', 'knowledge:write',
  'automation:read', 'automation:dispatch',
  'admin:tenants', 'admin:system',
];

const read = ALL_PERMISSIONS.filter((p) => p.endsWith(':read'));

export const ROLE_PERMISSIONS = Object.freeze({
  SUPER_ADMIN: ALL_PERMISSIONS,
  TENANT_ADMIN: ALL_PERMISSIONS.filter((p) => !p.startsWith('admin:')),
  CX_LEAD: [
    'cases:read', 'cases:update', 'cases:create', 'payments:read', 'orders:read', 'orders:create', 'customers:read',
    'crm:write', 'tickets:write', 'messages:send', 'approvals:read', 'approvals:approve', 'escalations:read',
    'escalations:update', 'policies:read', 'integrations:read', 'analytics:read', 'knowledge:read',
    'automation:read', 'automation:dispatch',
  ],
  CX_AGENT: [
    'cases:read', 'cases:update', 'payments:read', 'orders:read', 'customers:read', 'tickets:write',
    'messages:send', 'approvals:read', 'escalations:read', 'escalations:update', 'knowledge:read',
    'automation:read', 'automation:dispatch',
  ],
  FINANCE: [
    'cases:read', 'payments:read', 'payments:refund', 'orders:read', 'customers:read', 'approvals:read',
    'approvals:approve', 'analytics:read', 'audit:read',
  ],
  AUDITOR: [...read, 'audit:read'],
  VIEWER: ['cases:read', 'payments:read', 'orders:read', 'customers:read', 'analytics:read'],
});

/** Effective permissions = role perms + grants - revocations (read from DB each request). */
export function effectivePermissions(user) {
  const set = new Set(ROLE_PERMISSIONS[user.role] ?? []);
  (user.grantedPermissions ?? []).forEach((p) => set.add(p));
  (user.revokedPermissions ?? []).forEach((p) => set.delete(p));
  return set;
}

export const can = (perms, p) => perms.has(p);
