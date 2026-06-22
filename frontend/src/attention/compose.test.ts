import { describe, expect, it } from 'vitest';
import type { SourceStatus } from 'gas-city-dashboard-shared';
import {
  ATTENTION_DOMAINS,
  boardFreshness,
  composeAttention,
  type AttentionContributor,
  type AttentionItem,
} from './compose';

describe('composeAttention', () => {
  it('derives per-domain counts and highest severity from item-level facts', () => {
    const model = composeAttention([
      contributor('runs', [
        item('run-attention', 'runs', 'attention'),
        item('run-watch', 'runs', 'watch'),
      ]),
      contributor('mail', [item('mail-watch', 'mail', 'watch')]),
    ]);

    expect(model.byDomain.runs.attention).toBe(1);
    expect(model.byDomain.runs.watch).toBe(1);
    expect(model.byDomain.runs.severity).toBe('attention');
    expect(model.byDomain.mail.attention).toBe(0);
    expect(model.byDomain.mail.watch).toBe(1);
    expect(model.byDomain.mail.severity).toBe('watch');
    expect(model.byDomain.agents.severity).toBeNull();
  });

  it('ranks attention before watch, current actionable items before historical items, then nav domain order', () => {
    const model = composeAttention([
      contributor('mail', [item('mail-watch', 'mail', 'watch', { actionable: true })]),
      contributor('activity', [
        item('historical-activity', 'activity', 'attention', { current: false, actionable: true }),
      ]),
      contributor('beads', [item('bead-attention', 'beads', 'attention')]),
      contributor('agents', [item('agent-attention', 'agents', 'attention', { actionable: true })]),
    ]);

    expect(model.items.map((attention) => attention.id)).toEqual([
      'agent-attention',
      'bead-attention',
      'historical-activity',
      'mail-watch',
    ]);
  });

  it('splits Home top items from grouped overflow with stable domain ordering', () => {
    const model = composeAttention(
      [
        contributor('runs', [
          item('run-1', 'runs', 'attention', { actionable: true }),
          item('run-2', 'runs', 'watch'),
        ]),
        contributor('mail', [item('mail-1', 'mail', 'watch'), item('mail-2', 'mail', 'watch')]),
      ],
      { topLimit: 2 },
    );

    expect(model.topItems.map((attention) => attention.id)).toEqual(['run-1', 'run-2']);
    expect(model.overflowByDomain).toEqual([
      { domain: 'mail', attention: 0, watch: 2, unavailable: 0, total: 2 },
    ]);
  });

  it('counts unavailable items in their own tier without inflating the badge or recoloring it', () => {
    const model = composeAttention([
      contributor('runs', [
        item('run-watch', 'runs', 'watch'),
        item('run-degraded', 'runs', 'unavailable'),
        item('run-down', 'runs', 'unavailable'),
      ]),
    ]);

    // Badge count is attention + watch only — the two unavailable items are excluded.
    expect(model.byDomain.runs.attention).toBe(0);
    expect(model.byDomain.runs.watch).toBe(1);
    expect(model.byDomain.runs.unavailable).toBe(2);
    // The badge tier stays at watch; degraded reads never escalate the color.
    expect(model.byDomain.runs.severity).toBe('watch');
  });

  it('never sets the badge severity from unavailable items alone', () => {
    const model = composeAttention([
      contributor('runs', [
        item('feed-partial', 'runs', 'unavailable'),
        item('detail-down', 'runs', 'unavailable'),
      ]),
    ]);

    expect(model.byDomain.runs.attention).toBe(0);
    expect(model.byDomain.runs.watch).toBe(0);
    expect(model.byDomain.runs.unavailable).toBe(2);
    // No attention/watch items ⇒ no badge, even though the domain has items.
    expect(model.byDomain.runs.severity).toBeNull();
  });

  it('ranks unavailable items last and groups them as their own overflow count', () => {
    const model = composeAttention(
      [
        contributor('runs', [
          item('run-attention', 'runs', 'attention', { actionable: true }),
          item('run-unavailable', 'runs', 'unavailable'),
          item('run-watch', 'runs', 'watch'),
        ]),
      ],
      { topLimit: 1 },
    );

    // attention < watch < unavailable in rank order.
    expect(model.items.map((entry) => entry.id)).toEqual([
      'run-attention',
      'run-watch',
      'run-unavailable',
    ]);
    expect(model.overflowByDomain).toEqual([
      { domain: 'runs', attention: 0, watch: 1, unavailable: 1, total: 2 },
    ]);
  });

  it('keeps the domain set explicit so nav consumers cannot drift', () => {
    expect(ATTENTION_DOMAINS).toEqual([
      'agents',
      'beads',
      'runs',
      'mail',
      'activity',
      'health',
      'maintainer',
    ]);
  });
});

