/**
 * Raw dependency edge from gc supervisor's run snapshot endpoint.
 * This mirrors RunDepResponse in the supervisor OpenAPI schema.
 */
export interface GcRunDep {
  from: string;
  to: string;
  kind?: string;
}

/**
 * Raw bead row inside a gc supervisor run snapshot. This is still
 * supervisor wire shape, not the dashboard's display node shape. It mirrors
 * RunBeadResponse in the supervisor OpenAPI schema.
 */
export interface GcRunBead {
  id: string;
  title: string;
  status: string;
  kind: string;
  step_ref?: string;
  attempt?: number;
  logical_bead_id?: string;
  scope_ref?: string;
  assignee?: string;
  metadata: Record<string, string>;
}

/**
 * Dashboard-normalized gc supervisor snapshot. The current supervisor wire
 * route is GET /v0/city/{name}/workflow/{workflow_id}; the dashboard client
 * translates `workflow_id` to `run_id` at the edge so the rest of the app uses
 * product language.
 */
export interface GcRunSnapshot {
  run_id: string;
  root_bead_id: string;
  root_store_ref: string;
  resolved_root_store: string;
  scope_kind: string;
  scope_ref: string;
  snapshot_version: number;
  snapshot_event_seq?: number | null;
  partial: boolean;
  stores_scanned: string[] | null;
  beads: GcRunBead[] | null;
  deps: GcRunDep[] | null;
  logical_nodes: Record<string, never>[] | null;
  logical_edges: GcRunDep[] | null;
  scope_groups: Record<string, never>[] | null;
}

export interface GcFormulaPreviewNode {
  id: string;
  title?: string;
  kind?: string;
}

export interface GcFormulaPreviewEdge {
  from: string;
  to: string;
  kind?: string;
}

export interface GcFormulaDetail {
  name: string;
  preview?: {
    nodes?: GcFormulaPreviewNode[];
    edges?: GcFormulaPreviewEdge[];
  };
  steps?: GcFormulaPreviewNode[];
  deps?: GcFormulaPreviewEdge[];
}
