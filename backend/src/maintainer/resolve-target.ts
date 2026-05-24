import type { GcSession } from 'gas-city-dashboard-shared';

// Resolves a configured `gc sling` target role (e.g. 'chief-of-staff',
// 'mayor') to the supervisor session that carries that role
// (gascity-dashboard-55b).
//
// Background. MAINTAINER_SLING_TARGET / MAINTAINER_TRIAGE_TARGET are
// role / pool labels — what the operator's deployment names the
// triage worker. `gc sling` itself resolves this label to an active
// session inside the supervisor; the dashboard never sees the
// resolved id from gc. Without this module the dashboard previously
// pasted the role label into `/agents/<label>`, which 404s because
// AgentDetail matches strictly against session.session_name / alias / id.
//
// The supervisor's `/v0/city/.../sessions` response shape (verified
// against the live API for `oversight-rig.chief-of-staff`) carries
// the role label in any of these positions:
//
//   alias=oversight-rig.chief-of-staff
//   pool=chief-of-staff
//   session_name=oversight-rig__chief-of-staff
//   template=oversight-rig.chief-of-staff
//
// We check `alias` first (most specific, gc sling already accepts it),
// then `pool` (the upstream role pool name), then last-segment heuristics
// against `alias` / `session_name` (covers rig-qualified names by
// splitting on '/', '.', '__', or '-').
//
// `active` sessions outrank non-active when multiple sessions match —
// the operator wants the link to land on a running agent, not an
// asleep / failed one. Within the same activity tier, first match wins
// (deterministic given the supervisor's iteration order; gc supervisor
// returns sessions sorted by recency, so first match = most recent).

/**
 * Resolves a role label to a concrete session's `session_name`
 * (preferred), falling back to `alias`, then `id`. Returns null when
 * no session in the list matches the role.
 *
 * The returned value is what the frontend uses as the AgentDetail
 * route slug (`/agents/<value>`). AgentDetail's `useMemo` resolution
 * already accepts session_name | alias | id, so any of the three
 * returned shapes resolves correctly when handed back to the route.
 *
 * Pure function: no side effects, no IO. Callers that need to fetch
 * sessions own the listSessions() call.
 */
export function resolveTargetToSession(
  target: string,
  sessions: readonly GcSession[],
): string | null {
  if (target.length === 0 || sessions.length === 0) return null;

  // Two passes: first prefer 'active' sessions, then any state. This
  // keeps the operator's link aimed at a live agent when one exists.
  const active = sessions.filter((s) => s.state === 'active');
  return matchFirst(target, active) ?? matchFirst(target, sessions);
}

function matchFirst(target: string, sessions: readonly GcSession[]): string | null {
  for (const s of sessions) {
    if (matchesTarget(s, target)) {
      return s.session_name ?? s.alias ?? s.id;
    }
  }
  return null;
}

function matchesTarget(session: GcSession, target: string): boolean {
  // 1. Exact alias match (most specific; covers operator passing the
  //    fully-qualified alias as the role label, e.g. 'oversight-rig.chief-of-staff').
  if (session.alias === target) return true;
  // 2. Pool match — gc supervisor's role-pool name; the cleanest
  //    pivot when the operator's MAINTAINER_SLING_TARGET is set to the
  //    pool name itself ('chief-of-staff', 'mayor', etc.).
  if (session.pool === target) return true;
  // 3. Last-segment match on alias (rig-qualified). Splits on both
  //    '/' (rig separator) and '.' (oversight-rig.chief-of-staff →
  //    chief-of-staff). The deepest segment is the role label.
  if (session.alias !== undefined && lastSegment(session.alias, ['/', '.']) === target) {
    return true;
  }
  // 4. Last-segment match on session_name. Supervisor's session_name
  //    encodes rig + role via '__' / '--' / '-' (e.g.
  //    'oversight-rig__chief-of-staff', 'codescalebench--control-dispatcher').
  //    Try the deepest separator first to avoid eating role names that
  //    legitimately contain '-' ('chief-of-staff' splits to 'staff'
  //    under naive '-' splitting; '__' / '--' get there first).
  if (session.session_name !== undefined) {
    const last = lastSegment(session.session_name, ['__', '--']);
    if (last === target) return true;
  }
  return false;
}

/**
 * Returns the substring AFTER the last occurrence of any separator in
 * `seps`. Multi-char separators are matched as whole tokens. Returns
 * the original string when none of the separators are present.
 *
 * Example: lastSegment('oversight-rig.chief-of-staff', ['/', '.']) →
 *   'chief-of-staff' (split on the rightmost '.').
 */
function lastSegment(value: string, seps: readonly string[]): string {
  let cut = -1;
  let sepLen = 0;
  for (const sep of seps) {
    const idx = value.lastIndexOf(sep);
    if (idx > cut) {
      cut = idx;
      sepLen = sep.length;
    }
  }
  if (cut < 0) return value;
  return value.slice(cut + sepLen);
}
