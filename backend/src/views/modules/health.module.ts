// Health is a core module: always mounted, never opt-out-able. It owns
// no per-city filesystem, no SSE registry, no background worker — just a
// stateless probe of admin process + host + supervisor health. That's why
// `resources` is empty and `needs()` returns undefined.

import { healthRouter } from '../../routes/health.js';
import type { BackendModule } from '../types.js';

export const healthBackend: BackendModule<void> = {
  id: 'health',
  kind: 'core',
  resources: {},
  needs: () => undefined,
  mount: (ctx) => healthRouter(ctx.gc),
};
