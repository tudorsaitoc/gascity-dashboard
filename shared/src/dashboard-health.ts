import type { IsoTimestamp } from './dashboard-sessions.js';

export interface SystemHealth {
  /** Backend process state — totally local to the admin dashboard's node process. */
  admin: {
    pid: number;
    uptime_sec: number;
    rss_bytes: number;
    heap_used_bytes: number;
    node_version: string;
  };
  /** Machine-level state from Node's os module. */
  host: {
    load_avg_1: number;
    load_avg_5: number;
    load_avg_15: number;
    total_mem_bytes: number;
    free_mem_bytes: number;
    /** Number of logical CPUs. */
    cpu_count: number;
    uptime_sec: number;
  };
}

export type LocalToolVersion =
  | { status: 'available'; version: string; source: string }
  | { status: 'unavailable'; reason: string };

/** How an installed tool compares to its recommended floor:
 *  - `satisfied`   — installed is a comparable semver at or above the floor.
 *  - `below_floor` — installed is a comparable semver below the floor (drift).
 *  - `unknown`     — no floor is published, the probe failed, or the installed
 *                    version is not a comparable `X.Y.Z` (e.g. gc `dev` builds). */
export type ToolVersionDrift = 'satisfied' | 'below_floor' | 'unknown';

export interface RecommendedToolVersion {
  /** Locally probed installed version. */
  installed: LocalToolVersion;
  /** Recommended minimum ("floor") version, or null when the tool has no
   *  published pin (gc ships as `dev` builds, so it carries no numeric floor). */
  recommendedFloor: string | null;
  /** Drift of `installed` against `recommendedFloor`. */
  drift: ToolVersionDrift;
}

export interface LocalToolVersions {
  dolt: RecommendedToolVersion;
  beads: RecommendedToolVersion;
  gc: RecommendedToolVersion;
}

export interface DoltNomsSample {
  ts: IsoTimestamp;
  bytes: number;
}

export type DoltNomsUnavailableReason = 'store_health_absent' | 'sample_failed';

export type DoltNomsTrend =
  | {
      available: true;
      /** Up to 144 samples (24 h at 10-min cadence). */
      samples: DoltNomsSample[];
      source: string;
    }
  | {
      available: false;
      /** Historical samples, if the source became unavailable after sampling. */
      samples: DoltNomsSample[];
      reason: DoltNomsUnavailableReason;
    };
