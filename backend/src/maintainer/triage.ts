import type {
  ContributorStat,
  MaintainerTriage,
  TriageItem,
  TriageItemStatus,
  TriageTier,
  TriageTierSection,
} from 'gas-city-dashboard-shared';
import { execGhIssueList, execGhPrList, ExecError } from '../exec.js';
import { classifyItem } from './classifier.js';
import { computeContributorStats } from './contributor.js';
import { buildClusters, inheritIssueFiles } from './blast-radius.js';
import { buildTopicClusters } from './topics.js';
import { parseTriageAssessment, sortScore } from './triage-assessment.js';

// Compose a MaintainerTriage envelope from raw `gh` output.
//
// gascity-dashboard-361: the ingest layer. This layer does NOT classify
// tiers, compute clusters, derive trust tiers, or generate weak ties —
// every TriageItem comes out with tier=null, cluster_id=null,
// blast_files=[], weak_ties=[], and ContributorStat with tier='regular'
// and rates=null. Downstream beads enrich the envelope in place:
//   - 7ts (priority-classifier) sets item.tier + item.is_marked
//   - gtr (blast-radius)        sets item.cluster_id + item.blast_files
//   - alh (contributor-stats)   replaces item.author with computed tiers/rates
//   - 98h (semantic-weak-ties)  sets item.weak_ties
//
// Until those run, every item lands in the `stability` tier as
// unclustered. The frontend renders that as one quiet pile under the
// REGRESSION + BREAKING and REGRESSION tier headings (which are empty
// at first), which is exactly the "haven't triaged yet" reading.

const ITEM_FETCH_LIMIT = 500;

interface GhAuthor {
  login?: string;
}

interface GhLabel {
  name?: string;
}

interface GhIssue {
  number: number;
  title: string;
  createdAt: string;
  updatedAt: string;
  author: GhAuthor | null;
  labels?: GhLabel[];
  url: string;
}

interface GhPrFile {
  path?: string;
  additions?: number;
  deletions?: number;
}

interface GhPr {
  number: number;
  title: string;
  createdAt: string;
  updatedAt: string;
  author: GhAuthor | null;
  labels?: GhLabel[];
  url: string;
  body?: string;
  additions?: number;
  deletions?: number;
  reviewDecision?: string;
  isDraft?: boolean;
  state?: string;
  files?: GhPrFile[];
}

