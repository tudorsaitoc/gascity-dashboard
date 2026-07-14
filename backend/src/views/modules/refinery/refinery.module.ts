// Refinery backend module — saitoc first-party, opt-in via MODULES_ENABLED.
//
// The fleet-throughput lens: publish-pool queue state, closeout-gate
// pass/warn rates, pool-entry→merge lead time, stuck work. Both data
// sources are host-local (a readonly bd read of the rig store, a filtered
// scan of the nerve river's daily logs); no new listener, no supervisor
// coupling — the supervisor being down does not take this view with it.
//
// Resources posture:
//   - memory 'summary-cache' (perCity) — the RefinerySummaryState instance
//     (river file scans + assembled summary, TTL 30s), constructed inside
//     needs()/mount() wiring, never module-scope.

import type { BackendModule } from '../../types.js';
import type { RefineryModuleConfig } from '../../../config.js';
import { refineryRouter } from './router.js';
import { RefinerySummaryState } from './state.js';

export interface RefineryDeps {
  config: RefineryModuleConfig;
}

export const refineryBackend: BackendModule<RefineryDeps> = {
  id: 'refinery',
  kind: 'firstParty',
  resources: {
    memory: [{ name: 'summary-cache', scope: 'perCity' }],
  },
  needs: (config) => ({ config: config.modules.refinery }),
  mount: (_ctx, deps) => {
    const state = new RefinerySummaryState(deps.config);
    // Boot-time warm: the first river backfill streams the whole window
    // once; doing it here keeps the first page load off that cost. Fire
    // and forget — warm() logs and swallows its own failures.
    void state.warm();
    return refineryRouter(state);
  },
};
