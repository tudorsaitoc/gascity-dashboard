import type {
  LocalToolVersion,
  RecommendedToolVersion,
  ToolVersionDrift,
} from 'gas-city-dashboard-shared';

// Recommended minimum ("floor") versions for the host tools the dashboard
// depends on. The authoritative pins live in gc itself (`gc doctor` gates
// dolt / bd compatibility), but gc exposes no machine-readable floor, so the
// dashboard maintains this table. Bump it when gc raises its floor.
//
// gc carries no numeric floor: it ships as `dev` builds, so its drift is
// reported `unknown` rather than compared against a fabricated version.
export const RECOMMENDED_TOOL_FLOORS: {
  readonly dolt: string;
  readonly beads: string;
  readonly gc: string | null;
} = {
  dolt: '2.1.2',
  beads: '1.0.4',
  gc: null,
};

/** Parse an `X.Y.Z` version into a numeric tuple, or null if it is not that
 *  exact shape. Probe output is already reduced to `X.Y.Z` by parseVersion,
 *  and floors are authored as `X.Y.Z`, so this is the full comparable set. */
export function parseVersionTuple(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Compare two `X.Y.Z` versions: -1 if a < b, 0 if equal, 1 if a > b. Returns
 *  null when either side is not a comparable `X.Y.Z`. */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersionTuple(a);
  const right = parseVersionTuple(b);
  if (left === null || right === null) return null;
  // Destructuring a fixed 3-tuple yields plain numbers (no undefined under
  // noUncheckedIndexedAccess), so the comparison stays cast- and fallback-free.
  const [lMajor, lMinor, lPatch] = left;
  const [rMajor, rMinor, rPatch] = right;
  if (lMajor !== rMajor) return lMajor < rMajor ? -1 : 1;
  if (lMinor !== rMinor) return lMinor < rMinor ? -1 : 1;
  if (lPatch !== rPatch) return lPatch < rPatch ? -1 : 1;
  return 0;
}

export function driftAgainstFloor(
  installed: LocalToolVersion,
  floor: string | null,
): ToolVersionDrift {
  if (floor === null) return 'unknown';
  if (installed.status !== 'available') return 'unknown';
  const cmp = compareVersions(installed.version, floor);
  if (cmp === null) return 'unknown';
  return cmp >= 0 ? 'satisfied' : 'below_floor';
}

export function recommendedToolVersion(
  installed: LocalToolVersion,
  floor: string | null,
): RecommendedToolVersion {
  return {
    installed,
    recommendedFloor: floor,
    drift: driftAgainstFloor(installed, floor),
  };
}