export async function fetchTriage(repo: string): Promise<MaintainerTriage> {
  // Four parallel gh calls: two for the open lists (361 ingest), two for
  // the full lifetime history that drives contributor stats (alh). The
  // contributor fetches are by far the biggest payloads but they're
  // bounded by the repo's total history, not the number of unique
  // authors — much cheaper than per-login round-trips would be.
  const [issuesRaw, prsRaw, contributorStats] = await Promise.all([
    execGhIssueList(repo, ITEM_FETCH_LIMIT),
    execGhPrList(repo, ITEM_FETCH_LIMIT),
    computeContributorStats(repo),
  ]);

  if (issuesRaw.truncated) {
    throw new ExecError(
      'gh issue list output exceeded 100KB cap — narrow the fetch fields or raise the limit',
      'spawn',
    );
  }
  if (prsRaw.truncated) {
    throw new ExecError(
      'gh pr list output exceeded 100KB cap — narrow the fetch fields or raise the limit',
      'spawn',
    );
  }
  if (issuesRaw.exitCode !== 0) {
    throw new ExecError(
      `gh issue list exited ${issuesRaw.exitCode}: ${issuesRaw.stderr.slice(0, 256)}`,
      'spawn',
    );
  }
  if (prsRaw.exitCode !== 0) {
    throw new ExecError(
      `gh pr list exited ${prsRaw.exitCode}: ${prsRaw.stderr.slice(0, 256)}`,
      'spawn',
    );
  }

  const issues = parseJsonArray<GhIssue>(issuesRaw.stdout, 'gh issue list');
  const prs = parseJsonArray<GhPr>(prsRaw.stdout, 'gh pr list');

  const issueItems = issues.map(mapIssue);
  const prItems = prs.map(mapPr);

  // Splice the computed ContributorStat onto each item's author. Authors
  // we couldn't find stats for (deleted accounts, ghosts) keep the
  // defaultContributor fallback.
  for (const item of [...issueItems, ...prItems]) {
    const stat = contributorStats.get(item.author.login);
    if (stat !== undefined) item.author = stat;
  }

  // Blast-radius enrichment (gascity-dashboard-gtr). PRs already carry
  // blast_files from `gh pr list --json files`; issues with linked
  // open PRs in this envelope inherit those files so the issue joins
  // the same cluster as its fix-candidate.
  inheritIssueFiles([...issueItems, ...prItems]);

  // Reverse map: every issue gets the PR numbers that fix it (derived
  // from each PR's already-populated linked_numbers, which mapPr filled
  // in by parsing the PR body for closing verbs).
  const prsByFixedIssue = new Map<number, number[]>();
  for (const pr of prItems) {
    for (const issueNum of pr.linked_numbers) {
      const existing = prsByFixedIssue.get(issueNum);
      if (existing) existing.push(pr.number);
      else prsByFixedIssue.set(issueNum, [pr.number]);
    }
  }
  for (const issue of issueItems) {
    const linkedPrs = prsByFixedIssue.get(issue.number);
    if (linkedPrs && linkedPrs.length > 0) {
      issue.linked_numbers = linkedPrs;
    }
  }

  return composeEnvelope(repo, [...issueItems, ...prItems]);
}

function parseJsonArray<T>(stdout: string, source: string): T[] {
  if (stdout.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`${source} did not return an array`);
    }
    return parsed as T[];
  } catch (err) {
    throw new ExecError(
      `${source} returned unparseable JSON: ${(err as Error).message}`,
      'spawn',
    );
  }
}

function mapIssue(it: GhIssue): TriageItem {
  return {
    kind: 'issue',
    number: it.number,
    title: it.title,
    status: 'open',
    author: defaultContributor(it.author?.login ?? 'unknown'),
    created_at: it.createdAt,
    updated_at: it.updatedAt,
    labels: extractLabels(it.labels),
    tier: null,
    triage_score: null,
    triage_assessment: null,
    slung: null,
    cluster_id: null,
    blast_files: [],
    lines_changed: null,
    weak_ties: [],
    linked_numbers: [],
    html_url: it.url,
    is_marked: false,
  };
}

// Matches GitHub's set of issue-closing verbs in PR bodies. Word-boundary
// anchored on both sides so "prefix" / "suffix" cases don't false-match.
// "Fix(es)? #N" alone is treated as closing per GitHub's own parser; we
// match the same lexicon. See GitHub Docs > "Linking a pull request to an
// issue".
const CLOSING_REF_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;

function extractLinkedIssueNumbers(body: string | undefined): number[] {
  if (!body) return [];
  const seen = new Set<number>();
  for (const m of body.matchAll(CLOSING_REF_RE)) {
    const raw = m[1];
    if (raw === undefined) continue;
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) seen.add(n);
  }
  return Array.from(seen);
}

function mapPr(pr: GhPr): TriageItem {
  const adds = pr.additions ?? 0;
  const dels = pr.deletions ?? 0;
  return {
    kind: 'pr',
    number: pr.number,
    title: pr.title,
    status: derivePrStatus(pr),
    author: defaultContributor(pr.author?.login ?? 'unknown'),
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    labels: extractLabels(pr.labels),
    tier: null,
    triage_score: null,
    triage_assessment: null,
    slung: null,
    cluster_id: null,
    blast_files: extractFiles(pr.files),
    lines_changed: adds + dels,
    weak_ties: [],
    linked_numbers: extractLinkedIssueNumbers(pr.body),
    html_url: pr.url,
    is_marked: false,
  };
}

