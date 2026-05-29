import type {
  DashboardSnapshot,
  SourceDataMap,
  SourceName,
} from 'gas-city-dashboard-shared';
import { fixtureSnapshot } from './snapshot.js';

// Fixture loader for SNAPSHOT_USE_FIXTURES=1 runtime mode
// (gascity-dashboard-hzy). Bead-3's cache wiring binds these into each
// SourceCache as loadFixture so a live-source failure falls back to the
// committed sample data instead of leaving a panel empty.
//
// Demo-dash exposes markSnapshotAsFixture / markSourceAsFixture helpers
// for wrapping arbitrary input snapshots. We don't port them: the
// committed fixtureSnapshot already has fixture data for every served source;
// SourceCache stamps its own envelope on the way out anyway.

export async function loadFixtureSnapshot(): Promise<DashboardSnapshot> {
  return fixtureSnapshot;
}

/**
 * Returns a loader function suitable for SourceCacheOptions.loadFixture.
 * All current served sources have populated fixture data. If a future source
 * is added, the typed fixture snapshot must carry that source's data before it
 * can be bound here.
 */
export function fixtureSourceLoader<K extends SourceName>(
  source: K,
): () => Promise<SourceDataMap[K]> {
  return async () => {
    const state = fixtureSnapshot.sources[source];
    // Soundness of the `data` access: fixtureSnapshot is declared with
    // `satisfies DashboardSnapshot`, and every fixture source is
    // constructed with `status: 'fixture'` (see snapshot.ts) — never
    // 'error'. tsc narrows the union to SourceAvailableState<T> for every
    // K via the satisfies-derived literal type, so `state.data` is
    // statically present. A future fixture that introduces a status:'error'
    // entry would break this access at compile time before it could ship
    // — the typed-const gate is the runtime guard equivalent.
    //
    // The `as SourceDataMap[K]` cast is still required because tsc cannot
    // narrow a *generic* index access (sources[source].data) back to
    // SourceDataMap[K], even though the concrete-key access above is
    // narrowed. Soundness rests on the same satisfies annotation.
    return state.data as SourceDataMap[K];
  };
}
