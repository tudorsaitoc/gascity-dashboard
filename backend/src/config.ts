// Single place for env-driven knobs. Anything new goes here so SECURITY.md
// can audit the configurable surface.

import { AGENT_ALIAS_RE } from './exec.js';
import { isValidCityName } from './lib/cityName.js';
import { LOG_COMPONENT, logWarn } from './logging.js';

/**
 * Per-module configuration slices, scoped under AdminConfig.modules.<id>.
 * The wire-shape `DashboardRuntimeConfig` deliberately omits these — module
 * config is host-side only; modules read it via their `needs(config)`
 * descriptor at bind time. See docs/PRD-modular-dashboard.md §7 audit-C8.
 */
export interface MaintainerModuleConfig {
  /** owner/name repository the maintainer view fetches issues + PRs from. */
  githubRepo: string;
  /** Default agent alias for `gc sling` dispatch from the maintainer view. */
  slingTarget: string;
  /** Default agent alias for `gc sling` dispatch when intent='triage'. */
  triageTarget: string;
  /** Worker cadence in ms. 0 disables the worker (manual refresh only). */
  refreshIntervalMs: number;
  /**
   * Optional explicit cache file path. When set, the maintainer module
   * skips the legacy-path migration entirely — operator-pinned location
   * wins over both old and new defaults.
   */
  cachePath?: string;
}

export interface ModulesConfig {
  maintainer: MaintainerModuleConfig;
}

export interface AdminConfig {
  /** Listener port. Default 8081, side-by-side with gc dashboard at 8080. */
  port: number;
  /** Bind host. Default 127.0.0.1; override via HOST env for headless-VM workflows (e.g. HOST=0.0.0.0). */
  bindHost: string;
  /**
   * Extra hostnames allowed in the Host: header allow-list, on top of the
   * always-present floor ['127.0.0.1','localhost']. CSV via ADMIN_EXTRA_ALLOWED_HOSTS.
   * Used when bindHost=0.0.0.0 and clients reach the dashboard by LAN name/IP.
   */
  extraAllowedHosts: ReadonlyArray<string>;
  /** gc supervisor base URL (no trailing slash). */
  gcSupervisorUrl: string;
  /** Name of the city this admin dashboard manages. */
  cityName: string;
  /**
   * Optional absolute path to the city directory, passed as `gc prime --city=<path>`.
   * When unset, `gc` walks up from cwd to discover the city. Set via GC_CITY_PATH
   * for headless / systemd contexts where cwd is unrelated to the city tree.
   */
  cityPath: string;
  /** Path to .gc/events.jsonl for audit-log append. */
  auditLogPath: string;
  /** Path to the dist/ of the frontend build, served by express.static. */
  frontendDistPath: string;
  /** Kill-switch: set to '1' to refuse to start. */
  disabled: boolean;
  /**
   * Per-module configuration slices. Modules read their own slice in
   * `needs(config)`. See `MaintainerModuleConfig` for the maintainer
   * envelope — env-driven via MAINTAINER_GITHUB_REPO, MAINTAINER_CACHE_PATH,
   * MAINTAINER_REFRESH_INTERVAL_MS, MAINTAINER_SLING_TARGET,
   * MAINTAINER_TRIAGE_TARGET. `MAINTAINER_REPO` is a deprecated alias for
   * MAINTAINER_GITHUB_REPO (warn-once at boot).
   */
  modules: ModulesConfig;
  /**
   * Per-process kill-switch for snapshot fixture mode. When true, bead-3's
   * cache wiring should pass useFixture=true into each SourceCache so the
   * dashboard stays renderable when supervisor / upstream services fail.
   * Env: SNAPSHOT_USE_FIXTURES (set to '1' to enable). Default: false.
   * SourceCache's per-cache useFixture flag is still required — this config
   * gate is the global opt-in, not a substitute.
   */
  useFixtures: boolean;
  /**
   * Operator-enabled `firstParty` module ids (PRD §2, bead 9yj.5).
   * `null` = unset, i.e. ALL firstParty modules mount (backwards-compat
   * with pre-PR-C behaviour). An EMPTY set = no firstParty modules mount.
   * Non-empty = exactly those `firstParty` ids mount. `core` modules
   * ignore this filter entirely.
   *
   * The wire-shape `DashboardRuntimeConfig.enabledModules` mirrors this
   * field as `string[] | null` so the frontend can apply the same filter
   * to `ALL_VIEWS` (otherwise a backend-disabled module's path 404s in
   * React Router).
   *
   * Env: `MODULES_ENABLED` (CSV — `MODULES_ENABLED=health,maintainer`).
   * Whitespace tolerated around each entry; empty entries dropped. Casing
   * preserved (ids are lowercase by convention but the filter is a literal
   * set membership, so a typo surfaces as "module never mounted" at boot).
   */
  enabledModules: ReadonlySet<string> | null;
  /**
   * Operator override for the `/` route (PRD §6, bead 9yj.5).
   * `null` = unset, i.e. the frontend resolves `/` via descriptor flags
   * (`defaultRoute: true`) then falls back to the kb3 ambient home.
   * Set via `DEFAULT_VIEW=<module-id>`. Value passes through verbatim to
   * the wire shape and the frontend resolver; if the id is unknown or
   * disabled the frontend warns and falls through (premortem #5).
   */
  defaultView: string | null;
}

