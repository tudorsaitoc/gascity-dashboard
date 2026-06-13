// Session-id validator for routes that read or stream a gc session.
//
// `shared` is the single source of truth for the dashboard's session-id
// alphabet — peek, stream, run-detail linking, and the supervisor session
// routes all gate on the same shape — so re-export it here instead of keeping a
// second copy that can silently drift on the next format change. See
// gas-city-dashboard-shared `session-id.ts` for the contract and the
// lowercase-only / 2-4-letter-prefix rationale.

export { SESSION_ID_RE } from 'gas-city-dashboard-shared';
