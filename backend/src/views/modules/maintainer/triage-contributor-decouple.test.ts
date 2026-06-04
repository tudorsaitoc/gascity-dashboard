import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { ContributorStat, MaintainerTriage } from 'gas-city-dashboard-shared';
import type { ExecResult } from '../../../exec-core.js';
import { fetchTriage, collectItems } from './triage.js';

// gascity-dashboard-wplw: a contributor-stats failure is optional
// enrichment and must NOT take down the cheap, still-valid open-issue /
// open-PR ingest. computeContributorStats throws hard on a 2MB-cap
// truncation or any `gh` non-zero exit; previously it was awaited in the
// SAME Promise.all as the primary ingest, so any such failure rejected
// fetchTriage entirely. The fix decouples it: a stats failure degrades to
// an empty Map (authors keep defaultContributor) and is logged loudly
// (Don't Swallow Errors), instead of rejecting fetchTriage.

const OK = (stdout: string): ExecResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  truncated: false,
  durationMs: 1,
});

const ISSUES_JSON = JSON.stringify([
  {
    number: 1,
    title: 'an open issue',
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z',
    author: { login: 'alice' },
    labels: [{ name: 'kind/bug' }],
    url: 'https://github.com/o/r/issues/1',
  },
]);

const PRS_JSON = JSON.stringify([
  {
    number: 2,
    title: 'an open pr',
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z',
    author: { login: 'bob' },
    labels: [],
    url: 'https://github.com/o/r/pull/2',
    body: '',
    additions: 1,
    deletions: 0,
    files: [],
  },
]);

function okStubs() {
  return {
    fetchIssues: async (): Promise<ExecResult> => OK(ISSUES_JSON),
    fetchPrs: async (): Promise<ExecResult> => OK(PRS_JSON),
  };
}

describe('fetchTriage — contributor-stats failure is decoupled from ingest', () => {
  test('a thrown contributor-stats failure does not reject fetchTriage; items still ingest with defaultContributor', async () => {
    const warnSpy = mock.method(console, 'error', () => undefined);
    try {
      const envelope: MaintainerTriage = await fetchTriage('owner/repo', {
        ...okStubs(),
        computeStats: async (): Promise<Map<string, ContributorStat>> => {
          throw new Error('contributor history exceeded 2MB cap — repo grew beyond ingest budget');
        },
      });

      // The cheap ingest is intact: both the open issue and open PR landed.
      const items = collectItems(envelope);
      const numbers = items.map((i) => i.number).sort((a, b) => a - b);
      assert.deepEqual(numbers, [1, 2], 'both ingested items must survive a stats failure');
      assert.equal(envelope.totals.issues_open, 1);
      assert.equal(envelope.totals.prs_open, 1);

      // Authors fall back to defaultContributor (tier 'regular', null rates),
      // not to a thrown rejection.
      for (const item of items) {
        assert.equal(item.author.tier, 'regular');
        assert.equal(item.author.prs_merged, null);
        assert.equal(item.author.computed_at, null);
      }
    } finally {
      warnSpy.mock.restore();
    }
  });

  test('the contributor-stats failure is logged loudly, not swallowed silently', async () => {
    const errorSpy = mock.method(console, 'error', () => undefined);
    try {
      await fetchTriage('owner/repo', {
        ...okStubs(),
        computeStats: async (): Promise<Map<string, ContributorStat>> => {
          throw new Error('gh pr list (all) exited 1: rate limit exceeded');
        },
      });

      const logged = errorSpy.mock.calls.map((c) => String(c.arguments[0]));
      assert.ok(
        logged.some((line) => line.includes('rate limit exceeded')),
        `expected the contributor-stats failure to be logged; saw: ${JSON.stringify(logged)}`,
      );
    } finally {
      errorSpy.mock.restore();
    }
  });

  test('when contributor stats succeed, computed tiers are still spliced onto items', async () => {
    const computed: ContributorStat = {
      login: 'alice',
      tier: 'core',
      issues_accepted: 5,
      issues_opened: 8,
      prs_merged: 25,
      prs_opened: 30,
      computed_at: '2026-05-24T00:00:00.000Z',
    };
    const envelope = await fetchTriage('owner/repo', {
      ...okStubs(),
      computeStats: async (): Promise<Map<string, ContributorStat>> =>
        new Map([['alice', computed]]),
    });
    const items = collectItems(envelope);
    const alice = items.find((i) => i.author.login === 'alice');
    assert.ok(alice, 'alice item present');
    assert.equal(alice.author.tier, 'core', 'computed tier must splice onto the author');
    assert.equal(alice.author.prs_merged, 25);
  });
});
