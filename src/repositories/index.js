import { tenantRepo } from './base.js';
import { C } from '../db/mongo.js';

export const repos = Object.fromEntries(
  Object.entries(C)
    .filter(([k]) => !['tenants', 'users', 'sessions', 'webhookEvents'].includes(k))
    .map(([k, v]) => [k, tenantRepo(v)]),
);
