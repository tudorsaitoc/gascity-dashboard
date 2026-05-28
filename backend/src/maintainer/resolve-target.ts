import type { GcSession } from 'gas-city-dashboard-shared';
import { resolveSessionForTarget } from 'gas-city-dashboard-shared';

// Resolves a configured `gc sling` target role (e.g. 'chief-of-staff',
// 'mayor') to the supervisor session that carries that role
// (gascity-dashboard-55b).
//
// Background. MAINTAINER_SLING_TARGET / MAINTAINER_TRIAGE_TARGET are
// role / pool labels — what the operator's deployment names the
// triage worker. `gc sling` itself resolves this label to an active
// session inside the supervisor; the dashboard never sees the
// resolved id from gc. The dashboard resolves the label before linking to
// `/agents/<value>` because AgentDetail matches strictly against
// session.session_name / alias / id.
//
// The 4-step matcher (alias / pool / last-segment of alias / last-segment
// of session_name, active-first) now lives in the shared package
// (gas-city-dashboard-shared resolveSessionForTarget, gascity-dashboard-3ax)
// so the workflow-health engine's bead×session join and this sling
// resolver share ONE implementation of the lossy resolution PRD risk R2
// flags. This wrapper keeps the slug-returning contract its callers expect.

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
  const session = resolveSessionForTarget(target, sessions);
  if (session === null) return null;
  return session.session_name ?? session.alias ?? session.id;
}