describe('composeAttention — read-freshness fold (gascity-dashboard-5t0m)', () => {
  it('folds a contributor read provenance + fetchedAt onto its domain summary', () => {
    const model = composeAttention([
      freshContributor('runs', { provenance: 'fresh', fetchedAt: '2026-06-18T12:00:00.000Z' }, [
        item('run-1', 'runs', 'attention'),
      ]),
    ]);

    expect(model.byDomain.runs.provenance).toBe('fresh');
    expect(model.byDomain.runs.fetchedAt).toBe('2026-06-18T12:00:00.000Z');
  });

  it('records freshness for a CALM domain with zero items — the frozen-but-quiet signal', () => {
    // The whole point of the spine: a domain can be calm (no items, null
    // severity) yet stale. The fold is contributor-level, so it captures age
    // even when nothing alarming was emitted.
    const model = composeAttention([
      freshContributor(
        'agents',
        { provenance: 'stale', fetchedAt: '2026-06-18T09:00:00.000Z' },
        [],
      ),
    ]);

    expect(model.byDomain.agents.items).toEqual([]);
    expect(model.byDomain.agents.severity).toBeNull();
    expect(model.byDomain.agents.provenance).toBe('stale');
    expect(model.byDomain.agents.fetchedAt).toBe('2026-06-18T09:00:00.000Z');
  });

  it('folds the WORST provenance across a domain (fresh < fixture < stale < error)', () => {
    const model = composeAttention([
      freshContributor('runs', { provenance: 'fresh' }),
      freshContributor('runs', { provenance: 'stale' }),
      freshContributor('runs', { provenance: 'error' }),
      freshContributor('runs', { provenance: 'fixture' }),
    ]);

    expect(model.byDomain.runs.provenance).toBe('error');
  });

  it('ranks fixture worse than fresh but better than stale', () => {
    expect(
      composeAttention([
        freshContributor('runs', { provenance: 'fresh' }),
        freshContributor('runs', { provenance: 'fixture' }),
      ]).byDomain.runs.provenance,
    ).toBe('fixture');
    expect(
      composeAttention([
        freshContributor('runs', { provenance: 'fixture' }),
        freshContributor('runs', { provenance: 'stale' }),
      ]).byDomain.runs.provenance,
    ).toBe('stale');
  });

  it('folds the OLDEST (earliest) fetchedAt across a domain', () => {
    const model = composeAttention([
      freshContributor('mail', { fetchedAt: '2026-06-18T12:00:00.000Z' }),
      freshContributor('mail', { fetchedAt: '2026-06-18T08:00:00.000Z' }),
      freshContributor('mail', { fetchedAt: '2026-06-18T10:00:00.000Z' }),
    ]);

    expect(model.byDomain.mail.fetchedAt).toBe('2026-06-18T08:00:00.000Z');
  });

  it('folds the SOONEST (earliest) staleAt across a domain so it ages as soon as any read would (fchh)', () => {
    const model = composeAttention([
      freshContributor('mail', {
        fetchedAt: '2026-06-18T12:00:00.000Z',
        staleAt: '2026-06-18T12:01:30.000Z',
      }),
      freshContributor('mail', {
        fetchedAt: '2026-06-18T11:59:00.000Z',
        staleAt: '2026-06-18T12:00:30.000Z',
      }),
    ]);

    expect(model.byDomain.mail.staleAt).toBe('2026-06-18T12:00:30.000Z');
  });

  it('keeps a defined signal over an undefined one, regardless of order', () => {
    const before = composeAttention([
      freshContributor('beads', {}),
      freshContributor('beads', { provenance: 'error', fetchedAt: '2026-06-18T01:00:00.000Z' }),
    ]);
    const after = composeAttention([
      freshContributor('beads', { provenance: 'error', fetchedAt: '2026-06-18T01:00:00.000Z' }),
      freshContributor('beads', {}),
    ]);

    expect(before.byDomain.beads.provenance).toBe('error');
    expect(after.byDomain.beads.provenance).toBe('error');
    expect(before.byDomain.beads.fetchedAt).toBe('2026-06-18T01:00:00.000Z');
    expect(after.byDomain.beads.fetchedAt).toBe('2026-06-18T01:00:00.000Z');
  });

  it('leaves provenance/fetchedAt undefined when no contributor reports them', () => {
    const model = composeAttention([contributor('runs', [item('run-1', 'runs', 'attention')])]);

    expect(model.byDomain.runs.provenance).toBeUndefined();
    expect(model.byDomain.runs.fetchedAt).toBeUndefined();
    // The fold must not disturb the existing counts/severity.
    expect(model.byDomain.runs.attention).toBe(1);
    expect(model.byDomain.runs.severity).toBe('attention');
  });
});

