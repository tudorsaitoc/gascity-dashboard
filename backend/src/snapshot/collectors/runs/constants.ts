export const RUNS_CACHE_TTL_MS = 60 * 1000;
export const RUNS_FETCH_LIMIT = 1_000;
export const RECENT_RUN_FETCH_LIMIT = 80;

/**
 * gascity-dashboard-yh5i: active lanes are capped so they can't crowd the
 * ambient window. Historical lanes ship uncapped (gascity-dashboard-l9q9) —
 * the frontend owns the historical preview/expand count — so there is no
 * MAX_VISIBLE_HISTORICAL_LANES here anymore.
 */
export const MAX_VISIBLE_ACTIVE_LANES = 8;

export const RECENT_CHANGES_CAP = 12;
