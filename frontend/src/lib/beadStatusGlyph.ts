import type { BeadStatus } from 'gas-city-dashboard-shared';

// Greyscale-neutral bead-status vocabulary for LIST surfaces (the convoy
// timeline and the /convoy index). A list of many beads must not paint several
// maroons, so per DESIGN.md's One Mark Rule status here is carried by the glyph
// and word, never by tone — keeping the list readable under the Greyscale Test.
// (Single-status surfaces that can afford the accent use StatusBadge instead.)

export interface BeadStatusDisplay {
  glyph: string;
  word: string;
}

export function describeBeadStatus(status: BeadStatus): BeadStatusDisplay {
  switch (status) {
    case 'closed':
      return { glyph: '✓', word: 'closed' };
    case 'in_progress':
      return { glyph: '●', word: 'in progress' };
    case 'blocked':
      return { glyph: '!', word: 'blocked' };
    case 'deferred':
      return { glyph: '∅', word: 'deferred' };
    case 'open':
      return { glyph: '·', word: 'open' };
    default:
      return { glyph: '·', word: status };
  }
}
