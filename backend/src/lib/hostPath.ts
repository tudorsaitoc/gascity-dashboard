// Shared host-path validator (gascity-dashboard-ucc review fix). A city's
// host path is supervisor-reported and threaded into subprocess `--city`
// flags (exec.ts) and into `fs.stat` of `<cityPath>/.dolt/noms` (dolt.ts).
// Both sites must apply the SAME safety rule so one cannot accept a path the
// other rejects. Previously exec.ts checked `startsWith('/') && !'..'` while
// dolt.ts only checked `path.isAbsolute()` — a `..` traversal slipped past
// the dolt sampler. This helper is the single gate for both.

/**
 * True when `p` is a safe absolute host path: it is absolute (POSIX leading
 * `/`), contains no `..` traversal segment, and carries no NUL byte. A
 * `..`-bearing segment is rejected even when the path is absolute, because
 * the value is consumed literally by a subprocess / `fs` call without prior
 * normalization.
 */
export function isValidHostPath(p: string): boolean {
  if (p.length === 0) return false;
  if (!p.startsWith('/')) return false;
  if (p.includes('\0')) return false;
  return !p.split('/').includes('..');
}
