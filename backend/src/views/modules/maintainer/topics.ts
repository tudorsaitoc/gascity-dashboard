import type { TriageCluster, TriageItem } from 'gas-city-dashboard-shared';
import { sortScore } from './triage-assessment.js';

// Topic-keyword clustering for items that don't share files
// (gascity-dashboard-98h).
//
// The original bead spec called for an embedding-based agglomerative
// cluster pass. In practice, gastownhall/gascity titles are dense with
// repo-specific subsystem names ("session", "agent", "pack", "beads",
// "dolt", etc.) — typical maintainer convention. A deterministic
// dictionary match against those subsystems produces the same outcome
// the embedding model would, without the ANTHROPIC_API_KEY infrastructure
// the project doesn't yet have. A later bead can swap this for the
// embedding pass if topics drift across repos or the dictionary stops
// fitting; the wire shape doesn't change.
//
// Topics are repo-specific. This dictionary is gastownhall/gascity-shaped.
// When another repo is added to the maintainer view (MAINTAINER_REPO env),
// it'll need its own topics file or a discover-from-titles fallback.

// Each topic has a canonical name (what shows in the cluster header)
// and one or more patterns that match it. Aliasing lets `bd` and
// `beads` (same subsystem, different surface form) cluster as one
// rather than splitting traffic across two near-identical groups.
// Same for `mol` / `molecule`.
interface TopicDef {
  canonical: string;
  patterns: string[];
}

const GASCITY_TOPICS: ReadonlyArray<TopicDef> = [
  // Agent lifecycle
  { canonical: 'session', patterns: ['session'] },
  { canonical: 'agent', patterns: ['agent'] },
  { canonical: 'mayor', patterns: ['mayor'] },
  { canonical: 'pool', patterns: ['pool'] },
  { canonical: 'rig', patterns: ['rig'] },
  // Issue tracker / data
  { canonical: 'beads', patterns: ['beads', 'bd'] },
  { canonical: 'dolt', patterns: ['dolt'] },
  { canonical: 'noms', patterns: ['noms'] },
  { canonical: 'molecule', patterns: ['molecule', 'mol'] },
  // Project templates / packs / convention
  { canonical: 'pack', patterns: ['pack'] },
  { canonical: 'gastown', patterns: ['gastown'] },
  { canonical: 'formula', patterns: ['formula'] },
  { canonical: 'recipe', patterns: ['recipe'] },
  { canonical: 'gear', patterns: ['gear'] },
  { canonical: 'examples', patterns: ['examples'] },
  { canonical: 'tutorial', patterns: ['tutorial'] },
  // Orchestration
  { canonical: 'supervisor', patterns: ['supervisor'] },
  { canonical: 'city', patterns: ['city'] },
  { canonical: 'reconciler', patterns: ['reconciler'] },
  { canonical: 'scheduler', patterns: ['scheduler'] },
  { canonical: 'convoy', patterns: ['convoy'] },
  { canonical: 'overseer', patterns: ['overseer'] },
  // Comms
  { canonical: 'mail', patterns: ['mail'] },
  { canonical: 'message', patterns: ['message'] },
  // Health / maintenance
  { canonical: 'doctor', patterns: ['doctor'] },
  { canonical: 'health', patterns: ['health'] },
  { canonical: 'watchdog', patterns: ['watchdog'] },
  { canonical: 'reaper', patterns: ['reaper'] },
  { canonical: 'refinery', patterns: ['refinery'] },
  { canonical: 'maintenance', patterns: ['maintenance'] },
  // Infra
  { canonical: 'exec', patterns: ['exec'] },
  { canonical: 'build', patterns: ['build'] },
  { canonical: 'deploy', patterns: ['deploy'] },
  { canonical: 'kanban', patterns: ['kanban'] },
  // Providers / integrations
  { canonical: 'codex', patterns: ['codex'] },
  { canonical: 'claude', patterns: ['claude'] },
  { canonical: 'prompt', patterns: ['prompt'] },
  { canonical: 'evals', patterns: ['evals'] },
  { canonical: 'sling', patterns: ['sling'] },
  // Cross-cutting concerns
  { canonical: 'docs', patterns: ['docs'] },
  { canonical: 'order-tracking', patterns: ['order-tracking'] },
];

// Word-boundary regex per pattern; case-insensitive. Trailing `s?` so
// the singular catches plurals too. Each pattern resolves to its
// topic's canonical name, so aliased patterns cluster as one.
const TOPIC_REGEXES: ReadonlyArray<{ canonical: string; re: RegExp }> =
  GASCITY_TOPICS.flatMap((t) =>
    t.patterns.map((p) => ({
      canonical: t.canonical,
      re: new RegExp(`\\b${escapeRegex(p)}s?\\b`, 'i'),
    })),
  );

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns the canonical topic for an item, or null if no topic matches.
 * Multiple matches resolve to the first hit in TOPIC_REGEXES order —
 * dictionary is listed roughly most-specific to least so the narrower
 * subsystem wins over broader ones.
 */
export function deriveTopic(item: TriageItem): string | null {
  const haystack = item.title;
  for (const { canonical, re } of TOPIC_REGEXES) {
    if (re.test(haystack)) return canonical;
  }
  return null;
}

/**
 * Group items by topic into clusters. Singleton topics fall to the
 * unclustered list. Designed to run AFTER buildClusters: feed it the
 * unclustered residue of the file-overlap pass.
 *
 * Resulting TriageCluster.cluster_id is `@topic/<name>` so the frontend
 * can detect topic-vs-file clusters by prefix and render them with a
 * different header style.
 */
export function buildTopicClusters(items: TriageItem[]): {
  clusters: TriageCluster[];
  unclustered: TriageItem[];
} {
  const byTopic = new Map<string, TriageItem[]>();
  for (const it of items) {
    const topic = deriveTopic(it);
    if (topic === null) continue;
    const list = byTopic.get(topic);
    if (list) list.push(it);
    else byTopic.set(topic, [it]);
  }

  const clusters: TriageCluster[] = [];
  const claimed = new Set<TriageItem>();

  // Order clusters by member-count desc so the biggest subsystems
  // surface first within their tier section.
  const entries = Array.from(byTopic.entries()).sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );

  for (const [topic, members] of entries) {
    if (members.length < 2) continue;
    for (const m of members) claimed.add(m);
    clusters.push({
      cluster_id: `@topic/${topic}`,
      files: [`@topic/${topic}`],
      items: members
        .slice()
        .sort((a, b) => sortScore(b) - sortScore(a)),
      lines_pending: members
        .filter((m) => m.kind === 'pr')
        .reduce((sum, m) => sum + (m.lines_changed ?? 0), 0),
    });
  }

  const unclustered = items.filter((it) => !claimed.has(it));
  return { clusters, unclustered };
}
