import type {
  ContributorStat,
  MaintainerTriage,
  TriageItem,
  TriageItemStatus,
  TriageTierSection,
} from 'gas-city-dashboard-shared';
import { execGhIssueList, execGhPrList, ExecError } from '../exec.js';

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
}

export async function fetchTriage(repo: string): Promise<MaintainerTriage> {
  const [issuesRaw, prsRaw] = await Promise.all([
    execGhIssueList(repo, ITEM_FETCH_LIMIT),
    execGhPrList(repo, ITEM_FETCH_LIMIT),
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
    tier: null,
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
    tier: null,
    cluster_id: null,
    blast_files: [],
    lines_changed: adds + dels,
    weak_ties: [],
    linked_numbers: extractLinkedIssueNumbers(pr.body),
    html_url: pr.url,
    is_marked: false,
  };
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

function composeEnvelope(repo: string, items: TriageItem[]): MaintainerTriage {
  const issuesOpen = items.filter((i) => i.kind === 'issue').length;
  const prsOpen = items.filter((i) => i.kind === 'pr').length;

  // Until the priority classifier (bead 7ts) lands, every item drops
  // into stability.unclustered as the safe-default tier. The empty
  // REGRESSION + BREAKING and REGRESSION tier headings stay present so
  // the page shape is stable across enrichment iterations.
  const tiers: TriageTierSection[] = [
    { tier: 'regression_breaking', clusters: [], unclustered: [] },
    { tier: 'regression', clusters: [], unclustered: [] },
    { tier: 'stability', clusters: [], unclustered: items },
  ];

  return {
    computed_at: null,
    repo,
    tiers,
    totals: { issues_open: issuesOpen, prs_open: prsOpen },
  };
}
