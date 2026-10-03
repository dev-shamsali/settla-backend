import crypto from 'node:crypto';
import { env } from '../config/env.js';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hmacSha256 = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
export const uuid = () => crypto.randomUUID();

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

const key = () => Buffer.from(env.ENCRYPTION_KEY, 'hex');

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(plain), 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

export function decrypt(blob) {
  const [iv, tag, data] = String(blob).split('.').map((p) => Buffer.from(p, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString('utf8'));
}

/** Stable JSON for request hashing. */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}
export const hashRequest = (obj) => sha256(stableStringify(obj));
