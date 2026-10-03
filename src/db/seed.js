import { connectMongo, ensureIndexes, closeMongo, col, C } from './mongo.js';
import { createTenantWithUsers } from '../services/tenantService.js';
import { createUser } from '../services/authService.js';
import { seedKnowledge } from '../services/demoService.js';
import { randomUUID } from 'node:crypto';

export const DEMO_PASSWORD = 'Settla!Demo123';

await connectMongo();
await ensureIndexes();

let t = await col(C.tenants).findOne({ slug: 'urbanstep' });
if (!t) {
  const r = await createTenantWithUsers({ name: 'UrbanStep Support (DEMO)', slug: 'urbanstep' }, DEMO_PASSWORD);
  t = r.tenant;
  await createUser({ tenantId: t._id, email: 'super@settla.test', name: 'Super Admin', password: DEMO_PASSWORD, role: 'SUPER_ADMIN' }).catch(() => {});
  console.log('seeded tenant urbanstep');
} else console.log('tenant exists');
await seedKnowledge(t._id);
console.log(`Demo logins (DEMO DATA ONLY): tenant_admin@urbanstep.test / cx_lead@urbanstep.test / finance@urbanstep.test ... password: ${DEMO_PASSWORD}`);
void randomUUID;
await closeMongo();
