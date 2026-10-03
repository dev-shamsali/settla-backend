import Ajv from 'ajv';
import addFormats from 'ajv-formats';

export const DECISIONS = ['RECOVER_ORDER', 'REFUND', 'WAIT_FOR_AUTO_REVERSAL', 'ESCALATE'];
export const TOOLS = ['recover_order', 'refund_payment', 'wait_for_reversal', 'escalate'];

export const planJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'confidence', 'risk', 'evidence', 'policy', 'required_permission', 'amount', 'tool', 'parameters', 'idempotency_key', 'verification_plan'],
  properties: {
    decision: { enum: DECISIONS },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    risk: { enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
    evidence: { type: 'array', maxItems: 25, items: { type: 'string', maxLength: 400 } },
    policy: { type: 'string', maxLength: 80 },
    required_permission: { type: 'string', maxLength: 60 },
    amount: { type: 'number', minimum: 0, maximum: 10_000_000 },
    tool: { enum: TOOLS },
    parameters: { type: 'object', maxProperties: 20 },
    idempotency_key: { type: 'string', minLength: 8, maxLength: 128 },
    verification_plan: { type: 'array', maxItems: 15, items: { type: 'string', maxLength: 200 } },
    reasoning_summary: { type: 'string', maxLength: 1000 },
    escalation_reason: { type: 'string', maxLength: 400 },
  },
};

const ajv = new Ajv({ allErrors: true, removeAdditional: false, strict: true });
addFormats(ajv);
const validate = ajv.compile(planJsonSchema);

export function validatePlan(plan) {
  const ok = validate(plan);
  return ok ? { ok: true, plan } : { ok: false, errors: (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`) };
}

/** Parse raw LLM text into a JSON object (tolerates a fenced block, nothing else). */
export function parsePlanText(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    const obj = JSON.parse(cleaned);
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['not an object'] };
    return { ok: true, value: obj };
  } catch (e) {
    return { ok: false, errors: [`invalid JSON: ${e.message}`] };
  }
}
