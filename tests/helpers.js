import { randomUUID } from 'node:crypto';
import { connectMongo, closeMongo, ensureIndexes, getDb } from '../src/db/mongo.js';

let mem;

/**
 * Isolated Mongo for tests. Prefers an in-memory mongod; if the binary cannot be obtained,
 * falls back to a throw-away database on MONGODB_ATLAS_URI (dropped afterwards).
 */
export async function startDb() {
  const name = `settla_test_${randomUUID().slice(0, 8)}`;
  try {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mem = await MongoMemoryServer.create();
    await connectMongo(mem.getUri(), name);
  } catch (e) {
    const uri = process.env.MONGODB_ATLAS_URI;
    if (!uri) throw new Error(`No Mongo available for tests (${e.message}). Set MONGODB_ATLAS_URI to a scratch cluster.`, { cause: e });
    await connectMongo(uri, name);
  }
  await ensureIndexes();
  return name;
}

export async function stopDb() {
  try { await getDb().dropDatabase(); } catch { /* ignore */ }
  await closeMongo();
  if (mem) await mem.stop();
  mem = undefined;
}

export async function makeTenant(slug = `t${randomUUID().slice(0, 6)}`, opts = {}) {
  const { createTenantWithUsers } = await import('../src/services/tenantService.js');
  return createTenantWithUsers({ name: slug, slug, ...opts }, 'Test!Passw0rd123');
}

export async function loginAs(app, request, email) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: 'Test!Passw0rd123' });
  return res.body.data?.accessToken;
}
