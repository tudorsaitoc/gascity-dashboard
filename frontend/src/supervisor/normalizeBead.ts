import type { DashboardBead } from 'gas-city-dashboard-shared';
import type { Bead } from 'gas-city-dashboard-shared/gc-supervisor';

// Narrow a supervisor wire `Bead` into the dashboard-owned `DashboardBead`
// projection at the frontend edge. Shared selectors operate on DashboardBead
// and never import the generated supervisor type; this is the single seam that
// drops it (gascity-dashboard-caag consolidated the per-reader copies that had
// drifted independently in entityLinks.ts and runSummary.ts).
//
// Optional wire fields are copied only when present so an absent field stays
// absent on the projection rather than becoming an explicit `undefined`.

export function normalizeBead(bead: Bead): DashboardBead {
  return {
    id: bead.id,
    title: bead.title,
    status: bead.status,
    issue_type: bead.issue_type,
    priority: bead.priority ?? null,
    created_at: bead.created_at,
    ...(bead.description !== undefined && { description: bead.description }),
    ...(bead.assignee !== undefined && { assignee: bead.assignee }),
    ...(Array.isArray(bead.labels) && { labels: bead.labels }),
    ...(bead.metadata !== undefined && { metadata: bead.metadata }),
    ...(bead.ref !== undefined && { ref: bead.ref }),
    ...(bead.parent !== undefined && { parent: bead.parent }),
    ...(bead.from !== undefined && { from: bead.from }),
    ...(bead.ephemeral !== undefined && { ephemeral: bead.ephemeral }),
    ...(bead.needs !== undefined && { needs: bead.needs }),
    ...(bead.dependencies !== undefined && { dependencies: bead.dependencies }),
    ...(bead.updated_at !== undefined && { updated_at: bead.updated_at }),
  };
}

export function normalizeBeads(beads: readonly Bead[]): DashboardBead[] {
  return beads.map(normalizeBead);
}