describe('boardFreshness — board-wide fold for the Header liveness line (gascity-dashboard-5t0m)', () => {
  const NOW = Date.parse('2026-06-18T12:00:05.000Z');
  // A staleAt comfortably in the future so a landed read still reads as current.
  const FUTURE_STALE = '2026-06-18T12:01:00.000Z';

  it('folds the oldest fetchedAt + worst provenance across domains, with no degraded when all fresh', () => {
    const fresh = boardFreshness(
      composeAttention([
        freshContributor('runs', { provenance: 'fresh', fetchedAt: '2026-06-18T12:00:00.000Z' }),
        freshContributor('mail', {
          provenance: 'fresh',
          fetchedAt: '2026-06-18T08:00:00.000Z',
          staleAt: FUTURE_STALE,
        }),
        freshContributor('agents', {
          provenance: 'fresh',
          fetchedAt: '2026-06-18T10:00:00.000Z',
          staleAt: FUTURE_STALE,
        }),
      ]),
      NOW,
    );

    expect(fresh.provenance).toBe('fresh');
    expect(fresh.fetchedAt).toBe('2026-06-18T08:00:00.000Z');
    expect(fresh.degraded).toEqual([]);
  });

  it('lists every stale/errored domain as degraded — the maroon trigger — and keeps domain order', () => {
    const fresh = boardFreshness(
      composeAttention([
        freshContributor('agents', { provenance: 'error', fetchedAt: '2026-06-18T07:00:00.000Z' }),
        freshContributor('runs', { provenance: 'stale', fetchedAt: '2026-06-18T09:00:00.000Z' }),
        freshContributor('mail', {
          provenance: 'fresh',
          fetchedAt: '2026-06-18T12:00:00.000Z',
          staleAt: FUTURE_STALE,
        }),
      ]),
      NOW,
    );

    // Worst provenance + oldest read across the board.
    expect(fresh.provenance).toBe('error');
    expect(fresh.fetchedAt).toBe('2026-06-18T07:00:00.000Z');
    // degraded follows ATTENTION_DOMAINS order (agents before runs).
    expect(fresh.degraded).toEqual([
      { domain: 'agents', provenance: 'error' },
      { domain: 'runs', provenance: 'stale' },
    ]);
  });

  it('derives stale from read AGE — a polled "fresh" read past its staleAt flips to maroon stale (fchh blocker 1)', () => {
    const now = Date.parse('2026-06-18T12:00:00.000Z');
    const fresh = boardFreshness(
      composeAttention([
        // 'fresh' provenance, but its staleAt has already passed → no longer current.
        freshContributor('agents', {
          provenance: 'fresh',
          fetchedAt: '2026-06-18T11:58:00.000Z',
          staleAt: '2026-06-18T11:59:30.000Z',
        }),
        // 'fresh' with a staleAt still in the future → current.
        freshContributor('mail', {
          provenance: 'fresh',
          fetchedAt: '2026-06-18T11:59:58.000Z',
          staleAt: '2026-06-18T12:01:28.000Z',
        }),
      ]),
      now,
    );

    // The frozen agents poll flips to stale off its AGE, not an error.
    expect(fresh.degraded).toEqual([{ domain: 'agents', provenance: 'stale' }]);
    expect(fresh.provenance).toBe('stale');
  });

  it('does NOT age-flip the event-driven runs source — it carries no staleAt even when its read is old (fchh Option B)', () => {
    const now = Date.parse('2026-06-18T12:00:00.000Z');
    const fresh = boardFreshness(
      composeAttention([
        // runs read is hours old but has no staleAt: its liveness is the gc event
        // stream (BoardLiveness/sseState), not a read age, so it must not flip.
        freshContributor('runs', { provenance: 'fresh', fetchedAt: '2026-06-18T08:00:00.000Z' }),
      ]),
      now,
    );
    expect(fresh.degraded).toEqual([]);
    expect(fresh.provenance).toBe('fresh');
  });

  it('a fixture-only board never ages to stale (demo data is not a staleness alarm)', () => {
    const fresh = boardFreshness(
      composeAttention([
        // Even with a long-passed staleAt, fixture is intentional demo data.
        freshContributor('runs', {
          provenance: 'fixture',
          fetchedAt: '2026-06-18T00:00:00.000Z',
          staleAt: '2026-06-18T00:01:30.000Z',
        }),
      ]),
      NOW,
    );
    expect(fresh.provenance).toBe('fixture');
    expect(fresh.degraded).toEqual([]);
  });

  it('an empty board reports no freshness and stays silent', () => {
    const fresh = boardFreshness(composeAttention([]), NOW);
    expect(fresh.provenance).toBeUndefined();
    expect(fresh.fetchedAt).toBeUndefined();
    expect(fresh.degraded).toEqual([]);
  });
});

function contributor(
  domain: AttentionItem['domain'],
  items: readonly AttentionItem[],
): AttentionContributor {
  return {
    id: `${domain}-test`,
    domain,
    getItems: () => items,
  };
}

function freshContributor(
  domain: AttentionItem['domain'],
  freshness: { provenance?: SourceStatus; fetchedAt?: string; staleAt?: string },
  items: readonly AttentionItem[] = [],
): AttentionContributor {
  return {
    id: `${domain}-fresh`,
    domain,
    getItems: () => items,
    ...(freshness.provenance !== undefined && { provenance: freshness.provenance }),
    ...(freshness.fetchedAt !== undefined && { fetchedAt: freshness.fetchedAt }),
    ...(freshness.staleAt !== undefined && { staleAt: freshness.staleAt }),
  };
}

function item(
  id: string,
  domain: AttentionItem['domain'],
  severity: AttentionItem['severity'],
  overrides: Partial<AttentionItem> = {},
): AttentionItem {
  return {
    id,
    domain,
    severity,
    title: id,
    href: `/${domain}`,
    current: true,
    actionable: false,
    ...overrides,
  };
}
