import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { col, C } from '../db/mongo.js';
import { unauthorized } from '../lib/errors.js';

export const hashPassword = (pw) => bcrypt.hash(pw, 12);
export const verifyPassword = (pw, hash) => bcrypt.compare(pw, hash);

export function signAccess(user) {
  return jwt.sign({ sub: user._id, tid: user.tenantId, role: user.role }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.ACCESS_TOKEN_TTL,
    issuer: 'settla',
    audience: 'settla-api',
  });
}

export function verifyAccess(token) {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'], issuer: 'settla', audience: 'settla-api' });
  } catch {
    throw unauthorized('Invalid or expired token', 'TOKEN_INVALID');
  }
}

/** Opaque refresh tokens, stored hashed, rotated on every use (reuse => family revoked). */
export async function issueRefresh(user, familyId = randomToken(8)) {
  const token = randomToken(40);
  await col(C.sessions).insertOne({
    tokenHash: sha256(token),
    userId: user._id,
    tenantId: user.tenantId,
    familyId,
    used: false,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400_000),
  });
  return token;
}

export async function rotateRefresh(token) {
  const s = await col(C.sessions).findOne({ tokenHash: sha256(token) });
  if (!s) throw unauthorized('Invalid refresh token', 'REFRESH_INVALID');
  if (s.used) {
    await col(C.sessions).deleteMany({ familyId: s.familyId });
    throw unauthorized('Refresh token reuse detected', 'REFRESH_REUSED');
  }
  await col(C.sessions).updateOne({ _id: s._id }, { $set: { used: true } });
  return s;
}

export const revokeUserSessions = (userId) => col(C.sessions).deleteMany({ userId });
