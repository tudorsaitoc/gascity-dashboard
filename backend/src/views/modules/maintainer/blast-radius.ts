import type { TriageCluster, TriageItem } from 'gas-city-dashboard-shared';
import { sortScore } from './triage-assessment.js';

// File-overlap clustering for the maintainer triage view
// (gascity-dashboard-gtr).
//
// PRs come with blast_files already populated from `gh pr list --json
// files`. Issues inherit blast_files from any linked open PR (the
// PR-body-parsed linked_numbers, computed earlier in triage.ts) so an
// issue with someone working on it joins the same cluster as its
// fix-candidate PR. Issues without a linked PR stay blast_files=[]
// and end up in unclustered until LLM-driven file prediction lands
// in a follow-up.
//
// Clustering: greedy by file co-occurrence. For each file, list the
// items touching it. Files with >=2 items become clusters. Items are
// claimed by the first (largest) cluster that covers them, so each
// item appears in exactly one cluster. The cluster header surfaces
// the files appearing in at least half the cluster's members, up to
// three — the "central" files for that group of work.

const HEADER_FILE_CAP = 3;

/**
 * Sets blast_files on issues that have linked open PRs in the same
 * envelope by union-merging the PR's files. Mutates items in place.
 */
export function inheritIssueFiles(items: TriageItem[]): void {
  const prByNumber = new Map<number, TriageItem>();
  for (const it of items) {
    if (it.kind === 'pr') prByNumber.set(it.number, it);
  }
  for (const it of items) {
    if (it.kind !== 'issue') continue;
    if (it.linked_numbers.length === 0) continue;
    const collected = new Set<string>();
    for (const prNum of it.linked_numbers) {
      const pr = prByNumber.get(prNum);
      if (pr === undefined) continue;
      for (const f of pr.blast_files) collected.add(f);
    }
    if (collected.size > 0) it.blast_files = Array.from(collected).sort();
  }
}

/**
 * Splits an item list into clusters + leftover unclustered. Pure: does
 * not mutate the input. Each item appears in at most one cluster; if
 * an item belongs to no multi-member file group it lands in the
 * unclustered list. Sort within cluster is triage_score desc, matching
 * the in-tier sort.
 */
export function buildClusters(items: TriageItem[]): {
  clusters: TriageCluster[];
  unclustered: TriageItem[];
} {
  const filesToItems = new Map<string, TriageItem[]>();
  for (const item of items) {
    for (const file of item.blast_files) {
      const list = filesToItems.get(file);
      if (list) list.push(item);
      else filesToItems.set(file, [item]);
    }
  }

  // Process candidate files in descending member-count order so the
  // biggest clusters form first; remaining files only cluster what's
  // left after.
  const fileEntries = Array.from(filesToItems.entries())
    .filter(([, members]) => members.length >= 2)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  const clusters: TriageCluster[] = [];
  const assigned = new Set<TriageItem>();

  for (const [pivotFile, members] of fileEntries) {
    const eligible = members.filter((it) => !assigned.has(it));
    if (eligible.length < 2) continue;
    for (const it of eligible) assigned.add(it);

    clusters.push({
      cluster_id: pivotFile,
      files: deriveClusterHeaderFiles(eligible),
      items: eligible.slice().sort((a, b) => sortScore(b) - sortScore(a)),
      lines_pending: eligible
        .filter((it) => it.kind === 'pr')
        .reduce((sum, it) => sum + (it.lines_changed ?? 0), 0),
    });
  }

  const unclustered = items.filter((it) => !assigned.has(it));
  return { clusters, unclustered };
}

function deriveClusterHeaderFiles(items: TriageItem[]): string[] {
  // A file qualifies for the header if it shows up in at least half the
  // cluster's members — that's the "central concern" of this group of
  // work, distinct from incidental files only touched by one PR.
  const threshold = Math.max(2, Math.ceil(items.length / 2));
  const counts = new Map<string, number>();
  for (const it of items) {
    for (const f of it.blast_files) {
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, HEADER_FILE_CAP)
    .map(([f]) => f);
}