function extractLabels(labels: GhLabel[] | undefined): string[] {
  if (!labels) return [];
  return labels
    .map((l) => l.name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
}

function extractFiles(files: GhPrFile[] | undefined): string[] {
  if (!files) return [];
  return files
    .map((f) => f.path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
}

function derivePrStatus(pr: GhPr): TriageItemStatus {
  if (pr.isDraft === true) return 'draft';
  const decision = pr.reviewDecision;
  if (decision === 'APPROVED') return 'approved';
  if (decision === 'CHANGES_REQUESTED') return 'changes_requested';
  if (decision === 'REVIEW_REQUIRED') return 'needs_review';
  return 'open';
}

function defaultContributor(login: string): ContributorStat {
  return {
    login,
    tier: 'regular',
    issues_accepted: null,
    issues_opened: null,
    prs_merged: null,
    prs_opened: null,
    computed_at: null,
  };
}

/**
 * Walk every TriageItem in an envelope (unclustered + clustered, across
 * all tiers) into a flat array. Shared by the serve-time overlay
 * (gascity-dashboard-9qs, routes/maintainer.ts) and the worker
 * slung-state purge (gascity-dashboard-4jy, maintainer/worker.ts) so
 * both walk the envelope by the same rule. Mutations to the returned
 * items mutate the envelope in place — both call sites depend on that.
 */
export function collectItems(envelope: MaintainerTriage): TriageItem[] {
  const out: TriageItem[] = [];
  for (const tier of envelope.tiers) {
    for (const item of tier.unclustered) out.push(item);
    for (const cluster of tier.clusters) {
      for (const item of cluster.items) out.push(item);
    }
  }
  return out;
}

/**
 * One Mark Rule enforcement: at most ONE maroon ● on the entire page.
 * Picks the single highest-scoring mark candidate via sortScore and
 * clears the rest.
 *
 * Semantics (gascity-dashboard-bs2): the mark is an operator-action
 * signal, not a problem-anchor. The only meaningful operator move on
 * a triage row is slinging a triage/draft agent. If an open PR already
 * exists for an issue, the PR IS the action queue — marking the issue
 * would invite the operator to sling a duplicate. So:
 *
 *   1. Any issue with at least one in-flight PR (status not 'merged'
 *      / not 'closed') in this envelope claiming to close it via
 *      `linked_numbers` is excluded from the candidate set. The mark
 *      stays on the PR (or falls to the next non-blocked candidate
 *      if the PR is not the top scorer).
 *   2. The legacy parent-transfer from PR → parent issue only fires
 *      when the parent issue is still a candidate after (1). With
 *      step (1) in place, this is effectively a no-op for the
 *      in-flight-PR case but defends against future isMarkCandidate
 *      changes that might mark issues directly.
 *
 * Extracted from composeEnvelope so the GET overlay (gascity-dashboard-9qs)
 * can re-run the winnow after splicing slung-state onto items at serve
 * time. Mutates each item's is_marked in place.
 *
 * Callers must have already populated tier + triage_score on every item
 * AND set the provisional is_marked from classifyItem / isMarkCandidate.
 * Items whose is_marked is already false are passed over.
 */
export function selectOneMark(items: TriageItem[]): void {
  // (1) Build the set of issue numbers whose in-flight PR is in view.
  // A PR is in-flight when its status is anything other than merged /
  // closed — gh issue/pr list returns only open items today, so all PRs
  // here qualify, but the explicit predicate future-proofs against a
  // wider fetch. Any candidate issue in this set is dropped from the
  // mark scan so the eye lands on the action (the PR), not the problem.
  const issueNumbersWithInFlightPr = new Set<number>();
  for (const item of items) {
    if (item.kind !== 'pr') continue;
    if (item.status === 'merged' || item.status === 'closed') continue;
    for (const linkedNum of item.linked_numbers) {
      issueNumbersWithInFlightPr.add(linkedNum);
    }
  }
  for (const item of items) {
    if (item.kind === 'issue' && issueNumbersWithInFlightPr.has(item.number)) {
      item.is_marked = false;
    }
  }

  // (2) Pick the top scorer among the surviving candidates. Uses
  // sortScore so a vetted item wins the mark over an unvetted item
  // with a higher heuristic score (vetted is the stronger signal).
  let topMark: TriageItem | null = null;
  for (const item of items) {
    if (!item.is_marked) continue;
    if (topMark === null || sortScore(item) > sortScore(topMark)) {
      topMark = item;
    }
  }
  for (const item of items) {
    if (item.is_marked && item !== topMark) item.is_marked = false;
  }

  // (3) Legacy parent-transfer (PR → parent issue) gated on the parent
  // still being a candidate after step (1). After bs2 this effectively
  // never fires for PRs that close an issue, because step (1) removes
  // the parent from the candidate set. The guard remains so a future
  // candidate model that marks issues directly still gets the pairing
  // behaviour without re-introducing the bs2 regression.
  if (topMark !== null && topMark.kind === 'pr' && topMark.linked_numbers.length > 0) {
    for (const linkedNum of topMark.linked_numbers) {
      const parent = items.find(
        (i) => i.kind === 'issue' && i.number === linkedNum,
      );
      if (parent !== undefined && parent.is_marked) {
        topMark.is_marked = false;
        parent.is_marked = true;
        break;
      }
    }
  }
}

function composeEnvelope(repo: string, items: TriageItem[]): MaintainerTriage {
  const issuesOpen = items.filter((i) => i.kind === 'issue').length;
  const prsOpen = items.filter((i) => i.kind === 'pr').length;

  // Apply the priority classifier (gascity-dashboard-7ts) in place:
  // every item gets its tier, triage_score, and a provisional is_marked.
  // Then overlay the agent-vetted triage_assessment (are) — when the
  // triage skill agent has labeled an item with the full triage/* set,
  // its vetted_score takes precedence over the heuristic for sort + render.
  for (const item of items) {
    const { tier, is_marked, triage_score } = classifyItem(item);
    item.tier = tier;
    item.is_marked = is_marked;
    item.triage_score = triage_score;
    item.triage_assessment = parseTriageAssessment(item.labels);
  }

  selectOneMark(items);

  const byTier = new Map<TriageTier, TriageItem[]>([
    ['regression_breaking', []],
    ['regression', []],
    ['stability', []],
  ]);
  for (const item of items) {
    if (item.tier === null) continue;
    byTier.get(item.tier)?.push(item);
  }
  for (const list of byTier.values()) {
    list.sort((a, b) => sortScore(b) - sortScore(a));
  }

  // Two-pass clustering within each tier:
  //   1. buildClusters (gascity-dashboard-gtr): file-overlap, authoritative
  //      signal — items sharing real file paths cluster first.
  //   2. buildTopicClusters (gascity-dashboard-98h): topic-keyword,
  //      semantic-ish — picks up the unclustered residue by matching
  //      repo-specific subsystem names in titles. Each item ends up in
  //      at most one cluster across the two passes.
  const tiers: TriageTierSection[] = (
    ['regression_breaking', 'regression', 'stability'] as const
  ).map((tier) => {
    const tierItems = byTier.get(tier) ?? [];
    const fileResult = buildClusters(tierItems);
    const topicResult = buildTopicClusters(fileResult.unclustered);
    return {
      tier,
      clusters: [...fileResult.clusters, ...topicResult.clusters],
      unclustered: topicResult.unclustered,
    };
  });

  // computed_at marks the snapshot moment. Set once a classifier (or
  // any future enrichment pass) has run. Until enrichment beads gtr,
  // alh, 98h all land, this just means tiers + scores are populated.
  return {
    computed_at: new Date().toISOString(),
    repo,
    tiers,
    totals: { issues_open: issuesOpen, prs_open: prsOpen },
  };
}
