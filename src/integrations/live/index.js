import { env } from '../../config/env.js';
import { httpJson } from '../http.js';
import { notConfigured } from '../errors.js';

const basic = (id, secret) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
const TEMPLATES = new Set(['order_recovered', 'refund_initiated', 'escalation_ack', 'waiting_reversal', 'case_closed']);
const assertTemplate = (s, t) => { if (!TEMPLATES.has(t)) throw new Error(`${s}: template "${t}" not approved`); };

/**
 * Live adapters. Credentials come from per-tenant encrypted integration settings
 * (creds param) falling back to environment. Amounts: Settla uses whole rupees,
 * Razorpay uses paise, so we convert at this boundary only.
 */
export function createLiveAdapters(creds = {}) {
  const c = (k) => creds[k] || env[k] || '';

  const rzpHeaders = () => ({ authorization: basic(c('RAZORPAY_KEY_ID'), c('RAZORPAY_KEY_SECRET')) });
  const rzp = (path, opts = {}) => httpJson('razorpay', {
    url: c('RAZORPAY_KEY_ID') ? `https://api.razorpay.com/v1${path}` : '',
    headers: rzpHeaders(), allowedHosts: ['api.razorpay.com'], ...opts,
  });
  const mapPayment = (p) => p && ({
    id: p.id, status: p.status, amount: p.amount / 100, currency: p.currency, amountRefunded: (p.amount_refunded ?? 0) / 100,
    email: p.email, contact: p.contact, createdAt: new Date(p.created_at * 1000).toISOString(), notes: p.notes,
  });

  const payments = {
    system: 'razorpay',
    findPayment: async ({ reference }) => (reference ? mapPayment(await rzp(`/payments/${encodeURIComponent(reference)}`)) : null),
    listPayments: async ({ email }) => ((await rzp('/payments?count=100')).items ?? []).filter((p) => p.email === email).map(mapPayment),
    getPayment: async (id) => mapPayment(await rzp(`/payments/${encodeURIComponent(id)}`)),
    createRefund: async ({ paymentId, amount, idempotencyKey, reason }) => {
      const r = await rzp(`/payments/${encodeURIComponent(paymentId)}/refund`, {
        method: 'POST', body: { amount: Math.round(amount * 100), notes: { reason, idempotencyKey }, receipt: idempotencyKey.slice(0, 40) },
        headers: { ...rzpHeaders(), 'X-Refund-Idempotency': idempotencyKey },
      });
      return { id: r.id, paymentId, amount: r.amount / 100, status: r.status, idempotencyKey };
    },
    getRefund: async (id) => {
      const r = await rzp(`/refunds/${encodeURIComponent(id)}`);
      return { id: r.id, paymentId: r.payment_id, amount: r.amount / 100, status: r.status };
    },
  };

  const shop = (path, opts = {}) => {
    const domain = c('SHOPIFY_STORE_DOMAIN');
    return httpJson('shopify', {
      url: domain && c('SHOPIFY_ACCESS_TOKEN') ? `https://${domain}/admin/api/2024-10${path}` : '',
      headers: { 'X-Shopify-Access-Token': c('SHOPIFY_ACCESS_TOKEN') }, allowedHosts: ['myshopify.com'], ...opts,
    });
  };
  const mapOrder = (o) => o && ({
    id: String(o.id), orderNumber: o.name, paymentRef: (o.note_attributes ?? []).find((n) => n.name === 'payment_ref')?.value,
    customerEmail: o.email, items: (o.line_items ?? []).map((i) => ({ sku: i.sku, qty: i.quantity, price: Number(i.price) })),
    total: Number(o.total_price), status: o.cancelled_at ? 'cancelled' : 'open', paymentStatus: o.financial_status,
    stockReserved: (o.line_items ?? []).every((i) => i.fulfillable_quantity >= 0),
  });
  const orders = {
    system: 'shopify',
    findOrderByPaymentRef: async (ref) => {
      const r = await shop(`/orders.json?status=any&fields=id,name,email,total_price,line_items,note_attributes,financial_status,cancelled_at&limit=50`);
      return mapOrder((r.orders ?? []).find((o) => (o.note_attributes ?? []).some((n) => n.name === 'payment_ref' && n.value === ref))) ?? null;
    },
    findOrdersByCustomer: async (email) => ((await shop(`/orders.json?status=any&email=${encodeURIComponent(email)}`)).orders ?? []).map(mapOrder),
    getOrder: async (id) => mapOrder((await shop(`/orders/${encodeURIComponent(id)}.json`)).order),
    getInventory: async (skus) => {
      const r = await shop(`/variants.json?limit=250`);
      const bySku = Object.fromEntries((r.variants ?? []).map((v) => [v.sku, v.inventory_quantity]));
      return Object.fromEntries(skus.map((s) => [s, bySku[s] ?? 0]));
    },
    createOrder: async ({ paymentRef, customer, items, total, idempotencyKey }) => {
      const r = await shop('/orders.json', {
        method: 'POST',
        body: { order: {
          email: customer.email, financial_status: 'paid', inventory_behaviour: 'decrement_obeying_policy',
          line_items: items.map((i) => ({ sku: i.sku, quantity: i.qty, price: String(i.price) })),
          note_attributes: [{ name: 'payment_ref', value: paymentRef }, { name: 'idempotency_key', value: idempotencyKey }],
          transactions: [{ kind: 'sale', status: 'success', amount: String(total), gateway: 'razorpay' }],
        } },
      });
      return mapOrder(r.order);
    },
    cancelOrder: async (id) => {
      await shop(`/orders/${encodeURIComponent(id)}/cancel.json`, { method: 'POST', body: { restock: true } });
      return mapOrder((await shop(`/orders/${encodeURIComponent(id)}.json`)).order);
    },
  };

  const fd = (path, opts = {}) => httpJson('freshdesk', {
    url: c('FRESHDESK_DOMAIN') && c('FRESHDESK_API_KEY') ? `https://${c('FRESHDESK_DOMAIN')}.freshdesk.com/api/v2${path}` : '',
    headers: { authorization: basic(c('FRESHDESK_API_KEY'), 'X') }, allowedHosts: ['freshdesk.com'], ...opts,
  });
  const ticketing = {
    system: 'freshdesk',
    findTicket: (id) => fd(`/tickets/${encodeURIComponent(id)}`),
    createTicket: ({ subject, customerId }) => fd('/tickets', { method: 'POST', body: { subject, description: subject, email: customerId, status: 2, priority: 2 } }),
    updateTicket: (id, fields) => fd(`/tickets/${encodeURIComponent(id)}`, { method: 'PUT', body: fields }),
    addInternalNote: (id, note) => fd(`/tickets/${encodeURIComponent(id)}/notes`, { method: 'POST', body: { body: note, private: true } }),
    closeTicket: (id) => fd(`/tickets/${encodeURIComponent(id)}`, { method: 'PUT', body: { status: 5 } }),
  };

  const hs = (path, opts = {}) => httpJson('hubspot', {
    url: c('HUBSPOT_ACCESS_TOKEN') ? `https://api.hubapi.com${path}` : '',
    headers: { authorization: `Bearer ${c('HUBSPOT_ACCESS_TOKEN')}` }, allowedHosts: ['api.hubapi.com'], ...opts,
  });
  const ALLOWED = new Set(['lastResolutionAt', 'lastCaseId', 'lifecycleNote']);
  const crm = {
    system: 'hubspot',
    findCustomer: async ({ email }) => {
      if (!email) return null;
      const r = await hs('/crm/v3/objects/contacts/search', { method: 'POST', body: { filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }], limit: 1 } });
      const x = r.results?.[0];
      return x ? { id: x.id, email, name: x.properties?.firstname } : null;
    },
    getContext: async (id) => ({ id, ...(await hs(`/crm/v3/objects/contacts/${encodeURIComponent(id)}`)).properties }),
    updateCustomer: async (id, fields) => {
      const bad = Object.keys(fields).filter((k) => !ALLOWED.has(k));
      if (bad.length) throw new Error(`hubspot: fields not allow-listed: ${bad.join(',')}`);
      return hs(`/crm/v3/objects/contacts/${encodeURIComponent(id)}`, { method: 'PATCH', body: { properties: fields } });
    },
  };

  const wa = (body) => httpJson('whatsapp', {
    url: c('WHATSAPP_TOKEN') && c('WHATSAPP_PHONE_ID') ? `https://graph.facebook.com/v20.0/${c('WHATSAPP_PHONE_ID')}/messages` : '',
    method: 'POST', headers: { authorization: `Bearer ${c('WHATSAPP_TOKEN')}` }, allowedHosts: ['graph.facebook.com'], body,
  });
  const messaging = {
    system: 'whatsapp',
    sendTemplate: async ({ to, template, vars }) => {
      assertTemplate('whatsapp', template);
      const r = await wa({ messaging_product: 'whatsapp', to, type: 'template', template: { name: template, language: { code: 'en' }, components: [{ type: 'body', parameters: Object.values(vars ?? {}).map((v) => ({ type: 'text', text: String(v) })) }] } });
      return { id: r.messages?.[0]?.id, channel: 'whatsapp', to, template, status: 'sent' };
    },
  };

  const email = {
    system: 'email',
    sendTemplate: async () => { throw notConfigured('email (set SMTP/provider adapter)'); },
  };

  const escalationChannel = {
    system: 'slack',
    postEscalation: async (caseFile) => {
      const url = c('SLACK_WEBHOOK_URL');
      await httpJson('slack', { url, method: 'POST', allowedHosts: ['hooks.slack.com'], body: { text: `Escalation ${caseFile.caseNumber}: ₹${caseFile.amount} (${caseFile.reason})` } });
      return { id: `slack-${Date.now()}`, channel: '#cx-escalations' };
    },
  };

  return { payments, orders, ticketing, crm, messaging, email, escalationChannel };
}
