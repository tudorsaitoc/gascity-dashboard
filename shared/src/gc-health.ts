import type { IsoTimestamp } from './gc-client-types.js';
import type { Avail } from './lists.js';

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
  /** gc supervisor's own city health probe. Direct-supervisor clients may fetch this separately. */
  supervisor?: SupervisorHealthState;
  /**
   * Diagnostic detail for troubleshooting: Dolt/Beads versions and usage,
   * plus recommended-vs-loaded config comparison. Each datum carries its own
   * availability so a missing source (supervisor omitted a field, or a local
   * version probe failed) surfaces explicitly rather than as a fake value.
   */
  diagnostics?: HealthDiagnostics;
}

/**
 * A single diagnostic value paired with its provenance. `status:'available'`
 * carries the value; `status:'unavailable'` carries a human-readable reason so
 * the UI can show *why* it is missing rather than coalescing to a blank.
 */
export type DiagnosticValue<T> =
  | { status: 'available'; value: T; source: string }
  | { status: 'unavailable'; reason: string };

/**
 * Dolt store usage, sourced from the supervisor's `status.store_health`
 * (`GET /v0/city/{name}/status`). All numeric fields except `size_bytes` are
 * optional on the wire — a degraded supervisor may omit them.
 */
export interface DoltUsage {
  size_bytes: number;
  live_rows?: number;
  ratio_mb_per_row?: number;
  /** Recommended ceiling for ratio_mb_per_row; a ratio above this trips a warning. */
  threshold_mb_per_row?: number;
  /** True when the supervisor considers Dolt maintenance overdue. */
  warning?: boolean;
  last_gc_at?: IsoTimestamp;
  last_gc_status?: string;
  path?: string;
}

/**
 * Beads (work-item) usage, sourced from the supervisor's `status.work`
 * (`GET /v0/city/{name}/status`).
 */
export interface BeadsUsage {
  open: number;
  ready: number;
  in_progress: number;
}

/**
 * Recommended-vs-loaded comparison for one configuration datum. `recommended`
 * is the supervisor-reported baseline (e.g. the Dolt maintenance ratio
 * threshold); `loaded` is the currently-active value. `withinRecommendation`
 * is the supervisor's own verdict, not a dashboard heuristic.
 */
export interface ConfigComparisonRow {
  label: string;
  recommended: string;
  loaded: string;
  withinRecommendation: boolean;
}

/**
 * Troubleshooting bundle for the Health page. Versions that the supervisor API
 * does not expose are probed locally on the backend host (see
 * gascity-dashboard-1cob.1); the comparison rows are sourced from whatever
 * recommended-vs-actual signal the supervisor reports (today: the Dolt
 * maintenance ratio threshold — see gascity-dashboard-1cob.2).
 */
export interface HealthDiagnostics {
  doltVersion: DiagnosticValue<string>;
  beadsVersion: DiagnosticValue<string>;
  doltUsage: DiagnosticValue<DoltUsage>;
  beadsUsage: DiagnosticValue<BeadsUsage>;
  /**
   * Recommended-vs-loaded config rows. `unavailable` when the supervisor
   * exposes no recommended baseline to compare against; when `available` it
   * always carries at least one row.
   */
  configComparison: DiagnosticValue<ConfigComparisonRow[]>;
}

export interface SupervisorHealth {
  status: string;
  /** Supervisor version. Optional per the supervisor's OpenAPI; present in
   *  practice today. Absence is itself a wire-drift signal — surface it
   *  rather than coalescing silently. */
  version?: string;
  /** City name. Optional per the supervisor's OpenAPI; present in practice
   *  today. Absence is itself a wire-drift signal — surface it rather than
   *  coalescing silently. */
  city?: string;
  uptime_sec: number;
}

export type SupervisorHealthState = Avail<{ data: SupervisorHealth }>;

/**
 * Dolt store on-disk health, as reported under `store_health` by the
 * supervisor's `GET /v0/city/{name}/status`. `size_bytes` is the
 * dolt-noms on-disk size the dashboard samples for its trend; the other
 * fields are surfaced for completeness (single source of truth) but are
 * not consumed dashboard-side yet. The whole block is optional because a
 * degraded supervisor may omit it.
 */
export interface StatusStoreHealth {
  size_bytes: number;
  live_rows?: number;
  ratio_mb_per_row?: number;
  threshold_mb_per_row?: number;
  warning?: boolean;
  last_gc_at?: IsoTimestamp;
  last_gc_status?: string;
  path?: string;
}

/** Work-item counts under `status.work`. */
export interface StatusWorkCounts {
  open: number;
  ready: number;
  in_progress: number;
}

/** `GET /v0/city/{name}/status` — only the fields the dashboard reads. */
export interface GcStatus {
  store_health?: StatusStoreHealth;
  work?: StatusWorkCounts;
  /** Server (gc) version. Optional per OpenAPI. */
  version?: string;
}

export interface DoltNomsSample {
  ts: IsoTimestamp;
  bytes: number;
}

export type DoltNomsUnavailableReason =
  | 'store_health_absent'
  | 'sample_failed';

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
