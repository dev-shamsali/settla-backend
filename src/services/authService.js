import { col, C } from '../db/mongo.js';
import { randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword, signAccess, issueRefresh, rotateRefresh, revokeUserSessions } from '../security/tokens.js';
import { effectivePermissions } from '../security/rbac.js';
import { unauthorized, forbidden } from '../lib/errors.js';

const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO5Z8oJ1bJ1q0q0q0q0q0q0q0q0q0q0qa';

export const publicUser = (u) => ({ id: u._id, email: u.email, name: u.name, role: u.role, tenantId: u.tenantId, permissions: [...effectivePermissions(u)] });

export async function login(email, password) {
  const user = await col(C.users).findOne({ email: String(email).toLowerCase() });
  // constant-ish time: always run a bcrypt compare
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH).catch(() => false);
  if (!user || !ok || user.status !== 'active') throw unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
  const tenant = await col(C.tenants).findOne({ _id: user.tenantId });
  if (!tenant || tenant.status !== 'active') throw forbidden('Tenant disabled', 'TENANT_DISABLED');
  await col(C.users).updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  return { accessToken: signAccess(user), refreshToken: await issueRefresh(user), user: publicUser(user), tenant: { id: tenant._id, name: tenant.name, executionMode: tenant.executionMode } };
}

export async function refresh(token) {
  const s = await rotateRefresh(token);
  const user = await col(C.users).findOne({ _id: s.userId });
  if (!user || user.status !== 'active') throw unauthorized('User disabled', 'USER_DISABLED');
  return { accessToken: signAccess(user), refreshToken: await issueRefresh(user, s.familyId) };
}

export async function createUser({ tenantId, email, name, password, role }) {
  const doc = { _id: randomUUID(), tenantId, email: email.toLowerCase(), name, role, status: 'active', passwordHash: await hashPassword(password), grantedPermissions: [], revokedPermissions: [], createdAt: new Date() };
  await col(C.users).insertOne(doc);
  return doc;
}

export async function setUserAccess(tenantId, userId, patch) {
  const allowed = {};
  for (const k of ['role', 'status', 'grantedPermissions', 'revokedPermissions']) if (patch[k] !== undefined) allowed[k] = patch[k];
  const u = await col(C.users).findOneAndUpdate({ _id: userId, tenantId }, { $set: allowed }, { returnDocument: 'after' });
  if (u && (allowed.status === 'disabled' || allowed.role)) await revokeUserSessions(userId);
  return u;
}
