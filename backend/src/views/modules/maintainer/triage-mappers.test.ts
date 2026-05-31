import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { ContributorStat, MaintainerTriage, TriageItem } from 'gas-city-dashboard-shared';
import type { ExecResult } from '../../../exec-core.js';
import { fetchTriage, collectItems } from './triage.js';

// gascity-dashboard-z9sj: direct coverage for the ingest mappers
// (extractLinkedIssueNumbers regex, derivePrStatus precedence, and the mapPr
// field translation). These functions are module-private, so they are pinned
// through the public fetchTriage injected-deps seam — the same seam the
// triage-contributor-decouple suite uses. computeStats is stubbed to an empty
// Map so authors keep defaultContributor and the assertions isolate the
// mapping logic from the enrichment pass.

const OK = (stdout: string): ExecResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  truncated: false,
  durationMs: 1,
});

const NO_STATS = async (): Promise<Map<string, ContributorStat>> =>
  new Map<string, ContributorStat>();

const FIXED_ISO = '2026-05-24T00:00:00.000Z';

interface PrInput {
  number: number;
  title?: string;
  body?: string;
  additions?: number;
  deletions?: number;
  reviewDecision?: string;
  isDraft?: boolean;
  labels?: { name?: string }[];
  files?: { path?: string; additions?: number; deletions?: number }[];
}

async function ingestPrs(prs: PrInput[], issues: unknown[] = []): Promise<TriageItem[]> {
  const envelope: MaintainerTriage = await fetchTriage('owner/repo', {
    fetchIssues: async (): Promise<ExecResult> => OK(JSON.stringify(issues)),
    fetchPrs: async (): Promise<ExecResult> =>
      OK(
        JSON.stringify(
          prs.map((p) => ({
            number: p.number,
            title: p.title ?? `pr ${p.number}`,
            createdAt: FIXED_ISO,
            updatedAt: FIXED_ISO,
            author: { login: 'someone' },
            url: `https://example/pull/${p.number}`,
            body: p.body,
            additions: p.additions,
            deletions: p.deletions,
            reviewDecision: p.reviewDecision,
            isDraft: p.isDraft,
            labels: p.labels,
            files: p.files,
          })),
        ),
      ),
    computeStats: NO_STATS,
  });
  return collectItems(envelope).filter((i) => i.kind === 'pr');
}

function onePr(input: PrInput): Promise<TriageItem> {
  return ingestPrs([input]).then((prs) => {
    const pr = prs.find((p) => p.number === input.number);
    assert.ok(pr, `PR #${input.number} should be ingested`);
    return pr;
  });
}

describe('mapPr — derivePrStatus precedence', () => {
  test('isDraft true wins over reviewDecision', async () => {
    const pr = await onePr({ number: 1, isDraft: true, reviewDecision: 'APPROVED' });
    assert.equal(pr.status, 'draft');
  });

  test('APPROVED → approved', async () => {
    const pr = await onePr({ number: 2, reviewDecision: 'APPROVED' });
    assert.equal(pr.status, 'approved');
  });

  test('CHANGES_REQUESTED → changes_requested', async () => {
    const pr = await onePr({ number: 3, reviewDecision: 'CHANGES_REQUESTED' });
    assert.equal(pr.status, 'changes_requested');
  });

  test('REVIEW_REQUIRED → needs_review', async () => {
    const pr = await onePr({ number: 4, reviewDecision: 'REVIEW_REQUIRED' });
    assert.equal(pr.status, 'needs_review');
  });

  test('no reviewDecision, not draft → open', async () => {
    const pr = await onePr({ number: 5 });
    assert.equal(pr.status, 'open');
  });

  test('unknown reviewDecision → open (fallthrough)', async () => {
    const pr = await onePr({ number: 6, reviewDecision: 'SOMETHING_ELSE' });
    assert.equal(pr.status, 'open');
  });
});

describe('mapPr — field translation', () => {
  test('lines_changed = additions + deletions', async () => {
    const pr = await onePr({ number: 1, additions: 30, deletions: 12 });
    assert.equal(pr.lines_changed, 42);
  });

  test('missing additions/deletions default to 0 → lines_changed 0', async () => {
    const pr = await onePr({ number: 2 });
    assert.equal(pr.lines_changed, 0);
  });

  test('blast_files extracted from files[].path, dropping empty/missing', async () => {
    const pr = await onePr({
      number: 3,
      files: [{ path: 'a.ts' }, { path: '' }, {}, { path: 'b.ts' }],
    });
    assert.deepEqual(pr.blast_files, ['a.ts', 'b.ts']);
  });

  test('kind, number, title, html_url carried through', async () => {
    const pr = await onePr({ number: 99, title: 'a fix' });
    assert.equal(pr.kind, 'pr');
    assert.equal(pr.number, 99);
    assert.equal(pr.title, 'a fix');
    assert.equal(pr.html_url, 'https://example/pull/99');
  });
});

describe('extractLinkedIssueNumbers — closing-verb regex', () => {
  async function linked(body: string | undefined): Promise<number[]> {
    // fetchTriage's issue→PR reverse-map only rewrites issue.linked_numbers,
    // never PR.linked_numbers, so a PR's parsed value is what we read here.
    const pr = await onePr({ number: 1, body });
    return [...pr.linked_numbers].sort((a, b) => a - b);
  }

  test('undefined body → []', async () => {
    assert.deepEqual(await linked(undefined), []);
  });

  test('no closing verb → []', async () => {
    assert.deepEqual(await linked('see #12 for context'), []);
  });

  test('"Fixes #12" → [12]', async () => {
    assert.deepEqual(await linked('Fixes #12'), [12]);
  });

  test('"closes #3" lowercase → [3]', async () => {
    assert.deepEqual(await linked('closes #3'), [3]);
  });

  test('all closing verbs: close/closes/closed/fix/fixes/fixed/resolve/resolves/resolved', async () => {
    const body =
      'close #1 closes #2 closed #3 fix #4 fixes #5 fixed #6 resolve #7 resolves #8 resolved #9';
    assert.deepEqual(await linked(body), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test('case-insensitive verb match (FIXES)', async () => {
    assert.deepEqual(await linked('FIXES #42'), [42]);
  });

  test('deduplicates repeated references', async () => {
    assert.deepEqual(await linked('fixes #5 and also closes #5'), [5]);
  });

  test('word-boundary: "prefixes #9" must NOT match (no false "fixes")', async () => {
    assert.deepEqual(await linked('prefixes #9'), []);
  });

  test('requires a space before the # — "fix#7" does not match', async () => {
    assert.deepEqual(await linked('fix#7'), []);
  });

  test('multiple distinct issues across the body', async () => {
    assert.deepEqual(await linked('fixes #100\n\nAlso resolves #200.'), [100, 200]);
  });
});
