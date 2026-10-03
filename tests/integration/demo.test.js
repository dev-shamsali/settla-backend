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
