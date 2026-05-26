/**
 * Raw dependency edge from gc supervisor's workflow snapshot endpoint.
 * This mirrors WorkflowDepResponse in the supervisor OpenAPI schema.
 */
export interface GcWorkflowDep {
  from: string;
  to: string;
  kind?: string;
}

/**
 * Raw bead row inside a gc supervisor workflow snapshot. This is still
 * supervisor wire shape, not the dashboard's display node shape. It mirrors
 * WorkflowBeadResponse in the supervisor OpenAPI schema.
 */
export interface GcWorkflowBead {
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
 * Raw gc supervisor response for GET /v0/city/{name}/workflow/{id}.
 * The dashboard only supports root metadata `gc.formula_contract='graph.v2'`
 * for the detail view; backend enrichment rejects other contracts explicitly.
 */
export interface GcWorkflowSnapshot {
  workflow_id: string;
  root_bead_id: string;
  root_store_ref: string;
  resolved_root_store: string;
  scope_kind: string;
  scope_ref: string;
  snapshot_version: number;
  snapshot_event_seq?: number | null;
  partial: boolean;
  stores_scanned: string[] | null;
  beads: GcWorkflowBead[] | null;
  deps: GcWorkflowDep[] | null;
  logical_nodes: Record<string, never>[] | null;
  logical_edges: GcWorkflowDep[] | null;
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
