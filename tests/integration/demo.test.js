import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startDb, stopDb, makeTenant } from '../helpers.js';
import { makeCtx, makeClock } from '../../src/lib/context.js';
import { runDemoCase } from '../../src/services/demoService.js';
import { getWorld } from '../../src/integrations/index.js';

describe('demo: money debited, no order (UrbanStep / Ananya / pay_Q7xK2)', () => {
  let tenant;
  beforeAll(async () => { await startDb(); ({ tenant } = await makeTenant()); });
  afterAll(stopDb);

  it('recovers the order autonomously, verifies, notifies, closes ticket, 27s simulated', async () => {
    const ctx = makeCtx({ tenant, clock: makeClock({ simulated: true }) });
    const { result, case: detail } = await runDemoCase(ctx);
    expect(result.status).toBe('RESOLVED');
    expect(detail.case.status).toBe('RESOLVED');
    expect(detail.case.autonomous).toBe(true);
    expect(detail.case.amount).toBe(3499);
    expect(detail.case.risk.score).toBe(0.08);
    expect(detail.case.risk.level).toBe('LOW');
    expect(detail.case.resolutionMs).toBe(27000);
    const w = getWorld(tenant._id);
    expect([...w.orders.values()]).toHaveLength(1);
    expect(w.inventory['URB-SNK-8']).toBe(3);
    expect(w.tickets.get('FD-1001').status).toBe('closed');
    expect(w.outbox[0].template).toBe('order_recovered');
    expect(detail.traces[0].verification).toBe('PASSED');
    expect(detail.actions.filter((a) => a.state === 'VERIFIED').length).toBeGreaterThanOrEqual(4);
  });
});

describe('case detail data integrity', () => {
  beforeAll(startDb);
  afterAll(stopDb);
  it('shows the order created for this case and this case\'s own cart (not another case\'s)', async () => {
    const { tenant: t } = await makeTenant();
    const ctx = makeCtx({ tenant: t, clock: makeClock({ simulated: true }) });
    const { case: a } = await runDemoCase(ctx, { scenario: 'high_value' }); // ₹18,750 cart, escalated
    const { case: b } = await runDemoCase(ctx); // ₹3,499, recovered
    expect(b.cart.total).toBe(3499);
    expect(b.orders).toHaveLength(1);
    expect(b.orders[0]).toMatchObject({ orderNumber: b.case.orderNumber, total: 3499 });
    expect(a.cart.total).toBe(18750);
    expect(a.orders).toHaveLength(0);
  });
});
