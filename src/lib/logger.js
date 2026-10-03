import pino from 'pino';
import { env, isTest } from '../config/env.js';

export const REDACT_PATHS = [
  'password', '*.password', 'token', '*.token', 'accessToken', 'refreshToken', '*.accessToken',
  '*.refreshToken', 'apiKey', '*.apiKey', 'secret', '*.secret', 'authorization',
  'req.headers.authorization', 'req.headers.cookie', 'headers.authorization', 'cardNumber',
  '*.cardNumber', 'cvv', '*.cvv', 'credentials', '*.credentials',
];

export const logger = pino({
  level: isTest ? 'silent' : env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  base: { service: 'settla-backend' },
});
