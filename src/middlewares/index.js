import { randomUUID } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';
import { col, C } from '../db/mongo.js';
import { verifyAccess } from '../security/tokens.js';
import { effectivePermissions } from '../security/rbac.js';
import { makeCtx } from '../lib/context.js';
import { AppError, unauthorized, forbidden } from '../lib/errors.js';
import { assertSafeObject } from '../repositories/base.js';
import { logger } from '../lib/logger.js';
import { isProd, isTest } from '../config/env.js';

export function requestContext(req, res, next) {
  req.id = String(req.headers['x-request-id'] ?? '').slice(0, 64).replace(/[^\w-]/g, '') || randomUUID();
  req.traceId = randomUUID().replace(/-/g, '');
  res.setHeader('x-request-id', req.id);
  next();
}

/** Tenant + actor are derived ONLY from the verified token + DB state, never from the request body. */
export async function authenticate(req, res, next) {
  try {
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Bearer ')) throw unauthorized();
    const claims = verifyAccess(h.slice(7));
    const user = await col(C.users).findOne({ _id: claims.sub });
    if (!user || user.status !== 'active') throw unauthorized('User inactive', 'USER_INACTIVE');
    if (user.tenantId !== claims.tid) throw unauthorized('Token tenant mismatch', 'TOKEN_INVALID');
    const tenant = await col(C.tenants).findOne({ _id: user.tenantId });
    if (!tenant || tenant.status !== 'active') throw forbidden('Tenant is disabled', 'TENANT_DISABLED');
    const permissions = effectivePermissions(user); // fresh from DB: revocation is immediate
    req.user = user;
    req.permissions = permissions;
    req.ctx = makeCtx({
      tenant, actor: { id: user._id, type: 'user', permissions, role: user.role }, traceId: req.traceId, ip: req.ip, userAgent: req.headers['user-agent'],
    });
    next();
  } catch (e) { next(e); }
}

export const requirePermission = (...perms) => (req, res, next) => {
  if (!req.permissions) return next(unauthorized());
  const missing = perms.filter((p) => !req.permissions.has(p));
  if (missing.length) return next(forbidden(`Missing permission: ${missing.join(', ')}`, 'PERMISSION_DENIED'));
  next();
};

export const requireSuperAdmin = (req, res, next) => (req.user?.role === 'SUPER_ADMIN' ? next() : next(forbidden('Super admin only')));

/** zod validation + NoSQL operator rejection. Validated values replace the originals. */
export const validate = (schemas) => (req, res, next) => {
  try {
    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue;
      assertSafeObject(req[part], part);
      const parsed = schemas[part].parse(req[part] ?? {});
      if (part === 'query') Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true });
      else req[part] = parsed;
    }
    next();
  } catch (e) { next(e); }
};

export const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const notFoundHandler = (req, res, next) => next(new AppError('ROUTE_NOT_FOUND', 'Route not found', 404));

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Internal server error';
  let details;
  if (err instanceof AppError) ({ status, code, message, details } = err);
  else if (err instanceof ZodError) { status = 400; code = 'VALIDATION_ERROR'; message = 'Request validation failed'; details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })); }
  else if (err?.type === 'entity.too.large') { status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'Request body too large'; }
  else if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) { status = 400; code = 'INVALID_JSON'; message = 'Malformed JSON body'; }
  else if (err?.code === 11000) { status = 409; code = 'DUPLICATE'; message = 'Duplicate resource'; }
  else if (err?.name === 'IntegrationError') { status = 502; code = err.code; message = err.message; }
  if (status >= 500) logger.error({ err: err.message, stack: isProd ? undefined : err.stack, requestId: req.id }, 'unhandled error');
  res.status(status).json({ success: false, error: { code, message, requestId: req.id, ...(details ? { details } : {}), ...(!isProd && status >= 500 && !isTest ? { debug: err.message } : {}) } });
}

const limiterOpts = { standardHeaders: true, legacyHeaders: false, handler: (req, res, next) => next(new AppError('RATE_LIMITED', 'Too many requests', 429)) };
export const globalLimiter = (max = 600) => rateLimit({ windowMs: 60_000, max, ...limiterOpts });
export const authLimiter = (max = 10) => rateLimit({ windowMs: 60_000, max, ...limiterOpts });
export const webhookLimiter = (max = 300) => rateLimit({ windowMs: 60_000, max, ...limiterOpts });