/**
 * Parse `MODULES_ENABLED` CSV per the AdminConfig.enabledModules contract.
 * Returns `null` when the env is UNSET (preserves pre-PR-C behaviour);
 * returns an empty set when the env is the empty string (operator explicitly
 * disables all firstParty modules); returns a populated set otherwise.
 *
 * Whitespace around each entry is trimmed; empty entries (from leading /
 * trailing / doubled commas) are dropped. Casing is preserved — module ids
 * are lowercase by convention but the filter is a literal set membership,
 * so a typo surfaces as "module never mounted" at boot rather than silently
 * matching.
 */
export function parseModulesEnabled(raw: string | undefined): ReadonlySet<string> | null {
  if (raw === undefined) return null;
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return new Set(ids);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const portRaw = env.PORT ?? '8081';
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid PORT: ${portRaw}`);
  }
  const extraAllowedHosts = (env.ADMIN_EXTRA_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  // Validate cityName: it lands in CityContext.cityDataDir as a path segment
  // (~/.gascity-dashboard/cities/<cityName>/) that modules write to. A
  // value containing `/`, `..`, or any path separator would let a
  // misconfigured GC_CITY_NAME escape the cities/ root via path.join's
  // normalization. Per the modular-dashboard PRD § premortem #5 +
  // security review.
  const cityName = env.GC_CITY_NAME ?? 'racoon-city';
  if (!isValidCityName(cityName)) {
    throw new Error(
      `Invalid GC_CITY_NAME: "${cityName}" — must be alphanumeric with hyphens, no path separators or leading/trailing hyphen`,
    );
  }
  return {
    port,
    bindHost: env.HOST ?? '127.0.0.1',
    extraAllowedHosts,
    gcSupervisorUrl: (env.GC_SUPERVISOR_URL ?? 'http://127.0.0.1:8372').replace(/\/+$/, ''),
    cityName,
    cityPath: env.GC_CITY_PATH ?? '',
    auditLogPath: env.ADMIN_AUDIT_LOG_PATH ?? defaultAuditLogPath(env),
    frontendDistPath: env.ADMIN_FRONTEND_DIST ?? '../frontend/dist',
    disabled: env.ADMIN_DASHBOARD_DISABLED === '1',
    modules: {
      maintainer: loadMaintainerModuleConfig(env),
    },
    useFixtures: env.SNAPSHOT_USE_FIXTURES === '1',
    enabledModules: parseModulesEnabled(env.MODULES_ENABLED),
    // DEFAULT_VIEW: pass through verbatim. Validation (unknown id, disabled
    // module) lives on the frontend's resolver so the warn is emitted in the
    // same console where the operator sees the dashboard load. The backend
    // mirrors the value into the wire-shape; null when unset or empty.
    defaultView:
      env.DEFAULT_VIEW !== undefined && env.DEFAULT_VIEW.length > 0
        ? env.DEFAULT_VIEW
        : null,
  };
}

// Module-scope guards so MAINTAINER_REPO deprecation warnings fire at most
// once per process — protects against config-reload, test-harness re-entry,
// or any future caller that re-invokes loadConfig. The JSDoc on
// loadMaintainerModuleConfig promises "warn-once at boot"; without these the
// inline logWarn() emitted on every call (Phase-4 correctness MEDIUM).
let warnedLegacyAliasIgnored = false;
let warnedLegacyAliasUsed = false;

// Test-only reset hook — config.test.ts re-invokes loadConfig under multiple
// env permutations and needs each permutation to trigger the deprecation
// warn that its precedence rule expects. Production code never calls this.
export function __resetMaintainerAliasWarnState(): void {
  warnedLegacyAliasIgnored = false;
  warnedLegacyAliasUsed = false;
}

/**
 * Resolve the maintainer module's config slice from env. Implements the
 * MAINTAINER_REPO → MAINTAINER_GITHUB_REPO migration per audit-C8: the
 * new name wins; the legacy name still works but emits a single warn at
 * boot so operators know to rename. When BOTH are set, MAINTAINER_GITHUB_REPO
 * takes precedence and the legacy value is logged as ignored.
 */
function loadMaintainerModuleConfig(env: NodeJS.ProcessEnv): MaintainerModuleConfig {
  const newRepo = env.MAINTAINER_GITHUB_REPO;
  const legacyRepo = env.MAINTAINER_REPO;
  let githubRepo: string;
  if (newRepo !== undefined && newRepo.length > 0) {
    githubRepo = newRepo;
    if (legacyRepo !== undefined && legacyRepo.length > 0 && !warnedLegacyAliasIgnored) {
      warnedLegacyAliasIgnored = true;
      logWarn(
        LOG_COMPONENT.admin,
        'MAINTAINER_REPO is deprecated and being ignored; MAINTAINER_GITHUB_REPO takes precedence',
      );
    }
  } else if (legacyRepo !== undefined && legacyRepo.length > 0) {
    githubRepo = legacyRepo;
    if (!warnedLegacyAliasUsed) {
      warnedLegacyAliasUsed = true;
      logWarn(
        LOG_COMPONENT.admin,
        'MAINTAINER_REPO is deprecated; rename to MAINTAINER_GITHUB_REPO',
      );
    }
  } else {
    githubRepo = 'gastownhall/gascity';
  }
  const slice: MaintainerModuleConfig = {
    githubRepo,
    slingTarget: parseSlingTarget(
      'MAINTAINER_SLING_TARGET',
      env.MAINTAINER_SLING_TARGET,
      'mayor',
    ),
    triageTarget: parseSlingTarget(
      'MAINTAINER_TRIAGE_TARGET',
      env.MAINTAINER_TRIAGE_TARGET,
      'mayor',
    ),
    refreshIntervalMs: parseIntervalMs(
      env.MAINTAINER_REFRESH_INTERVAL_MS,
      6 * 60 * 60 * 1_000,
    ),
  };
  if (env.MAINTAINER_CACHE_PATH !== undefined && env.MAINTAINER_CACHE_PATH.length > 0) {
    slice.cachePath = env.MAINTAINER_CACHE_PATH;
  }
  return slice;
}

function parseSlingTarget(envName: string, raw: string | undefined, fallback: string): string {
  if (raw === undefined || raw.length === 0) return fallback;
  if (!AGENT_ALIAS_RE.test(raw)) {
    logWarn(
      LOG_COMPONENT.admin,
      `${envName}=${JSON.stringify(raw)} is not a valid agent alias; falling back to '${fallback}'`,
    );
    return fallback;
  }
  return raw;
}

function defaultAuditLogPath(env: NodeJS.ProcessEnv): string {
  return env.HOME ? `${env.HOME}/.gc/events.jsonl` : '.gc/events.jsonl';
}

function parseIntervalMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.length === 0) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}
