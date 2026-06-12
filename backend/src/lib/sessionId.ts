// Session-id validator for routes that read or stream a gc session.
//
// Supervisor session ids seen by this dashboard include gc-/td-/th-prefixed
// handles and city-scoped short prefixes such as mc-* and fddc-*. The 2-4
// letter prefix stays general because city codes are derived per-deployment
// and can't be enumerated here (a session id is the session bead's id, so the
// prefix is the city store's bead prefix — 2-letter codes like mc- are real).
// Everything else is a strict, lowercase-only gate: session ids are lowercase
// by supervisor convention, so the pattern is case-sensitive (no /i) to avoid
// widening the allow-list to mixed-case look-alikes. Keep this shared between
// peek and stream routes so both session surfaces accept the same id alphabet
// before any supervisor call.

export const SESSION_ID_RE = /^[a-z]{2,4}-[a-z0-9-]{1,32}$/;
