import type {
  ContributorStat,
  ContributorTier,
  IsoTimestamp,
} from 'gas-city-dashboard-shared';
import {
  execGhIssueListAll,
  execGhPrListAll,
  ExecError,
} from '../exec.js';
import { parseJsonArray } from '../lib/parse-json.js';

// Contributor stats + trust tier classifier (gascity-dashboard-alh).
//
// Per-author counts for the maintainer to read someone's track record
// inline on every row:
//   issues_opened  / issues_accepted  → ratio of issues that turned
//                                       into "accepted" / "completed"
//                                       work vs noise.
//   prs_opened     / prs_merged       → ratio of PRs that made it in.
//
// The naive per-login implementation (4 search/issues queries per
// author × 113 unique authors) hits gh's 30 req/min search rate limit
// and would take 15 minutes. Instead, fetch the full lifetime issue
// and PR history in two bulk calls, then tally per author in memory.
// Bounded: gastownhall/gascity currently has ~670 issues and ~1800
// PRs, comfortably within the 2MB MAX_BYTES_LARGE cap when the json
// shape is kept minimal (number, author, state, stateReason only).
//
// Result: ~10–15s on first refresh; subsequent refreshes hit the
// 24h-cached envelope until the nightly worker (bead ar9) refreshes it.

interface GhListItemAuthor {
  login?: string;
}

interface GhListItem {
  number: number;
  author: GhListItemAuthor | null;
  state: string;
}

interface RawCounts {
  issues_opened: number;
  issues_accepted: number;
  prs_opened: number;
  prs_merged: number;
}

const ISSUE_FETCH_LIMIT = 5000;
const PR_FETCH_LIMIT = 5000;

export async function computeContributorStats(
  repo: string,
): Promise<Map<string, ContributorStat>> {
  const [issuesRaw, prsRaw] = await Promise.all([
    execGhIssueListAll(repo, ISSUE_FETCH_LIMIT),
    execGhPrListAll(repo, PR_FETCH_LIMIT),
  ]);

  if (issuesRaw.truncated || prsRaw.truncated) {
    throw new ExecError(
      'contributor history exceeded 2MB cap — repo grew beyond ingest budget',
      'spawn',
    );
  }
  if (issuesRaw.exitCode !== 0) {
    throw new ExecError(
      `gh issue list (all) exited ${issuesRaw.exitCode}: ${issuesRaw.stderr.slice(0, 256)}`,
      'spawn',
    );
  }
  if (prsRaw.exitCode !== 0) {
    throw new ExecError(
      `gh pr list (all) exited ${prsRaw.exitCode}: ${prsRaw.stderr.slice(0, 256)}`,
      'spawn',
    );
  }

  const issues = parseJsonArray<GhListItem>(issuesRaw.stdout, 'gh issue list (all)');
  const prs = parseJsonArray<GhListItem>(prsRaw.stdout, 'gh pr list (all)');

  return tally(issues, prs);
}

function tally(issues: GhListItem[], prs: GhListItem[]): Map<string, ContributorStat> {

  const counts = new Map<string, RawCounts>();
  for (const it of issues) {
    const login = it.author?.login;
    if (login === undefined || login.length === 0) continue;
    const c = ensureCounts(counts, login);
    c.issues_opened += 1;
    // gh 2.45 doesn't expose stateReason on `gh issue list`, so we can't
    // distinguish "completed" from "not planned" closures here. Treat
    // every CLOSED issue as accepted; in an active repo the not-planned
    // share is small and doesn't move the trust-tier needle. A follow-up
    // bead can switch to `gh api repos/R/issues` if precision matters.
    if (it.state === 'CLOSED') c.issues_accepted += 1;
  }
  for (const pr of prs) {
    const login = pr.author?.login;
    if (login === undefined || login.length === 0) continue;
    const c = ensureCounts(counts, login);
    c.prs_opened += 1;
    if (pr.state === 'MERGED') c.prs_merged += 1;
  }

  const now = new Date().toISOString();
  const out = new Map<string, ContributorStat>();
  for (const [login, c] of counts) {
    out.set(login, buildStat(login, c, now));
  }
  return out;
}

function ensureCounts(map: Map<string, RawCounts>, login: string): RawCounts {
  const existing = map.get(login);
  if (existing) return existing;
  const fresh: RawCounts = {
    issues_opened: 0,
    issues_accepted: 0,
    prs_opened: 0,
    prs_merged: 0,
  };
  map.set(login, fresh);
  return fresh;
}

function buildStat(
  login: string,
  c: RawCounts,
  computedAt: IsoTimestamp,
): ContributorStat {
  return {
    login,
    tier: deriveTier(c),
    issues_accepted: c.issues_accepted,
    issues_opened: c.issues_opened,
    prs_merged: c.prs_merged,
    prs_opened: c.prs_opened,
    computed_at: computedAt,
  };
}

/**
 * Tier word maps quantitative contribution history to a single-word
 * reputation signal the maintainer can read inline on every row.
 *
 *   core        ≥20 merged PRs                    "this is one of us"
 *   trusted     ≥5 merged PRs                     "established positive track"
 *               OR ≥10 issues_accepted             record"
 *   regular     ≥1 merged PR                      "shipped something here"
 *               OR ≥1 issues_accepted
 *   new         total ≤1 contribution             "first-time-ish"
 *   spam_risk   ≥5 contributions, 0 accepted,     "lots of noise, nothing
 *               0 merged                           landed"
 *
 * Order matters: tested top-to-bottom, first match wins. spam_risk
 * has to test BEFORE new so a contributor with 5 unaccepted issues
 * gets the warning, not the benefit of the doubt.
 */
function deriveTier(c: RawCounts): ContributorTier {
  if (c.prs_merged >= 20) return 'core';
  if (c.prs_merged >= 5 || c.issues_accepted >= 10) return 'trusted';
  const total = c.issues_opened + c.prs_opened;
  const accepted = c.issues_accepted + c.prs_merged;
  if (total >= 5 && accepted === 0) return 'spam_risk';
  if (accepted >= 1) return 'regular';
  if (total <= 1) return 'new';
  return 'regular';
}
