import { z } from 'zod';
import { AppError } from '../lib/errors.js';

const item = z.object({ sku: z.string().max(64), qty: z.number().int().positive().max(100), price: z.number().nonnegative(), name: z.string().max(200).optional() }).strict();

/** Typed, allow-listed tools. Params are strictly validated; unknown keys rejected. */
export const toolSpecs = {
  recover_order: {
    schema: z.object({ paymentId: z.string().max(64), total: z.number().positive(), items: z.array(item).min(1).max(50) }).strict(),
    sensitive: true,
    compensatable: true,
  },
  refund_payment: {
    schema: z.object({ paymentId: z.string().max(64), amount: z.number().positive(), reason: z.string().max(200).default('requested') }).strict(),
    sensitive: true,
    compensatable: false,
  },
  wait_for_reversal: {
    schema: z.object({ paymentId: z.string().max(64), recheckAfterHours: z.number().int().min(1).max(240).default(24) }).strict(),
    sensitive: false,
    compensatable: false,
  },
  escalate: {
    schema: z.object({ reason: z.string().max(200), detail: z.string().max(1000).optional() }).strict(),
    sensitive: false,
    compensatable: false,
  },
  notify_customer: {
    schema: z.object({ template: z.enum(['order_recovered', 'refund_initiated', 'escalation_ack', 'waiting_reversal', 'case_closed']), vars: z.record(z.string(), z.union([z.string().max(200), z.number()])).default({}) }).strict(),
    sensitive: false,
    compensatable: false,
  },
  close_ticket: {
    schema: z.object({ ticketId: z.string().max(64), note: z.string().max(500).optional() }).strict(),
    sensitive: false,
    compensatable: false,
  },
  update_crm: {
    schema: z.object({ fields: z.record(z.string(), z.union([z.string().max(300), z.number(), z.array(z.string().max(60)).max(20)])) }).strict(),
    sensitive: false,
    compensatable: false,
  },
};

export function parseToolParams(tool, params) {
  const spec = toolSpecs[tool];
  if (!spec) throw new AppError('TOOL_NOT_ALLOWED', `Tool "${tool}" is not allow-listed`, 400);
  const r = spec.schema.safeParse(params ?? {});
  if (!r.success) {
    throw new AppError('TOOL_PARAMS_INVALID', `Invalid parameters for ${tool}: ${r.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`, 400);
  }
  return r.data;
}
