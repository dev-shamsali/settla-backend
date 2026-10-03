import { randomUUID } from 'node:crypto';
import { col } from '../db/mongo.js';
import { badRequest } from '../lib/errors.js';

/** Reject Mongo operator / dotted-key injection in untrusted objects. */
export function assertSafeObject(v, path = 'input') {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Date) return v;
  if (Array.isArray(v)) {
    v.forEach((x, i) => assertSafeObject(x, `${path}[${i}]`));
    return v;
  }
  for (const k of Object.keys(v)) {
    if (k.startsWith('$') || k.includes('.') || k === '__proto__' || k === 'constructor' || k === 'prototype') {
      throw badRequest(`Unsafe key "${k}" in ${path}`, 'UNSAFE_INPUT');
    }
    assertSafeObject(v[k], `${path}.${k}`);
  }
  return v;
}

/**
 * Tenant-scoped repository. tenantId is mandatory on every call and always
 * overrides any tenantId in the filter, so a cross-tenant read/write is
 * structurally impossible through this layer.
 */
export function tenantRepo(name) {
  const scope = (tenantId, filter = {}) => {
    if (!tenantId) throw new Error('tenantId required');
    return { ...filter, tenantId };
  };
  return {
    name,
    async insert(tenantId, doc) {
      const now = new Date();
      const full = { _id: randomUUID(), createdAt: now, updatedAt: now, ...doc, tenantId };
      await col(name).insertOne(full);
      return full;
    },
    findById: (tenantId, id) => col(name).findOne(scope(tenantId, { _id: id })),
    findOne: (tenantId, filter) => col(name).findOne(scope(tenantId, filter)),
    async find(tenantId, filter = {}, { sort = { createdAt: -1 }, skip = 0, limit = 50, projection } = {}) {
      return col(name)
        .find(scope(tenantId, filter), { projection })
        .sort(sort)
        .skip(skip)
        .limit(Math.min(limit, 200))
        .toArray();
    },
    count: (tenantId, filter = {}) => col(name).countDocuments(scope(tenantId, filter)),
    async update(tenantId, id, set, extra = {}) {
      const res = await col(name).findOneAndUpdate(
        scope(tenantId, { _id: id }),
        { $set: { ...set, updatedAt: new Date() }, ...extra },
        { returnDocument: 'after' },
      );
      return res;
    },
    async updateWhere(tenantId, filter, set) {
      const res = await col(name).findOneAndUpdate(
        scope(tenantId, filter),
        { $set: { ...set, updatedAt: new Date() } },
        { returnDocument: 'after' },
      );
      return res;
    },
    async upsert(tenantId, filter, set) {
      const now = new Date();
      return col(name).findOneAndUpdate(
        scope(tenantId, filter),
        { $set: { ...set, updatedAt: now }, $setOnInsert: { _id: randomUUID(), createdAt: now } },
        { upsert: true, returnDocument: 'after' },
      );
    },
    aggregate: (tenantId, pipeline) => col(name).aggregate([{ $match: { tenantId } }, ...pipeline]).toArray(),
    raw: () => col(name),
  };
}

export async function page(repo, tenantId, filter, { page: p = 1, pageSize = 25, sort } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || 25, 1), 100);
  const pg = Math.max(Number(p) || 1, 1);
  const [items, total] = await Promise.all([
    repo.find(tenantId, filter, { sort, skip: (pg - 1) * size, limit: size }),
    repo.count(tenantId, filter),
  ]);
  return { items, page: pg, pageSize: size, total, totalPages: Math.ceil(total / size) };
}
