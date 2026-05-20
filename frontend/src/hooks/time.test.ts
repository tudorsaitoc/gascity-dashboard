import { describe, expect, it } from 'vitest';
import { formatRelative } from './time';

const NOW = Date.parse('2026-05-20T12:00:00.000Z');

function isoAgo(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe('formatRelative', () => {
  it('returns the interpunct sentinel for undefined input', () => {
    expect(formatRelative(undefined, NOW)).toBe('·');
  });

  it('returns the interpunct sentinel for unparseable input', () => {
    expect(formatRelative('not-a-date', NOW)).toBe('·');
    expect(formatRelative('', NOW)).toBe('·');
  });

  it('returns "now" for timestamps less than 5 seconds old', () => {
    expect(formatRelative(isoAgo(0), NOW)).toBe('now');
    expect(formatRelative(isoAgo(2_000), NOW)).toBe('now');
    expect(formatRelative(isoAgo(4_400), NOW)).toBe('now');
  });

  it('formats seconds for diffs in the [5s, 60s) range', () => {
    expect(formatRelative(isoAgo(5_000), NOW)).toBe('5s');
    expect(formatRelative(isoAgo(30_000), NOW)).toBe('30s');
    expect(formatRelative(isoAgo(59_000), NOW)).toBe('59s');
  });

  it('formats minutes for diffs in the [1m, 1h) range', () => {
    expect(formatRelative(isoAgo(60_000), NOW)).toBe('1m');
    expect(formatRelative(isoAgo(5 * 60_000), NOW)).toBe('5m');
    expect(formatRelative(isoAgo(59 * 60_000), NOW)).toBe('59m');
  });

  it('formats hours for diffs in the [1h, 24h) range', () => {
    expect(formatRelative(isoAgo(60 * 60_000), NOW)).toBe('1h');
    expect(formatRelative(isoAgo(6 * 60 * 60_000), NOW)).toBe('6h');
    expect(formatRelative(isoAgo(23 * 60 * 60_000), NOW)).toBe('23h');
  });

  it('formats days for diffs of 1 day or more', () => {
    expect(formatRelative(isoAgo(24 * 60 * 60_000), NOW)).toBe('1d');
    expect(formatRelative(isoAgo(7 * 24 * 60 * 60_000), NOW)).toBe('7d');
    expect(formatRelative(isoAgo(365 * 24 * 60 * 60_000), NOW)).toBe('365d');
  });

  it('clamps future timestamps to "now" (negative diff floored to 0)', () => {
    expect(formatRelative(new Date(NOW + 60_000).toISOString(), NOW)).toBe('now');
  });

  it('accepts a Date instance', () => {
    expect(formatRelative(new Date(NOW - 10_000), NOW)).toBe('10s');
  });

  it('accepts a number (epoch ms)', () => {
    expect(formatRelative(NOW - 10_000, NOW)).toBe('10s');
  });
});
