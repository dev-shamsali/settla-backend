import { EventEmitter } from 'node:events';

/** In-process pub/sub that feeds SSE. For multi-instance, swap to Redis pub/sub (same interface). */
class Bus extends EventEmitter {
  publish(tenantId, event) {
    this.emit(`t:${tenantId}`, { ts: new Date().toISOString(), ...event });
  }
  subscribe(tenantId, fn) {
    const k = `t:${tenantId}`;
    this.on(k, fn);
    return () => this.off(k, fn);
  }
}
export const bus = new Bus();
bus.setMaxListeners(500);
