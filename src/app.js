import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { env, isTest } from './config/env.js';
import { logger } from './lib/logger.js';
import { requestContext, errorHandler, notFoundHandler, globalLimiter } from './middlewares/index.js';
import { apiRouter, webhookRouter } from './routes/index.js';
import { healthCtl } from './controllers/index.js';
import { openapi } from './docs/openapi.js';

export function createApp({ authLimit = isTest ? 100000 : 10 } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(requestContext);
  if (!isTest) app.use(pinoHttp({ logger, genReqId: (req) => req.id, autoLogging: { ignore: (req) => req.url === '/health' } }));
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, crossOriginResourcePolicy: { policy: 'same-site' } }));

  const origins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || origins.includes(origin)),
    credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['content-type', 'authorization', 'idempotency-key', 'x-requested-with', 'x-request-id'], maxAge: 600,
  }));
  app.use(compression());
  app.use(cookieParser());
  app.use(globalLimiter(isTest ? 100000 : 600));

  // raw body retained for webhook HMAC verification; hard 100kb cap everywhere
  app.use(express.json({ limit: '100kb', verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }));

  app.get('/health', healthCtl);
  app.get('/api/v1/openapi.json', (req, res) => res.json(openapi));
  app.use('/api/v1', apiRouter({ authLimit }));
  app.use('/webhooks', webhookRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
