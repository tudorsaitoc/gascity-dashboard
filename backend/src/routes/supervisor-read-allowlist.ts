// Default-deny read-endpoint allowlist for the `/gc-supervisor` transport proxy
// when DASHBOARD_READONLY=1 (exposure-hardening PRD M1 / bead z8n7).
//
// Only GET/HEAD requests whose path matches one of these templates are
// forwarded to the supervisor; every other path is rejected with 404. The list
// is deliberately the *minimal* set of supervisor reads the dashboard SPA
// performs — see the `getV0*` / SSE calls in `frontend/src/supervisor/*`. A new
// read view must be added here to work under read-only mode; until then it
// fails closed, which is the intended posture for an externally exposed
// instance.
//
// Side-effecting GETs are excluded on purpose. `agent/{base}/prime` (and its
// `{dir}/{base}` variant) is a state-changing GET flagged by the exposure
// premortem, so neither it nor the dynamic two-segment agent-detail reads are
// allowlisted — keeping the agent surface to the inert `agents` listing also
// avoids a `[^/]+`-collision where `agent/{base}/prime` would otherwise match a
// generic `agent/{dir}/{base}` pattern.
const READ_ENDPOINT_TEMPLATES = [
  '/health',
  '/v0/cities',
  '/v0/city/{cityName}/agents',
  '/v0/city/{cityName}/beads',
  '/v0/city/{cityName}/bead/{id}',
  '/v0/city/{cityName}/events',
  '/v0/city/{cityName}/events/stream',
  '/v0/city/{cityName}/formulas/feed',
  '/v0/city/{cityName}/formulas/{name}',
  '/v0/city/{cityName}/health',
  '/v0/city/{cityName}/mail',
  '/v0/city/{cityName}/mail/thread/{id}',
  '/v0/city/{cityName}/sessions',
  '/v0/city/{cityName}/session/{id}/pending',
  '/v0/city/{cityName}/session/{id}/stream',
  '/v0/city/{cityName}/session/{id}/transcript',
  '/v0/city/{cityName}/status',
  '/v0/city/{cityName}/workflow/{workflow_id}',
] as const;

const READ_ENDPOINT_PATTERNS: readonly RegExp[] = READ_ENDPOINT_TEMPLATES.map(templateToPattern);

/** True when `path` (proxy-relative, query stripped) is an allowlisted read. */
export function isAllowedReadPath(path: string): boolean {
  if (hasTraversal(path)) return false;
  return READ_ENDPOINT_PATTERNS.some((pattern) => pattern.test(path));
}

// Express leaves `req.path` un-normalized, but the upstream URL is built with
// `new URL(req.url, base)`, which resolves `..` segments (and treats `\` as `/`
// for http URLs). Without this guard a path like `/v0/city/../events/stream`
// would satisfy the per-city `{cityName}` template (`[^/]+` matches `..`) yet
// forward to the GLOBAL `/v0/events/stream` cross-city stream — defeating
// read-only mode in a multi-city deployment. No legitimate supervisor read path
// contains a `..` segment or a backslash, so both fail closed and the checked
// path always equals the forwarded path.
function hasTraversal(path: string): boolean {
  if (path.includes('\\')) return true;
  return path.split('/').includes('..');
}

// `{param}` segments match a single path segment; literal segments match
// exactly. Anchored at both ends so a longer path (e.g. an action suffix) never
// satisfies a shorter template.
function templateToPattern(template: string): RegExp {
  const body = template
    .split('/')
    .map((segment) =>
      segment.startsWith('{') && segment.endsWith('}')
        ? '[^/]+'
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${body}$`);
}
