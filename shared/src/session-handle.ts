// Extracting the live supervisor session id embedded in a recorded handle.
//
// The supervisor builds pool worker session NAMES as
// `{sanitized template base}-{session bead id}` (gascity
// cmd/gc/pool_session_name.go PoolSessionName) — e.g.
// `gc__implementation-worker-mc-wisp-08fqjv` for the supervisor session id
// `mc-wisp-08fqjv`. The session bead id is a bd issue id: a short lowercase
// store prefix (2-4 letters, per-deployment — `mc`, `gc`, `fddc`, ...), an
// optional `wisp-`/`mol-` tier marker, and a numeric or base36-hash suffix
// (beads internal/utils/issue_id.go).
//
// This is the single source of truth for turning such a handle into the
// supervisor session id the routes expect. The run-detail Session link
// (runs/session-link.ts), the Workers-active assignee parser
// (work-in-flight.ts), and the worker display-name cleaner (frontend
// hooks/projectOf.ts) all route through it, so the surfaces can never drift
// onto different id alphabets the way they did before audit finding M8.
//
// Pure over plain strings — no IO, no React, no DOM.

import { SESSION_ID_RE } from './session-id.js';

// Anchor on the FULL trailing bead-id shape. The role/template part before the
// id is arbitrary and can itself contain 2-4 letter hyphenated words
// (`design-test-risk-reviewer`), so any looser "short token + tail" parse
// latches onto the role and mangles the id. The suffix group is hyphen-free so
// leftmost-match binds to the minimal real id. The `wisp-`/`mol-` tier marker
// is captured (group 2) because, when present, it proves the trailing token is
// a real bead id even when its base36 hash carries no digit.
const TRAILING_SESSION_BEAD_ID_RE = /(?:^|[-_/])([a-z]{2,4}-((?:wisp|mol)-)?([a-z0-9]{1,32}))$/;

export interface SessionHandleMatch {
  /** The full supervisor session id, e.g. `mc-wisp-08fqjv`. */
  readonly sessionId: string;
  /** Index in the source string where the role prefix ends — i.e. the start of
   *  the boundary separator before the id. Callers recover the role as
   *  `value.slice(0, roleEnd)`. 0 when the value IS a bare session id. */
  readonly roleEnd: number;
  /** True when a role/base prefix preceded the id (a boundary separator was
   *  consumed); false when the whole value is the bare session id. */
  readonly prefixed: boolean;
}

/**
 * Find the trailing supervisor session id embedded in a recorded handle.
 *
 * `gc__implementation-worker-mc-wisp-08fqjv` → `mc-wisp-08fqjv` (prefixed);
 * a bare `mc-wisp-08fqjv` → itself (not prefixed). Returns undefined when no
 * bead-id-shaped trailing token is present, so role words like `crew-lead`
 * degrade rather than masquerade as sessions.
 */
export function matchSessionHandle(value: string): SessionHandleMatch | undefined {
  const match = TRAILING_SESSION_BEAD_ID_RE.exec(value);
  if (!match) return undefined;
  const candidate = match[1];
  const tier = match[2];
  const suffix = match[3];
  if (candidate === undefined || suffix === undefined) return undefined;
  // A matched `wisp-`/`mol-` tier marker proves the trailing token is a real
  // bead id (the marker only appears in real ids), so accept any bounded base36
  // suffix — including the ~1-in-5 all-letter hashes bd generates. Only the
  // no-tier `{prefix}-{suffix}` form risks latching onto a role word
  // (`crew-lead`), so apply the stricter no-tier digit gate there (see
  // isBeadIdSuffix, which deliberately diverges from bd at 3-char suffixes).
  if (tier === undefined && !isBeadIdSuffix(suffix)) return undefined;
  if (!SESSION_ID_RE.test(candidate)) return undefined;
  const prefixed = match[0].length > candidate.length;
  return { sessionId: candidate, roleEnd: prefixed ? match.index : 0, prefixed };
}

/**
 * Normalize a recorded handle (metadata session id, session name, or assignee)
 * to the supervisor session id the session routes expect, or undefined when the
 * value carries no extractable id.
 *
 * Extraction runs first so a pool name whose sanitized template base is itself a
 * 2-4 letter bare token (`ml-mc-wisp-abc12`) yields the embedded `mc-wisp-abc12`
 * rather than the whole pool name. A clean session id whose all-letter hash the
 * no-tier gate rejects (`gc-abcde`) still passes through the SESSION_ID_RE
 * fallback.
 */
export function supervisorSessionIdFrom(value: string | undefined): string | undefined {
  const clean = value?.trim();
  if (!clean) return undefined;
  const extracted = matchSessionHandle(clean);
  if (extracted) return extracted.sessionId;
  return SESSION_ID_RE.test(clean) ? clean : undefined;
}

// A deliberately STRICTER variant of bd's suffix heuristic (beads
// internal/utils/issue_id.go isNumeric / isLikelyHash) — it does NOT mirror bd
// at 3 chars. bd accepts a no-tier suffix that is all digits OR a 3-8 char
// base36 hash, free-passing 3-char hashes with no digit ("word collision
// acceptable" because bd is generating a known-real id). Here we are PARSING an
// arbitrary embedded handle and cannot tell a real all-letter hash (`mc-xyz`)
// from a role word (`api-web`), so we diverge on purpose: a no-tier suffix must
// be all digits or a 3-8 char base36 hash that carries a digit at EVERY length.
// The digit gate keeps short English role words ("web", "run", "lead",
// "worker") embedded in a hyphenated name (`city-api-web`, `ops-qa-run`) from
// reading as `role + session id`.
//
// The cost is intentional and bounded: a real no-tier all-letter <=3-char
// session bead id embedded behind a role prefix (`claude-mc-xyz`,
// `worker-fddc-abc`) is NOT extracted here. It degrades to role-only rather
// than risk fabricating a session id from a role word — on this dashboard a
// missing worker/session correlation is safer than a wrong one. A BARE such id
// (`mc-xyz`) is still recovered whole by the SESSION_ID_RE fallback in
// supervisorSessionIdFrom; only the prefixed/embedded form is dropped. A
// matched `wisp-`/`mol-` tier bypasses this gate entirely, since the tier
// marker alone proves a real bead id. session-handle.test.ts pins this boundary.
function isBeadIdSuffix(suffix: string): boolean {
  if (/^[0-9]+$/.test(suffix)) return true;
  if (!/^[a-z0-9]{3,8}$/.test(suffix)) return false;
  return /[0-9]/.test(suffix);
}
