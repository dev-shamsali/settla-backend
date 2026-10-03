import { connectMongo, ensureIndexes, closeMongo } from './mongo.js';

// MongoDB is schemaless: "migration" = idempotent index/constraint creation.
await connectMongo();
await ensureIndexes();
console.log('indexes ensured');
await closeMongo();
