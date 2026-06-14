// Work-in-flight assignee parsing — the primitives the "Workers active" section
// uses to tie an in-progress bead to the live worker session that owns it.
//
// Each in-progress bead carries an `assignee` that embeds the live session id:
//
//   bead gc-5rarj           assignee polecat-gc-335825                       → gc-335825
//   bead scix_experiments-… assignee scix-worker-gc-335812                   → gc-335812
//   bead gascity-dashboard-… assignee gc__implementation-worker-mc-wisp-08fqjv → mc-wisp-08fqjv
//
// Pattern: `<worker-role>-<session-id>` where the session id is the trailing
// supervisor handle. The frontend derives the live Workers-active list from the
// SESSIONS (see hooks/activeWorkers), using parseAssignee only to best-effort
// attach a captured bead to a worker row.
//
// The trailing-handle extraction lives in the shared session-handle primitive
// so this surface, the run-detail Session link, and the worker display-name
// cleaner stay on one id alphabet — it keeps the 2-letter `mc-` store prefix and
// the `wisp-`/`mol-` tier the old local regex dropped (audit finding M8), while
// still rejecting digit-less role words like `scix-worker` as bare handles.
//
// Pure over plain strings — no IO, no React, no DOM.

import { matchSessionHandle } from './session-handle.js';

export interface ParsedAssignee {
  /** The extracted live session id (e.g. `gc-335825`), or undefined when the
   *  assignee carries no recognizable session handle. */
  sessionId?: string;
  /** The worker-role prefix with the session-id suffix stripped
   *  (e.g. `polecat`, `scix-worker`, `enterprisebench-worker`). Falls back to
   *  the whole assignee when no session suffix is present. */
  role: string;
}

/**
 * Split a bead assignee into its worker role and embedded session id.
 *
 * `polecat-gc-335825` → `{ role: 'polecat', sessionId: 'gc-335825' }`.
 * An assignee with no session handle (e.g. a bare alias) yields the whole
 * string as the role and no sessionId — the caller degrades gracefully.
 */
export function parseAssignee(assignee: string): ParsedAssignee {
  const trimmed = assignee.trim();
  const match = matchSessionHandle(trimmed);
  if (!match) return { role: trimmed };
  // Bare handle: the assignee IS a session id with no role prefix. Name the row
  // with the id itself so it still reads.
  if (!match.prefixed) return { role: trimmed, sessionId: match.sessionId };
  // Strip the matched `<sep><session-id>` tail to recover the role.
  return { role: trimmed.slice(0, match.roleEnd), sessionId: match.sessionId };
}
