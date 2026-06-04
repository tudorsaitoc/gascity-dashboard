import type { TriageItem, TriageTierSection } from 'gas-city-dashboard-shared';

/**
 * Pure filter helper for the "Needs PR only" toggle
 * (gascity-dashboard-omv). Returns a new TriageTierSection containing
 * only issue items where `has_in_flight_pr === false`. PR items are
 * dropped entirely because the filter is issue-focused.
 */
export function filterTierByNeedsPr(section: TriageTierSection): TriageTierSection {
  const needsPr = (item: TriageItem): boolean =>
    item.kind === 'issue' && item.has_in_flight_pr === false;
  const filteredClusters = section.clusters
    .map((cluster) => ({
      ...cluster,
      items: cluster.items.filter(needsPr),
    }))
    .filter((cluster) => cluster.items.length > 0);
  return {
    ...section,
    clusters: filteredClusters,
    unclustered: section.unclustered.filter(needsPr),
  };
}

/**
 * Pure filter helper for the "Awaiting triage only" toggle
 * (gascity-dashboard-x8q). Returns a new TriageTierSection containing
 * only items whose `triage_assessment` is null.
 */
export function filterTierByAwaitingTriage(section: TriageTierSection): TriageTierSection {
  const awaiting = (item: TriageItem): boolean => item.triage_assessment === null;
  const filteredClusters = section.clusters
    .map((cluster) => ({
      ...cluster,
      items: cluster.items.filter(awaiting),
    }))
    .filter((cluster) => cluster.items.length > 0);
  return {
    ...section,
    clusters: filteredClusters,
    unclustered: section.unclustered.filter(awaiting),
  };
}

/**
 * Per-tier vetted / awaiting tally. Counts are computed from the
 * unfiltered tier so toggles do not rewrite the tier's underlying size.
 */
export function countTierByVetted(section: TriageTierSection): {
  vetted: number;
  awaiting: number;
} {
  let vetted = 0;
  let awaiting = 0;
  const tally = (item: TriageItem): void => {
    if (item.triage_assessment !== null) vetted += 1;
    else awaiting += 1;
  };
  for (const item of section.unclustered) tally(item);
  for (const cluster of section.clusters) {
    for (const item of cluster.items) tally(item);
  }
  return { vetted, awaiting };
}
