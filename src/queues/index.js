import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { env, isTest } from '../config/env.js';
import { logger } from '../lib/logger.js';

export const QUEUES = ['case-processing', 'ai-planning', 'tool-execution', 'verification', 'notifications', 'webhooks', 'analytics', 'retry', 'escalations'];
const MAX_ATTEMPTS = 4;

const handlers = new Map(); // queue -> fn(job)
const deadLetter = [];
let redis;
const bullQueues = new Map();
const bullWorkers = [];
const timers = new Set();

export const useRedis = () => !!env.REDIS_URL && !isTest;

export function registerHandler(queue, fn) {
  handlers.set(queue, fn);
  if (useRedis()) {
    redis ??= new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    bullWorkers.push(new Worker(queue, (job) => fn({ name: job.name, data: job.data }), { connection: redis, concurrency: 5 }));
  }
}

function getQueue(name) {
  if (!bullQueues.has(name)) {
    redis ??= new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    bullQueues.set(name, new Queue(name, {
      connection: redis,
      defaultJobOptions: { attempts: MAX_ATTEMPTS, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 1000, removeOnFail: 5000 },
    }));
  }
  return bullQueues.get(name);
}

async function runInline(queue, name, data, attempt = 1) {
  const fn = handlers.get(queue);
  if (!fn) return;
  try {
    await fn({ name, data });
  } catch (e) {
    if (attempt >= MAX_ATTEMPTS) {
      deadLetter.push({ queue, name, data, error: e.message, at: new Date() });
      logger.error({ queue, name, err: e.message }, 'job dead-lettered');
      return;
    }
    const t = setTimeout(() => { timers.delete(t); runInline(queue, name, data, attempt + 1); }, isTest ? 0 : 500 * 2 ** attempt);
    t.unref?.();
    timers.add(t);
  }
}

/** BullMQ when REDIS_URL set (prod); bounded in-process fallback otherwise (dev/test). */
export async function enqueue(queue, name, data, { delay = 0 } = {}) {
  if (!QUEUES.includes(queue)) throw new Error(`Unknown queue ${queue}`);
  if (useRedis()) return getQueue(queue).add(name, data, { delay });
  if (isTest) return null; // tests drive handlers explicitly; no stray timers
  const t = setTimeout(() => { timers.delete(t); runInline(queue, name, data); }, Math.min(delay, 2 ** 30));
  t.unref?.();
  timers.add(t);
  return null;
}

export const getDeadLetters = () => [...deadLetter];

export async function closeQueues() {
  timers.forEach(clearTimeout);
  timers.clear();
  await Promise.all(bullWorkers.map((w) => w.close()));
  await Promise.all([...bullQueues.values()].map((q) => q.close()));
  await redis?.quit().catch(() => {});
}
