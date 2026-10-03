import 'dotenv/config';
import { z } from 'zod';

const opt = z.string().optional().default('');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  MONGODB_URI: z.string().min(1),
  MONGODB_DB: z.string().default('settla_dev'),
  REDIS_URL: opt,
  N8N_MODE: z.enum(['mock', 'live']).default('mock'),
  N8N_WEBHOOK_URL: opt,
  N8N_SIGNING_SECRET: opt,
  N8N_WEBHOOK_AUTH_TOKEN: opt,
  N8N_ALLOWED_HOSTS: z.string().optional().default('n8n.cloud'),
  SETTLA_TEST_WHATSAPP_NUMBER: opt,
  AUTH_RATE_LIMIT: z.coerce.number().int().min(1).default(10),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(7),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'must be 64 hex chars'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  INTEGRATION_MODE: z.enum(['mock', 'live']).default('mock'),
  LLM_PROVIDER: z.enum(['mock', 'anthropic', 'gemini']).default('mock'),
  GEMINI_API_KEY: opt,
  GEMINI_MODEL: z.string().regex(/^[\w.-]{1,60}$/).default('gemini-3.6-flash'),
  ANTHROPIC_API_KEY: opt,
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  RAZORPAY_KEY_ID: opt,
  RAZORPAY_KEY_SECRET: opt,
  RAZORPAY_WEBHOOK_SECRET: opt,
  SHOPIFY_STORE_DOMAIN: opt,
  SHOPIFY_ACCESS_TOKEN: opt,
  SHOPIFY_WEBHOOK_SECRET: opt,
  FRESHDESK_WEBHOOK_SECRET: opt,
  WHATSAPP_WEBHOOK_SECRET: opt,
  SLACK_WEBHOOK_URL: opt,
  OTEL_EXPORTER_OTLP_ENDPOINT: opt,
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Never print values, only which keys failed.
  const keys = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
  throw new Error(`Invalid environment configuration: ${keys}`);
}

export const env = Object.freeze(parsed.data);
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const AUTO_REFUND_LIMIT_INR = 5000;
export const CONFIDENCE_THRESHOLD = 0.75;
