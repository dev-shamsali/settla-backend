import { z } from 'zod';

/**
 * n8n executes backend-APPROVED integration steps only. Money-moving actions are deliberately
 * absent from the allow-list: the Settla backend (and later its Razorpay adapter) owns them.
 */
export const READ_ONLY_ACTIONS = ['investigate_payment', 'payment_lookup', 'order_lookup'];
export const SIDE_EFFECT_ACTIONS = ['notify_customer', 'sync_crm', 'update_ticket'];
export const N8N_ACTIONS = [...READ_ONLY_ACTIONS, ...SIDE_EFFECT_ACTIONS];
export const FINANCIAL_ACTIONS = ['refund', 'create_refund', 'capture_payment', 'initiate_payment', 'create_instant_settlement', 'payout'];

/** Permission the human/agent actor must hold in addition to automation:dispatch. */
export const ACTION_PERMISSION = { notify_customer: 'messages:send', sync_crm: 'crm:write', update_ticket: 'tickets:write' };
export const ACTION_SERVICE = { investigate_payment: 'razorpay', payment_lookup: 'razorpay', order_lookup: 'shopify', notify_customer: 'whatsapp', sync_crm: 'hubspot', update_ticket: 'freshdesk' };

export const WORKFLOW_NAME = 'SETTLA - PAYMENT RESOLUTION';
export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

const id = z.string().min(1).max(64).regex(/^[\w-]+$/);

/** What the backend sends to n8n. Contains no recipient phone numbers and no secrets. */
export const n8nRequestSchema = z.object({
  correlationId: z.string().min(8).max(64).regex(/^[\w-]+$/),
  caseId: id,
  customerId: id,
  paymentId: id,
  orderId: id.nullable().optional(),
  amount: z.number().nonnegative().max(10_000_000),
  currency: z.literal('INR'),
  issue: z.string().max(500),
  requestedAction: z.enum(N8N_ACTIONS),
  authorization: z.object({
    approved: z.literal(true),
    decisionId: z.string().min(1).max(64),
    policyVersion: z.string().min(1).max(40),
    riskLevel: z.enum(RISK_LEVELS),
    humanApprovalSatisfied: z.boolean(),
    approvalId: z.string().max(64).optional().nullable(),
    expiresAt: z.string().datetime(),
  }).strict(),
  notification: z.object({ template: z.enum(['order_recovered', 'refund_initiated', 'escalation_ack', 'waiting_reversal', 'case_closed']), recipientRef: z.literal('SETTLA_TEST_WHATSAPP_NUMBER') }).strict().optional(),
}).strict();

export const n8nResponseSchema = z.object({
  success: z.boolean(),
  caseId: z.string(),
  correlationId: z.string(),
  action: z.string().optional(),
  workflow: z.object({ name: z.string(), executionId: z.string().nullable().optional() }).optional(),
  signatureVerified: z.boolean().optional(),
  result: z.object({ externalService: z.string(), mode: z.string(), data: z.record(z.string(), z.unknown()) }).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

/** Rhea's proposal. Untrusted until the backend decision layer validates it. */
export const proposalSchema = z.object({
  caseId: id,
  decision: z.enum(['investigate', 'notify', 'sync', 'update_ticket', 'refund', 'escalate']),
  action: z.string().min(1).max(60),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  requiresHumanApproval: z.boolean(),
  notification: z.object({ template: z.string().max(40) }).strict().optional(),
}).strict();
