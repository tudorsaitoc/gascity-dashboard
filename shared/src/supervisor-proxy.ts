// Dashboard-owned transport contract for the `/gc-supervisor/*` proxy
// (backend/src/routes/supervisor-transport-proxy.ts). The proxy short-TTL-caches
// the two expensive city-wide reads (molecule(all=true) history + city formula
// feed); the operator's explicit /runs Refresh must be able to force a fresh
// upstream scan within that TTL window (gascity-dashboard-i3dz).
//
// The frontend sets this request header ONLY on a manual wide Refresh; the proxy
// honors it as a cache bypass (force-refresh + repopulate) and strips it before
// forwarding upstream, so preview/SSE traffic keeps the TTL amortization. The
// name/value live here so the frontend client and the backend proxy share one
// definition and cannot drift.
export const SUPERVISOR_CACHE_BYPASS_HEADER = 'x-gc-cache-bypass';
export const SUPERVISOR_CACHE_BYPASS_VALUE = '1';
