import { describe, expect, it } from 'vitest';
import { beadStatusTone } from './StatusBadge';

describe('beadStatusTone', () => {
  it('uses one canonical tone map for bead detail and bead list badges', () => {
    expect(beadStatusTone('in_progress')).toBe('ok');
    expect(beadStatusTone('blocked')).toBe('stuck');
    expect(beadStatusTone('open')).toBe('warn');
    expect(beadStatusTone('closed')).toBe('neutral');
    expect(beadStatusTone('deferred')).toBe('warn');
  });

  it('tones supervisor wire spellings through the shared normalized vocabulary', () => {
    // Wire-native spellings the old hardcoded switch dropped into the warn
    // default now tone the same as their bd-ledger twins.
    expect(beadStatusTone('active')).toBe('ok');
    expect(beadStatusTone('running')).toBe('ok');
    expect(beadStatusTone('completed')).toBe('neutral');
    expect(beadStatusTone('done')).toBe('neutral');
  });

  it('normalizes cased / padded spellings instead of falling through to warn', () => {
    expect(beadStatusTone('Active')).toBe('ok');
    expect(beadStatusTone(' completed ')).toBe('neutral');
    expect(beadStatusTone('Blocked')).toBe('stuck');
  });
});
