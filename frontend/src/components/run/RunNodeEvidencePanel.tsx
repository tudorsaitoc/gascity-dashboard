import type {
    RunDiffResponse,
    RunDisplayNode,
} from "gas-city-dashboard-shared";
import { RunDiffPanel } from "./RunDiffPanel";
import { RunNodeSessionPanel } from "./RunNodeSessionPanel";

interface RunNodeEvidencePanelProps {
  tab: "diff" | "session";
  diff: RunDiffResponse;
  selectedNode: RunDisplayNode | null;
}

export function RunNodeEvidencePanel({
  tab,
  diff,
  selectedNode,
}: RunNodeEvidencePanelProps) {
  if (tab === "session") {
    return <RunNodeSessionPanel node={selectedNode} visible />;
  }
  return <RunDiffPanel diff={diff} />;
}
