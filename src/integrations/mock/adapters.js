import { getWorld, checkFault, newId } from './world.js';
import { failErr } from '../errors.js';

const TEMPLATES = new Set(['order_recovered', 'refund_initiated', 'escalation_ack', 'waiting_reversal', 'case_closed']);
export const CRM_ALLOWED_FIELDS = new Set(['lastResolutionAt', 'lastCaseId', 'tags', 'lifecycleNote']);

const assertTemplate = (system, t) => {
  if (!TEMPLATES.has(t)) throw failErr(system, `template "${t}" not approved`);
};

export function createMockAdapters(tenantId) {
  const w = () => getWorld(tenantId);

  const payments = {
    system: 'razorpay',
    async findPayment({ reference, email }) {
      checkFault(tenantId, 'razorpay', 'findPayment');
      return [...w().payments.values()].find((p) => p.id === reference || (email && p.email === email)) ?? null;
    },
    async listPayments({ email }) {
      checkFault(tenantId, 'razorpay', 'listPayments');
      return [...w().payments.values()].filter((p) => p.email === email);
    },
    async getPayment(id) {
      checkFault(tenantId, 'razorpay', 'getPayment');
      return w().payments.get(id) ?? null;
    },
    async createRefund({ paymentId, amount, idempotencyKey, reason }) {
      const soft = checkFault(tenantId, 'razorpay', 'createRefund');
      const p = w().payments.get(paymentId);
      if (!p) throw failErr('razorpay', 'payment not found');
      const dupe = [...w().refunds.values()].find((r) => r.idempotencyKey === idempotencyKey);
      if (dupe) return dupe; // gateway-side idempotency
      if (amount > p.amount - p.amountRefunded) throw failErr('razorpay', 'refund exceeds balance');
      const refund = { id: newId('rfnd'), paymentId, amount, status: soft === 'verification_mismatch' ? 'pending' : 'processed', idempotencyKey, reason };
      w().refunds.set(refund.id, refund);
      if (refund.status === 'processed') {
        p.amountRefunded += amount;
        p.status = p.amountRefunded >= p.amount ? 'refunded' : 'partially_refunded';
      }
      return refund;
    },
    async getRefund(id) {
      checkFault(tenantId, 'razorpay', 'getRefund');
      return w().refunds.get(id) ?? null;
    },
  };

  const orders = {
    system: 'shopify',
    async findOrderByPaymentRef(ref) {
      checkFault(tenantId, 'shopify', 'findOrderByPaymentRef');
      return [...w().orders.values()].find((o) => o.paymentRef === ref) ?? null;
    },
    async findOrdersByCustomer(email) {
      checkFault(tenantId, 'shopify', 'findOrdersByCustomer');
      return [...w().orders.values()].filter((o) => o.customerEmail === email);
    },
    async getOrder(id) {
      const soft = checkFault(tenantId, 'shopify', 'getOrder');
      const o = w().orders.get(id) ?? null;
      if (o && soft === 'verification_mismatch') return { ...o, total: o.total + 1 };
      return o;
    },
    async getInventory(skus) {
      checkFault(tenantId, 'shopify', 'getInventory');
      return Object.fromEntries(skus.map((s) => [s, w().inventory[s] ?? 0]));
    },
    async createOrder({ paymentRef, customer, items, total, idempotencyKey }) {
      const soft = checkFault(tenantId, 'shopify', 'createOrder');
      const existing = [...w().orders.values()].find((o) => o.idempotencyKey === idempotencyKey || o.paymentRef === paymentRef);
      if (existing) return { ...existing, duplicate: true };
      if (soft === 'duplicate') {
        // simulate a pre-existing racing order created by another system
        const racing = { id: newId('ord'), orderNumber: `#R${Math.floor(Math.random() * 9000 + 1000)}`, paymentRef, customerEmail: customer.email, items, total, status: 'open', stockReserved: true };
        w().orders.set(racing.id, racing);
        return { ...racing, duplicate: true };
      }
      for (const i of items) {
        if ((w().inventory[i.sku] ?? 0) < i.qty) throw failErr('shopify', `insufficient stock for ${i.sku}`);
      }
      items.forEach((i) => { w().inventory[i.sku] -= i.qty; });
      const order = {
        id: newId('ord'), orderNumber: `#${1000 + w().orders.size + 1}`, paymentRef, customerEmail: customer.email,
        customerName: customer.name, items, total, status: 'open', paymentStatus: 'paid', stockReserved: true, idempotencyKey,
        createdAt: new Date().toISOString(),
      };
      w().orders.set(order.id, order);
      return order;
    },
    async cancelOrder(id) {
      checkFault(tenantId, 'shopify', 'cancelOrder');
      const o = w().orders.get(id);
      if (!o) throw failErr('shopify', 'order not found');
      if (o.status !== 'cancelled') {
        o.items.forEach((i) => { w().inventory[i.sku] = (w().inventory[i.sku] ?? 0) + i.qty; });
        o.status = 'cancelled';
        o.stockReserved = false;
      }
      return o;
    },
  };

  const ticketing = {
    system: 'freshdesk',
    async findTicket(id) { checkFault(tenantId, 'freshdesk', 'findTicket'); return w().tickets.get(id) ?? null; },
    async createTicket({ subject, customerId }) {
      checkFault(tenantId, 'freshdesk', 'createTicket');
      const t = { id: newId('FD'), status: 'open', subject, customerId, notes: [] };
      w().tickets.set(t.id, t);
      return t;
    },
    async updateTicket(id, fields) {
      checkFault(tenantId, 'freshdesk', 'updateTicket');
      const t = w().tickets.get(id);
      if (!t) throw failErr('freshdesk', 'ticket not found');
      Object.assign(t, fields);
      return t;
    },
    async addInternalNote(id, note) {
      checkFault(tenantId, 'freshdesk', 'addInternalNote');
      const t = w().tickets.get(id);
      if (!t) throw failErr('freshdesk', 'ticket not found');
      t.notes.push({ private: true, body: note, at: new Date().toISOString() });
      return t;
    },
    async closeTicket(id) {
      checkFault(tenantId, 'freshdesk', 'closeTicket');
      const t = w().tickets.get(id);
      if (!t) throw failErr('freshdesk', 'ticket not found');
      t.status = 'closed';
      return t;
    },
  };

  const crm = {
    system: 'hubspot',
    async findCustomer({ email, phone }) {
      checkFault(tenantId, 'hubspot', 'findCustomer');
      return [...w().customers.values()].find((c) => (email && c.email === email) || (phone && c.phone === phone)) ?? null;
    },
    async getContext(id) {
      checkFault(tenantId, 'hubspot', 'getContext');
      const c = w().customers.get(id);
      return c ? { ...c, previousInteractions: c.previousInteractions ?? [], refundCount: c.refundCount ?? 0, paymentsLast24h: c.paymentsLast24h ?? 1 } : null;
    },
    async updateCustomer(id, fields) {
      checkFault(tenantId, 'hubspot', 'updateCustomer');
      const bad = Object.keys(fields).filter((k) => !CRM_ALLOWED_FIELDS.has(k));
      if (bad.length) throw failErr('hubspot', `fields not allow-listed: ${bad.join(',')}`);
      const c = w().customers.get(id);
      if (!c) throw failErr('hubspot', 'customer not found');
      Object.assign(c, fields);
      w().crmWrites.push({ id, fields });
      return c;
    },
  };

  const messaging = {
    system: 'whatsapp',
    async sendTemplate({ to, template, vars }) {
      checkFault(tenantId, 'whatsapp', 'sendTemplate');
      assertTemplate('whatsapp', template);
      const m = { id: newId('wamid'), channel: 'whatsapp', to, template, vars, status: 'sent' };
      w().outbox.push(m);
      return m;
    },
  };

  const email = {
    system: 'email',
    async sendTemplate({ to, template, vars }) {
      checkFault(tenantId, 'email', 'sendTemplate');
      assertTemplate('email', template);
      const m = { id: newId('eml'), channel: 'email', to, template, vars, status: 'sent' };
      w().outbox.push(m);
      return m;
    },
  };

  const escalationChannel = {
    system: 'slack',
    async postEscalation(caseFile) {
      checkFault(tenantId, 'slack', 'postEscalation');
      const post = { id: newId('slk'), channel: '#cx-escalations', caseFile };
      w().escalationPosts.push(post);
      return post;
    },
  };

  return { payments, orders, ticketing, crm, messaging, email, escalationChannel };
}
