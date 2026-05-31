import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
    RunDiffResponse,
    RunDisplayNode,
} from "gas-city-dashboard-shared";
import { afterEach, describe, expect, it } from "vitest";
import { FormulaRunTabs } from "./FormulaRunTabs";

afterEach(() => cleanup());

describe("FormulaRunTabs", () => {
  it("keeps the Session tab available so selected nodes can explain unresolved sessions", () => {
    render(
      <FormulaRunTabs diff={emptyDiff()} selectedNode={nodeWithoutSession()} />,
    );

    const sessionTab = screen.getByRole("tab", { name: "Session" });
    expect(sessionTab.hasAttribute("disabled")).toBe(false);
    expect(
      screen.getByText("Session unresolved for the current running node."),
    ).toBeTruthy();
  });

  it("keeps Session available before selection so the panel can prompt for a node", () => {
    render(<FormulaRunTabs diff={emptyDiff()} selectedNode={null} />);

    const sessionTab = screen.getByRole("tab", { name: "Session" });
    expect(sessionTab.hasAttribute("disabled")).toBe(false);
  });

  it("does not force an explicit Diff choice back to Session on same-node refreshes", () => {
    const { rerender } = render(
      <FormulaRunTabs
        diff={diffWithBody("+initial diff")}
        selectedNode={nodeWithoutSession()}
      />,
    );

    expect(
      screen.getByText("Session unresolved for the current running node."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Diff" }));
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
      "run-evidence-tab-diff",
    );
    expect(screen.getByText("initial diff")).toBeTruthy();

    rerender(
      <FormulaRunTabs
        diff={diffWithBody("+updated diff")}
        selectedNode={{ ...nodeWithoutSession(), title: "Review refreshed" }}
      />,
    );

    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
      "run-evidence-tab-diff",
    );
    expect(screen.getByText("updated diff")).toBeTruthy();
    expect(
      screen.queryByText("Session unresolved for the current running node."),
    ).toBeNull();
  });
});

function nodeWithoutSession(): RunDisplayNode {
  return {
    id: "review",
    semanticNodeId: "review",
    title: "Review",
    kind: "step",
    constructKind: "step",
    status: "active",
    currentBeadId: "review",
    scope: { kind: "run" },
    visibleInGraph: true,
    historicalOnly: false,
    iterationSummary: { kind: "single" },
    attemptSummary: { kind: "none" },
    visibleExecutionInstanceId: "review",
    executionInstances: [
      {
        id: "review",
        semanticNodeId: "review",
        beadId: "review",
        iteration: { kind: "base" },
        attempt: { kind: "untracked" },
        label: "base",
        status: "active",
        session: { kind: "none", reason: "session_unresolved" },
        currentIteration: true,
        historical: false,
      },
    ],
    controlBadges: [],
  };
}

function emptyDiff(): RunDiffResponse {
  return {
    kind: "ok",
    rootPath: { kind: "known", path: "/tmp/run" },
    comparison: { kind: "head", reason: "no_upstream" },
    status: [],
    changedFiles: [],
    patch: "",
    truncated: false,
  };
}

function diffWithBody(body: string): RunDiffResponse {
  return {
    ...emptyDiff(),
    changedFiles: [{ path: "src/app.ts", status: "M", kind: "code" }],
    patch: [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 3a4e79a..b6c9d02 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -0,0 +1 @@",
      body,
    ].join("\n"),
  };
}
