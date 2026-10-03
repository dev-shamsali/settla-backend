import { z } from 'zod';
import { CASE_STATES } from '../domain/stateMachines.js';
import { ROLES } from '../security/rbac.js';

const id = z.string().min(1).max(64).regex(/^[\w-]+$/);
const strict = (o) => z.object(o).strict();
const pageQ = { page: z.coerce.number().int().min(1).max(10000).optional(), pageSize: z.coerce.number().int().min(1).max(100).optional(), sort: z.string().max(30).optional(), order: z.enum(['asc', 'desc']).optional() };

export const v = {
  idParam: strict({ id }),
  login: strict({ email: z.string().email().max(254), password: z.string().min(1).max(200) }),
  refresh: z.object({ refreshToken: z.string().min(20).max(200).optional() }).strict(),
  listCases: z.object({ ...pageQ, status: z.string().max(200).optional(), risk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(), autonomous: z.enum(['true', 'false', '']).optional(), search: z.string().max(80).optional(), customerId: id.optional() }).strict(),
  createCase: strict({
    paymentId: z.string().min(3).max(64).regex(/^[\w-]+$/), customerEmail: z.string().email().max(254).optional(), customerPhone: z.string().max(20).optional(),
    customerMessage: z.string().max(4000).optional(), ticketId: z.string().max(64).optional(), channel: z.enum(['whatsapp', 'email', 'freshdesk', 'api', 'manual']).default('api'),
    process: z.boolean().default(true),
  }),
  listGeneric: z.object({ ...pageQ, status: z.string().max(40).optional(), search: z.string().max(80).optional() }).strict(),
  refund: strict({ amount: z.number().positive().max(10_000_000).optional(), reason: z.string().max(200).optional() }),
  approvalDecision: strict({ decision: z.enum(['approve', 'reject']), note: z.string().max(500).optional(), editedAmount: z.number().positive().optional() }),
  escalationAction: strict({ action: z.enum(['take_over', 'retry', 'refund', 'close']), note: z.string().max(500).optional(), amount: z.number().positive().optional() }),
  executionMode: strict({ mode: z.enum(['AUTONOMOUS', 'RECOMMEND_ONLY', 'DISABLED']), reason: z.string().max(300).optional() }),
  createUser: strict({ email: z.string().email().max(254), name: z.string().min(1).max(100), password: z.string().min(12).max(128), role: z.enum(ROLES).refine((r) => r !== 'SUPER_ADMIN', 'not assignable') }),
  patchUser: strict({ role: z.enum(ROLES).refine((r) => r !== 'SUPER_ADMIN').optional(), status: z.enum(['active', 'disabled']).optional(), grantedPermissions: z.array(z.string().max(40)).max(50).optional(), revokedPermissions: z.array(z.string().max(40)).max(50).optional() }),
  integrationParam: strict({ type: z.enum(['razorpay', 'shopify', 'freshdesk', 'hubspot', 'whatsapp', 'slack', 'email']) }),
  integrationPut: strict({ credentials: z.record(z.string().max(60), z.string().max(500)).optional(), mode: z.enum(['mock', 'live']).optional(), enabled: z.boolean().optional() }),
  automationDispatch: strict({ proposal: z.record(z.string(), z.unknown()) }),
  analytics: z.object({ days: z.coerce.number().int().min(1).max(365).optional() }).strict(),
  auditQ: z.object({ ...pageQ, resourceType: z.string().max(40).optional(), resourceId: z.string().max(64).optional(), action: z.string().max(60).optional() }).strict(),
  knowledge: strict({ title: z.string().min(1).max(200), kind: z.enum(['policy', 'product', 'procedure', 'resolution_rule']), body: z.string().min(1).max(20000) }),
  knowledgeSearch: z.object({ q: z.string().min(1).max(200) }).strict(),
  caseStatusFilter: z.enum(CASE_STATES),
};
