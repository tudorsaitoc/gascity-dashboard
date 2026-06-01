// Bead-id validator for routes that read or act on a bead by id.
//
// Supervisor-issued bead ids come in mixed shapes (gc-123, co-ysv,
// agent-diagnostics-y84, td-7t24i6, etc.); the gc-CLI BEAD_ID_RE
// /^(td|th|jt)-[a-z0-9-]{3,32}$/ is too narrow for any prefix outside
// td/th/jt. Read paths historically worked around this with a permissive
// regex inline; the write paths (close/nudge) did not, which is the
// gascity-dashboard-bwp bug.
//
// Posture: subprocess args are passed as argv (no shell:true), so the
// regex's job is argv hygiene, not shell-injection defense. The char
// class below excludes whitespace, quotes, semicolons, `$`, backticks,
// brackets, slashes, pipes, ampersands — every shell metacharacter — so
// any id that matches is safe to pass through to `gc`/`bd`.

export const BEAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
