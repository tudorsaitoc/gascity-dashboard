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
 * Every served source must have typed fixture data before it can be bound here.
 */
export function fixtureSourceLoader<K extends SourceName>(
  source: K,
): () => Promise<SourceDataMap[K]> {
  return async () => {
    const state = fixtureSnapshot.sources[source];
    // Cast is unavoidable: tsc cannot narrow a generic index access
    // (sources[source].data) back to SourceDataMap[K]. Soundness rests on the
    // fixtureSnapshot annotation — if its shape drifts, the typed-const compile
    // gate catches it first.
    return state.data as SourceDataMap[K];
  };
}
