import './observability/otel.js';
import { env } from './config/env.js';
import { connectMongo, ensureIndexes, closeMongo } from './db/mongo.js';
import { createApp } from './app.js';
import { registerAllHandlers } from './workers/handlers.js';
import { closeQueues } from './queues/index.js';
import { logger } from './lib/logger.js';

await connectMongo();
await ensureIndexes();
registerAllHandlers();
const app = createApp();
const server = app.listen(env.PORT, () => logger.info({ port: env.PORT, mode: env.INTEGRATION_MODE }, 'settla-backend listening'));

async function shutdown(sig) {
  logger.info({ sig }, 'shutting down');
  server.close(async () => { await closeQueues(); await closeMongo(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => logger.error({ err: String(e) }, 'unhandledRejection'));
