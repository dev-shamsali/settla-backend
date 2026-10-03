import { MongoClient } from 'mongodb';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

export const C = Object.freeze({
  tenants: 'tenants',
  users: 'users',
  sessions: 'sessions',
  apiKeys: 'api_keys',
  cases: 'cases',
  caseEvents: 'case_events',
  caseTransitions: 'case_state_transitions',
  customers: 'customers',
  payments: 'payments',
  paymentEvents: 'payment_events',
  orders: 'orders',
  cartSnapshots: 'cart_snapshots',
  decisions: 'decisions',
  decisionTraces: 'decision_traces',
  policies: 'policies',
  policyEvaluations: 'policy_evaluations',
  riskAssessments: 'risk_assessments',
  actions: 'actions',
  actionAttempts: 'action_attempts',
  actionVerifications: 'action_verifications',
  approvals: 'approvals',
  escalations: 'escalations',
  messages: 'messages',
  integrations: 'integrations',
  auditLogs: 'audit_logs',
  knowledge: 'knowledge_documents',
  analyticsEvents: 'analytics_events',
  notifications: 'notifications',
  idempotency: 'idempotency_keys',
  webhookEvents: 'webhook_events',
});

let client;
let db;

export async function connectMongo(uri = env.MONGODB_URI, dbName = env.MONGODB_DB) {
  if (db) return db;
  client = new MongoClient(uri, { maxPoolSize: 20, serverSelectionTimeoutMS: 15000, retryWrites: true });
  await client.connect();
  db = client.db(dbName);
  logger.info({ db: dbName }, 'mongo connected');
  return db;
}

export const getDb = () => {
  if (!db) throw new Error('Mongo not connected');
  return db;
};
export const col = (name) => getDb().collection(name);

export async function closeMongo() {
  if (client) await client.close();
  client = undefined;
  db = undefined;
}

/** Idempotent index creation. Every tenant-owned collection leads with tenantId. */
export async function ensureIndexes() {
  const t = (name, specs) => Promise.all(specs.map(([keys, opts]) => col(name).createIndex(keys, opts)));
  await t(C.tenants, [[{ slug: 1 }, { unique: true }]]);
  await t(C.users, [
    [{ email: 1 }, { unique: true }],
    [{ tenantId: 1, role: 1 }, {}],
  ]);
  await t(C.sessions, [
    [{ tokenHash: 1 }, { unique: true }],
    [{ userId: 1 }, {}],
    [{ expiresAt: 1 }, { expireAfterSeconds: 0 }],
  ]);
  await t(C.cases, [
    [{ tenantId: 1, caseNumber: 1 }, { unique: true }],
    [{ tenantId: 1, status: 1, createdAt: -1 }, {}],
    [{ tenantId: 1, paymentId: 1 }, {}],
    [{ tenantId: 1, customerId: 1 }, {}],
  ]);
  await t(C.caseEvents, [[{ tenantId: 1, caseId: 1, ts: 1 }, {}]]);
  await t(C.caseTransitions, [[{ tenantId: 1, caseId: 1, ts: 1 }, {}]]);
  await t(C.customers, [[{ tenantId: 1, email: 1 }, {}], [{ tenantId: 1, phone: 1 }, {}]]);
  await t(C.payments, [[{ tenantId: 1, gatewayPaymentId: 1 }, { unique: true }], [{ tenantId: 1, customerId: 1 }, {}]]);
  await t(C.orders, [[{ tenantId: 1, orderNumber: 1 }, { unique: true }], [{ tenantId: 1, paymentRef: 1 }, {}]]);
  await t(C.cartSnapshots, [[{ tenantId: 1, customerId: 1, createdAt: -1 }, {}]]);
  await t(C.decisions, [[{ tenantId: 1, caseId: 1, createdAt: -1 }, {}]]);
  await t(C.decisionTraces, [[{ tenantId: 1, caseId: 1 }, {}]]);
  await t(C.policies, [[{ tenantId: 1, key: 1, version: 1 }, { unique: true }]]);
  await t(C.actions, [
    [{ tenantId: 1, caseId: 1 }, {}],
    [{ tenantId: 1, idempotencyKey: 1 }, { unique: true }],
  ]);
  await t(C.approvals, [[{ tenantId: 1, status: 1, createdAt: -1 }, {}]]);
  await t(C.escalations, [[{ tenantId: 1, status: 1, createdAt: -1 }, {}]]);
  await t(C.messages, [[{ tenantId: 1, caseId: 1, createdAt: 1 }, {}]]);
  await t(C.integrations, [[{ tenantId: 1, type: 1 }, { unique: true }]]);
  await t(C.auditLogs, [[{ tenantId: 1, createdAt: -1 }, {}], [{ tenantId: 1, resourceType: 1, resourceId: 1 }, {}]]);
  await t(C.knowledge, [[{ tenantId: 1, kind: 1 }, {}]]);
  await t(C.analyticsEvents, [[{ tenantId: 1, type: 1, ts: -1 }, {}]]);
  await t(C.notifications, [[{ tenantId: 1, userId: 1, read: 1, createdAt: -1 }, {}]]);
  await t(C.idempotency, [
    [{ tenantId: 1, actionType: 1, key: 1 }, { unique: true }],
    [{ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 }],
  ]);
  await t(C.webhookEvents, [
    [{ source: 1, eventId: 1 }, { unique: true }],
    [{ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 3 }],
  ]);
}
