import { connectMongo, ensureIndexes } from '../db/mongo.js';
import { registerAllHandlers } from './handlers.js';
import { logger } from '../lib/logger.js';

// Dedicated worker process (requires REDIS_URL so BullMQ workers attach).
await connectMongo();
await ensureIndexes();
registerAllHandlers();
logger.info('settla workers running');
