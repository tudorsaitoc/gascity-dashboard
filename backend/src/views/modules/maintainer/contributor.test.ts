import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTier, tally, type RawCounts, type GhListItem } from './contributor.js';

// gascity-dashboard-z9sj: direct unit coverage for the contributor trust-tier
// classifier and the in-memory tally aggregation. deriveTier's ordering is
// load-bearing — spam_risk MUST be tested before regular so a contributor
// with 5 unaccepted issues gets the warning, not the benefit of the doubt.

function counts(overrides: Partial<RawCounts> = {}): RawCounts {
  return {
    issues_opened: 0,
    issues_accepted: 0,
    prs_opened: 0,
    prs_merged: 0,
    ...overrides,
  };
}

describe('deriveTier — trust tier thresholds', () => {
  test('>=20 merged PRs → core', () => {
    assert.equal(deriveTier(counts({ prs_merged: 20, prs_opened: 20 })), 'core');
  });

  test('19 merged PRs (just under core) → trusted', () => {
    assert.equal(deriveTier(counts({ prs_merged: 19, prs_opened: 19 })), 'trusted');
  });

  test('>=5 merged PRs → trusted', () => {
    assert.equal(deriveTier(counts({ prs_merged: 5, prs_opened: 5 })), 'trusted');
  });

  test('>=10 issues_accepted (0 merged PRs) → trusted', () => {
    assert.equal(
      deriveTier(counts({ issues_accepted: 10, issues_opened: 12 })),
      'trusted',
    );
  });

  test('4 merged PRs (under trusted) but >=1 → regular', () => {
    assert.equal(deriveTier(counts({ prs_merged: 4, prs_opened: 4 })), 'regular');
  });

  test('1 accepted issue, low total → regular', () => {
    assert.equal(
      deriveTier(counts({ issues_accepted: 1, issues_opened: 2 })),
      'regular',
    );
  });
});

describe('deriveTier — spam_risk ordering (spam_risk before regular)', () => {
  test('5 opened, 0 accepted/merged → spam_risk (lots of noise, nothing landed)', () => {
    assert.equal(deriveTier(counts({ issues_opened: 5 })), 'spam_risk');
  });

  test('5 PRs opened, 0 merged → spam_risk', () => {
    assert.equal(deriveTier(counts({ prs_opened: 5 })), 'spam_risk');
  });

  test('mixed 3 issues + 2 PRs opened, none accepted → spam_risk', () => {
    assert.equal(
      deriveTier(counts({ issues_opened: 3, prs_opened: 2 })),
      'spam_risk',
    );
  });

  test('4 opened, 0 accepted (under spam threshold) → new (total<=1 is false here, falls to regular)', () => {
    // total=4, accepted=0 → not spam_risk (needs >=5), not regular (accepted<1),
    // not new (total>1) → final fallback 'regular'.
    assert.equal(deriveTier(counts({ issues_opened: 4 })), 'regular');
  });

  test('spam threshold met but one item accepted → NOT spam_risk → regular', () => {
    // accepted===0 is required for spam_risk; one acceptance flips it.
    assert.equal(
      deriveTier(counts({ issues_opened: 5, issues_accepted: 1 })),
      'regular',
    );
  });

  test('spam_risk is reached before the regular fallback (5 opened, 0 accepted)', () => {
    // 5 unaccepted contributions: not core/trusted, not new (total>1). Without
    // the spam_risk check this would fall through to the final 'regular'
    // return — so this confirms spam_risk is tested before that fallback.
    assert.equal(deriveTier(counts({ prs_opened: 5 })), 'spam_risk');
  });
});

describe('deriveTier — new and fallback', () => {
  test('0 contributions → new', () => {
    assert.equal(deriveTier(counts()), 'new');
  });

  test('exactly 1 contribution, 0 accepted → new', () => {
    assert.equal(deriveTier(counts({ issues_opened: 1 })), 'new');
  });

  test('2 opened, 0 accepted (total>1, under spam) → regular fallback', () => {
    assert.equal(deriveTier(counts({ issues_opened: 2 })), 'regular');
  });
});

describe('tally — per-author aggregation', () => {
  const issue = (number: number, login: string | null, state: string): GhListItem => ({
    number,
    author: login === null ? null : { login },
    state,
  });

  test('counts issues_opened and issues_accepted (CLOSED = accepted)', () => {
    const issues: GhListItem[] = [
      issue(1, 'alice', 'OPEN'),
      issue(2, 'alice', 'CLOSED'),
      issue(3, 'alice', 'CLOSED'),
    ];
    const out = tally(issues, []);
    const alice = out.get('alice');
    assert.ok(alice);
    assert.equal(alice.issues_opened, 3);
    assert.equal(alice.issues_accepted, 2);
  });

  test('counts prs_opened and prs_merged (MERGED = merged)', () => {
    const prs: GhListItem[] = [
      issue(10, 'bob', 'OPEN'),
      issue(11, 'bob', 'MERGED'),
      issue(12, 'bob', 'CLOSED'),
    ];
    const out = tally([], prs);
    const bob = out.get('bob');
    assert.ok(bob);
    assert.equal(bob.prs_opened, 3);
    // Only MERGED counts as merged — a CLOSED-not-merged PR does not.
    assert.equal(bob.prs_merged, 1);
  });

  test('aggregates issues and PRs for the same author', () => {
    const issues: GhListItem[] = [issue(1, 'carol', 'CLOSED')];
    const prs: GhListItem[] = [issue(2, 'carol', 'MERGED')];
    const out = tally(issues, prs);
    const carol = out.get('carol');
    assert.ok(carol);
    assert.equal(carol.issues_opened, 1);
    assert.equal(carol.issues_accepted, 1);
    assert.equal(carol.prs_opened, 1);
    assert.equal(carol.prs_merged, 1);
  });

  test('skips items with null author or empty login', () => {
    const issues: GhListItem[] = [
      issue(1, null, 'OPEN'),
      issue(2, '', 'OPEN'),
      issue(3, 'dave', 'OPEN'),
    ];
    const out = tally(issues, []);
    assert.equal(out.size, 1);
    assert.ok(out.has('dave'));
  });

  test('derives the correct tier on the aggregated ContributorStat', () => {
    // 25 merged PRs → core.
    const prs: GhListItem[] = Array.from({ length: 25 }, (_, i) =>
      issue(i + 1, 'eve', 'MERGED'),
    );
    const out = tally([], prs);
    const eve = out.get('eve');
    assert.ok(eve);
    assert.equal(eve.tier, 'core');
    assert.equal(eve.prs_merged, 25);
    assert.equal(eve.prs_opened, 25);
  });

  test('stamps a computed_at timestamp on every stat', () => {
    const out = tally([issue(1, 'frank', 'OPEN')], []);
    const frank = out.get('frank');
    assert.ok(frank);
    assert.equal(typeof frank.computed_at, 'string');
    assert.equal(frank.login, 'frank');
  });

  test('empty inputs → empty map', () => {
    assert.equal(tally([], []).size, 0);
  });
});
