import type { GcBead, GcMailItem, GcSession } from 'gas-city-dashboard-shared';

// Per-source project derivation. There is no explicit project field
// on any of the three wire shapes, so we derive from observable
// conventions in the data:
//
// - Beads: ID is `<project>-<suffix>` where suffix is alnum, optionally
//   followed by `.N` (e.g. `gc-1920`, `codeprobe-4cl6.2`,
//   `code-intel-digest-mp5`). Strip the suffix to get the project.
//
// - Sessions: `rig` is a filesystem root path; basename = project.
//   When rig is missing, fall back to `pool`, then `template`, then
//   the special bucket "(no rig)" so the row is still visible.
//
// - Mail: `rig` is already a project name (e.g. "ds-research"); use
//   directly. When absent, fall back to "(no rig)".

const BEAD_ID_RX = /^(.+?)-[a-z0-9]+(?:\.\d+)?$/i;

export function beadProject(bead: GcBead): string {
  const m = BEAD_ID_RX.exec(bead.id);
  return m?.[1] ?? bead.id;
}

export function sessionProject(session: GcSession): string {
  const candidate = session.rig ?? session.pool ?? session.template;
  if (!candidate) return '(no rig)';
  // basename — handle both '/' and '\' for cross-platform safety.
  const parts = candidate.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? candidate;
}

export function mailProject(mail: GcMailItem): string {
  if (mail.rig && mail.rig.length > 0) return mail.rig;
  return '(no rig)';
}
