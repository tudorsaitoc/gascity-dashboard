import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { FormulaRunDetail } from "gas-city-dashboard-shared";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { invalidate } from "../api/cache";
import { api } from "../api/client";
import { reportClientError } from "../lib/clientErrorReporting";
import { useFormulaRunDetail } from "./useFormulaRunDetail";

vi.mock("../api/client", () => ({
  api: {
    formulaRun: vi.fn(),
    runDiff: vi.fn(),
  },
}));

vi.mock("../lib/clientErrorReporting", () => ({
  reportClientError: vi.fn(() => Promise.resolve({ status: "reported" })),
}));

const mockFormulaRun = api.formulaRun as Mock;
const mockRunDiff = api.runDiff as Mock;
const mockReportClientError = reportClientError as Mock;

afterEach(() => {
  cleanup();
  invalidate("");
  vi.clearAllMocks();
});

describe("useFormulaRunDetail", () => {
  it("does not fetch or report when no run id is available", async () => {
    const { result } = renderHook(() => useFormulaRunDetail(undefined));

    await waitFor(() => expect(result.current.kind).toBe("idle"));

    expect(mockFormulaRun).not.toHaveBeenCalled();
    expect(mockRunDiff).not.toHaveBeenCalled();
    expect(mockReportClientError).not.toHaveBeenCalled();
  });

  it("reports run detail load failures to the centralized client log", async () => {
    mockFormulaRun.mockRejectedValue(new Error("detail unavailable"));
    mockRunDiff.mockResolvedValue({ kind: "ok" });

    const { result } = renderHook(() => useFormulaRunDetail("wf-1"));

    await waitFor(() =>
      expect(result.current).toMatchObject({
        kind: "failed",
        error: "detail unavailable",
      }),
    );

    expect(mockReportClientError).toHaveBeenCalledWith({
      component: "formula-run-detail",
      operation: "load detail",
      message: "wf-1: detail unavailable",
    });
  });

  it("keeps the detail visible and reports diff load failures", async () => {
    mockFormulaRun.mockResolvedValue(detail());
    mockRunDiff.mockRejectedValue(new Error("git unavailable"));

    const { result } = renderHook(() => useFormulaRunDetail("wf-1"));

    await waitFor(() => expect(result.current.kind).toBe("ready"));

    if (result.current.kind !== "ready")
      throw new Error("run detail did not load");
    expect(result.current.detail.runId).toBe("wf-1");
    expect(result.current.refreshState).toEqual({ kind: "idle" });
    expect(result.current.diff).toMatchObject({
      kind: "error",
      error: "git unavailable",
    });
    expect(mockReportClientError).toHaveBeenCalledWith({
      component: "formula-run-detail",
      operation: "load diff",
      message: "wf-1: git unavailable",
    });
  });
});

function detail(): FormulaRunDetail {
  return {
    runId: "wf-1",
    rootBeadId: "wf-1",
    rootStoreRef: "city:racoon-city",
    resolvedRootStore: "city:racoon-city",
    scopeKind: "city",
    scopeRef: "racoon-city",
    title: "Run",
    formula: { kind: "known", name: "mol-test" },
    formulaDetail: {
      kind: "available",
      name: "mol-test",
      target: "racoon-city/codex",
    },
    executionPath: { kind: "unavailable", reason: "missing_cwd_and_rig_root" },
    snapshotVersion: 1,
    snapshotEventSeq: { kind: "known", seq: 1 },
    completeness: { kind: "complete" },
    progress: {
      snapshotVersion: 1,
      snapshotEventSeq: { kind: "known", seq: 1 },
      snapshotPartial: false,
      totalNodeCount: 0,
      visibleNodeCount: 0,
      edgeCount: 0,
      executionInstanceCount: 0,
      sessionLinkCount: 0,
      streamableSessionCount: 0,
      streamableSessionIds: [],
      statusCounts: {},
      allStatusCounts: {},
    },
    nodes: [],
    edges: [],
    lanes: [],
  };
}
