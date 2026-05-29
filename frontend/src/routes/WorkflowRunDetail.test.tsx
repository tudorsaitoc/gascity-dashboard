import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowRunDetailPage } from './WorkflowRunDetail';
import { invalidate } from '../api/cache';
import {
  GC_EVENT_PREFIX,
  type TranscriptResult,
  type TranscriptTurn,
  type WorkflowDiffResponse,
  type WorkflowRunDetail,
  type WorkflowScopeKind,
} from 'gas-city-dashboard-shared';
import rawWorkflowRunDetailFixture from '../test/fixtures/workflow-run-detail.json';

const eventSources: FakeEventSource[] = [];

interface WorkflowRunDetailFixture {
  detail: WorkflowRunDetail;
  diff: WorkflowDiffResponse;
  transcripts: Record<string, TranscriptResult>;
  streamTurns: Record<string, TranscriptTurn[]>;
}

const workflowRunDetailFixture = parseWorkflowRunDetailFixture(
  rawWorkflowRunDetailFixture,
);
const detail = workflowRunDetailFixture.detail;
const diff = workflowRunDetailFixture.diff;
const transcripts = workflowRunDetailFixture.transcripts;
const reviewPipelineName = /multi-model review pipeline/i;
const applyFixesName = /apply review fixes/i;
const fetchUrls: string[] = [];
let currentDetail: WorkflowRunDetail = detail;
let currentDiff: WorkflowDiffResponse = diff;

beforeEach(() => {
  eventSources.length = 0;
  fetchUrls.length = 0;
  invalidate('workflow-run');
  currentDetail = detail;
  currentDiff = diff;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchUrls.push(url);
    if (url.startsWith('/api/workflows/gc-adopt-pr-active/diff')) {
      return jsonResponse(currentDiff);
    }
    if (url.startsWith('/api/workflows/gc-adopt-pr-active')) {
      return jsonResponse(currentDetail);
    }
    if (url === '/api/sessions/gc-session-review-i2/peek') {
      expect(init?.method).toBe('POST');
      return jsonResponse(transcripts['gc-session-review-i2']);
    }
    if (url === '/api/sessions/gc-session-rebase/peek') {
      return jsonResponse(transcripts['gc-session-rebase']);
    }
    if (url === '/api/sessions/gc-session-rebase-a1/peek') {
      return jsonResponse(transcripts['gc-session-rebase']);
    }
    if (url === '/api/sessions/gc-session-rebase-a2/peek') {
      return jsonResponse(transcripts['gc-session-rebase']);
    }
    if (url === '/api/sessions/gc-session-review-i1/peek') {
      return jsonResponse(transcripts['gc-session-review-i1']);
    }
    if (url === '/api/sessions/gc-session-fix-i1/peek') {
      return jsonResponse(transcripts['gc-session-fix-i1']);
    }
    if (url.startsWith('/api/links/')) {
      // RelatedEntities (gascity-dashboard-j4x) fetches its view on mount.
      // A focus-only view keeps this test scoped to the run-detail flow.
      const ref = decodeURIComponent(url.slice('/api/links/'.length));
      return jsonResponse({
        focus: { key: `bead:c:${ref}`, type: 'bead', ref },
        nodes: [{ key: `bead:c:${ref}`, type: 'bead', ref, title: null, status: null, url: null, fetchedAt: null, unresolved: false }],
        edges: [],
        stats: [],
        partial: false,
        generatedAt: '2026-05-25T00:00:00.000Z',
        asOf: null,
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WorkflowRunDetailPage', () => {
  it('starts with no selected node and toggles exactly one selected node', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /adopt pr #42/i });
    expect(screen.getByText(/3 running, 1 done, 1 ready, 1 skipped/i)).toBeTruthy();
    expect(screen.getByText(/v11 · seq 91/i)).toBeTruthy();
    expect(screen.getByRole('tab', { name: /diff/i }).getAttribute('aria-controls')).toBe(
      'workflow-evidence-panel',
    );
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(
      'workflow-evidence-tab-diff',
    );
    expect(nodePressed(reviewPipelineName)).toBe('false');
    expect(nodePressed(applyFixesName)).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: reviewPipelineName }));
    expect(nodePressed(reviewPipelineName)).toBe('true');
    await screen.findByText(/checking graph\.v2 node grouping/i);
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(
      'workflow-evidence-tab-session',
    );

    fireEvent.click(screen.getByRole('button', { name: applyFixesName }));
    expect(nodePressed(reviewPipelineName)).toBe('false');
    expect(nodePressed(applyFixesName)).toBe('true');
    await screen.findByText(/apply the iteration 1 review fixes/i);

    fireEvent.click(screen.getByRole('button', { name: applyFixesName }));
    expect(nodePressed(applyFixesName)).toBe('false');
    expect(screen.getByText(/select a node/i)).toBeTruthy();
  });

  it('renders the backend running-formula progress summary instead of deriving it in React', async () => {
    currentDetail = {
      ...detail,
      progress: {
        ...detail.progress,
        visibleNodeCount: 99,
        edgeCount: 88,
        statusCounts: { pending: 99 },
      },
    };

    renderPage();
    await screen.findByRole('heading', { name: /adopt pr #42/i });

    expect(screen.getByText(/99 nodes, 88 edges\. 99 pending/i)).toBeTruthy();
  });

  it('clears query-driven selection when the node query is removed', async () => {
    renderPage('/workflows/gc-adopt-pr-active?node=review-pipeline', true);
    await screen.findByRole('heading', { name: /adopt pr #42/i });
    await waitFor(() => expect(nodePressed(reviewPipelineName)).toBe('true'));

    fireEvent.click(screen.getByRole('button', { name: /clear node query/i }));

    await waitFor(() => expect(nodePressed(reviewPipelineName)).toBe('false'));
    expect(screen.getByText(/select a node/i)).toBeTruthy();
  });

  it('applies query-driven selection when refresh materializes the requested node', async () => {
    currentDetail = withoutNode(detail, 'review-pipeline');
    renderPage('/workflows/gc-adopt-pr-active?node=review-pipeline');
    await screen.findByRole('heading', { name: /adopt pr #42/i });
    expect(screen.queryByRole('button', { name: reviewPipelineName })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /session/i }));
    expect(screen.getByText(/select a node/i)).toBeTruthy();

    currentDetail = detail;
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => expect(nodePressed(reviewPipelineName)).toBe('true'));
    await screen.findByText(/checking graph\.v2 node grouping/i);
  });

  it('refreshes the whole run projection when matching city events arrive', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /adopt pr #42/i });
    const cityStream = requireCityEventSource();

    currentDetail = {
      ...detail,
      title: 'Adopt PR #42 refreshed',
      snapshotVersion: 12,
      snapshotEventSeq: { kind: 'known', seq: 92 },
    };
    cityStream.dispatch('event', { type: `${GC_EVENT_PREFIX.bead}updated` });

    await screen.findByRole('heading', { name: /adopt pr #42 refreshed/i });
    expect(screen.getByText(/v12 · seq 92/i)).toBeTruthy();
  });

  it('rejects a half-specified scope query without loading the workflow', async () => {
    // Only scope_kind, no scope_ref. The backend rejects this as a 400, so the
    // frontend must fail closed too — silently dropping the scope would load the
    // WRONG (default city) run for a truncated deep link.
    renderPage('/workflows/gc-adopt-pr-active?scope_kind=city');

    await screen.findByRole('alert');
    expect(screen.getByText(/invalid workflow scope query/i)).toBeTruthy();
    expect(fetchUrls.some((url) => url.startsWith('/api/workflows/'))).toBe(false);
  });

  it('passes complete scope query params when loading detail and diff', async () => {
    renderPage('/workflows/gc-adopt-pr-active?scope_kind=city&scope_ref=racoon-city');
    await screen.findByRole('heading', { name: /adopt pr #42/i });

    const workflowUrls = fetchUrls.filter((url) => url.startsWith('/api/workflows/'));
    expect(workflowUrls).toContain(
      '/api/workflows/gc-adopt-pr-active?scope_kind=city&scope_ref=racoon-city',
    );
    expect(workflowUrls).toContain(
      '/api/workflows/gc-adopt-pr-active/diff?scope_kind=city&scope_ref=racoon-city',
    );
  });

  it('surfaces malformed complete scope query params without loading the workflow', async () => {
    renderPage('/workflows/gc-adopt-pr-active?scope_kind=workspace&scope_ref=racoon-city');

    await screen.findByRole('alert');
    expect(screen.getByText(/invalid workflow scope query/i)).toBeTruthy();
    expect(fetchUrls.some((url) => url.startsWith('/api/workflows/'))).toBe(false);
  });

  it('rejects duplicated scope query params without loading the workflow', async () => {
    renderPage('/workflows/gc-adopt-pr-active?scope_kind=city&scope_kind=rig&scope_ref=racoon-city');

    await screen.findByRole('alert');
    expect(screen.getByText(/invalid workflow scope query/i)).toBeTruthy();
    expect(fetchUrls.some((url) => url.startsWith('/api/workflows/'))).toBe(false);
  });

  it('shows loop iteration history in the session panel for a selected semantic node', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /adopt pr #42/i });
    fireEvent.click(screen.getByRole('button', { name: reviewPipelineName }));
    await screen.findByText(/checking graph\.v2 node grouping/i);

    fireEvent.click(screen.getByRole('radio', { name: /iteration 1/i }));
    await screen.findByText(/found two issues/i);
    expect(screen.getByText(/historical/i)).toBeTruthy();
  });

  it('keeps historical-only loop transcripts available without adding left-graph nodes', async () => {
    renderPage('/workflows/gc-adopt-pr-active?node=old-only-review');
    await screen.findByRole('heading', { name: /adopt pr #42/i });

    expect(screen.queryByRole('button', { name: /old-only review/i })).toBeNull();
    await screen.findByText(/historical-only/i);
    await screen.findByText(/found two issues/i);
    expect(requireCityEventSource()).toBeTruthy();
    expect(sessionEventSources()).toHaveLength(0);
  });

  it('streams named turn events for an active selected node', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /adopt pr #42/i });
    fireEvent.click(screen.getByRole('button', { name: reviewPipelineName }));
    await screen.findByText(/checking graph\.v2 node grouping/i);
    await screen.findByText(/command: node --import tsx --test/i);
    await screen.findByText(/stdout: 5 graph\.v2 enrichment tests passed/i);
    expect(screen.getByText(/^tool use$/i)).toBeTruthy();
    expect(screen.getByText(/^tool result$/i)).toBeTruthy();
    expect(screen.getByText(/^final$/i)).toBeTruthy();

    await waitFor(() => expect(sessionEventSources()).toHaveLength(1));
    const stream = sessionEventSources()[0];
    stream?.open();
    await screen.findByText(/^live$/i);

    stream?.dispatch('turn', {
      role: 'assistant',
      text: 'streaming progress on iteration 2',
    });

    await screen.findByText(/streaming progress on iteration 2/i);

    stream?.fail(FakeEventSource.CONNECTING);
    stream?.dispatch('turn', {
      role: 'assistant',
      text: 'stream kept its listener after a transient error',
    });

    await screen.findByText(/stream kept its listener after a transient error/i);
  });

  it('streams supervisor transcript snapshot events for an active selected node', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /adopt pr #42/i });
    fireEvent.click(screen.getByRole('button', { name: reviewPipelineName }));
    await screen.findByText(/checking graph\.v2 node grouping/i);
    await waitFor(() => expect(sessionEventSources()).toHaveLength(1));

    const stream = sessionEventSources()[0];
    stream?.open();
    await screen.findByText(/^live$/i);
    stream?.dispatch('turn', {
      session_id: 'gc-session-review-i2',
      template: 'workflows.codex',
      provider: 'codex',
      format: 'conversation',
      turns: [
        {
          role: 'assistant',
          text: 'supervisor snapshot event replaced the active transcript',
        },
      ],
      total_chars: 55,
      captured_at: '2026-01-01T00:00:00.000Z',
      truncated: false,
    });

    await screen.findByText(/supervisor snapshot event replaced the active transcript/i);
  });

  it('closes the active session stream when selection changes or the Session tab is hidden', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /adopt pr #42/i });
    fireEvent.click(screen.getByRole('button', { name: reviewPipelineName }));
    await screen.findByText(/checking graph\.v2 node grouping/i);
    await waitFor(() => expect(sessionEventSources()).toHaveLength(1));
    const firstStream = sessionEventSources()[0];
    expect(firstStream?.closed).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: applyFixesName }));
    await screen.findByText(/apply the iteration 1 review fixes/i);
    await waitFor(() => expect(firstStream?.closed).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: reviewPipelineName }));
    await screen.findByText(/checking graph\.v2 node grouping/i);
    await waitFor(() => expect(sessionEventSources()).toHaveLength(2));
    const secondStream = sessionEventSources()[1];
    expect(secondStream?.closed).toBe(false);

    fireEvent.click(screen.getByRole('tab', { name: /diff/i }));
    await screen.findByRole('heading', { name: /current working tree/i });
    await waitFor(() => expect(secondStream?.closed).toBe(true));
  });

  it('keeps the Session tab available so a selected node can explain unresolved sessions', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /adopt pr #42/i });
    expect((screen.getByRole('tab', { name: /session/i }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /pre-approval ci repair loop/i }));

    await screen.findByText(/session unresolved for this node/i);
    const sessionTab = screen.getByRole('tab', { name: /session/i }) as HTMLButtonElement;
    expect(sessionTab.disabled).toBe(false);
    expect(sessionTab.getAttribute('aria-disabled')).toBeNull();
  });

  it('renders the current execution-folder diff with prefix-based line classes', async () => {
    const { container } = renderPage();
    await screen.findByRole('heading', { name: /adopt pr #42/i });
    expect(screen.getByRole('heading', { name: /current working tree/i })).toBeTruthy();
    await screen.findByText('+preserve failed attempt transcript links');
    expect(container.querySelector('.diff-line-add')?.textContent).toContain('+preserve failed');
    expect(container.querySelector('.diff-line-remove')?.textContent).toContain('-old session');
    expect(container.querySelector('.diff-line-hunk')?.textContent).toContain('@@');
  });

  it('surfaces a partial workflow snapshot on the detail page', async () => {
    currentDetail = {
      ...detail,
      completeness: {
        kind: 'partial',
        reasons: ['supervisor_snapshot_partial'],
      },
    };
    renderPage();

    await screen.findByRole('heading', { name: /adopt pr #42/i });
    expect(screen.getByText(/partial workflow data/i)).toBeTruthy();
  });

  it('shows no-graph and selected-node-without-session empty states', async () => {
    currentDetail = {
      ...detail,
      nodes: detail.nodes.filter((node) => node.id === 'old-only-review').map((node) => ({
        ...node,
        visibleInGraph: false,
        historicalOnly: true,
      })),
      lanes: [],
      edges: [],
    };
    renderPage();

    await screen.findByRole('heading', { name: /adopt pr #42/i });
    expect(screen.getByText(/no graph nodes have materialized/i)).toBeTruthy();

    currentDetail = detail;
    cleanup();
    invalidate('workflow-run');
    renderPage();
    await screen.findByRole('heading', { name: /adopt pr #42/i });
    fireEvent.click(screen.getByRole('button', { name: /pre-approval ci repair loop/i }));
    expect(screen.getByText(/session unresolved for this node/i)).toBeTruthy();
  });

  it('shows retry attempt tabs for multiple attempts in the selected execution context', async () => {
    currentDetail = detailWithRebaseAttempts();
    renderPage();
    await screen.findByRole('heading', { name: /adopt pr #42/i });

    fireEvent.click(screen.getByRole('button', { name: /rebase and local validation/i }));

    expect(screen.getByRole('radio', { name: /attempt 1/i })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /attempt 2/i })).toBeTruthy();
    await screen.findByText(/rebased cleanly/i);
  });
});

function renderPage(
  initialEntry = '/workflows/gc-adopt-pr-active',
  includeRouteControls = false,
) {
  return render(
    <MemoryRouter
      initialEntries={[initialEntry]}
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
    >
      <Routes>
        <Route
          path="/workflows/:workflowId"
          element={
            <>
              <WorkflowRunDetailPage />
              {includeRouteControls && <RouteControls />}
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

function RouteControls() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate('/workflows/gc-adopt-pr-active')}
    >
      Clear node query
    </button>
  );
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function nodePressed(name: RegExp): string | null {
  return screen.getByRole('button', { name }).getAttribute('aria-pressed');
}

function requireCityEventSource(): FakeEventSource {
  const source = eventSources.find((eventSource) => eventSource.url === '/api/events/stream');
  if (source === undefined) throw new Error('expected city event source');
  return source;
}

function sessionEventSources(): FakeEventSource[] {
  return eventSources.filter((eventSource) => eventSource.url.startsWith('/api/sessions/'));
}

function withoutNode(detailValue: WorkflowRunDetail, nodeId: string): WorkflowRunDetail {
  return {
    ...detailValue,
    nodes: detailValue.nodes.filter((node) => node.id !== nodeId),
    lanes: detailValue.lanes.map((lane) => ({
      ...lane,
      nodeIds: lane.nodeIds.filter((id) => id !== nodeId),
    })),
  };
}

function detailWithRebaseAttempts(): WorkflowRunDetail {
  return {
    ...detail,
    nodes: detail.nodes.map((node) => {
      if (node.id !== 'rebase-check') return node;
      return {
        ...node,
        attemptSummary: {
          kind: 'tracked',
          count: 2,
          badge: { kind: 'bounded', label: '2/3' },
          active: { kind: 'idle' },
        },
        visibleExecutionInstanceId: 'gc-rebase-check-a2',
        executionInstances: [
          {
            id: 'gc-rebase-check-a1',
            semanticNodeId: 'rebase-check',
            beadId: 'gc-rebase-check-a1',
            iteration: { kind: 'base' },
            attempt: { kind: 'attempt', value: 1 },
            label: 'attempt 1',
            status: 'failed',
            session: {
              kind: 'attached',
              streamable: false,
              link: {
                sessionId: 'gc-session-rebase-a1',
                sessionName: 'rebase-attempt-1',
                assignee: 'codex',
              },
            },
            currentIteration: true,
            historical: false,
          },
          {
            id: 'gc-rebase-check-a2',
            semanticNodeId: 'rebase-check',
            beadId: 'gc-rebase-check-a2',
            iteration: { kind: 'base' },
            attempt: { kind: 'attempt', value: 2 },
            label: 'attempt 2',
            status: 'completed',
            session: {
              kind: 'attached',
              streamable: false,
              link: {
                sessionId: 'gc-session-rebase-a2',
                sessionName: 'rebase-attempt-2',
                assignee: 'codex',
              },
            },
            currentIteration: true,
            historical: false,
          },
        ],
      };
    }),
  };
}

function parseWorkflowRunDetailFixture(raw: unknown): WorkflowRunDetailFixture {
  if (!isRecord(raw)) throw new Error('workflow detail fixture must be an object');
  if (!isRecord(raw.detail)) throw new Error('workflow detail fixture missing detail');
  if (!isWorkflowScopeKind(raw.detail.scopeKind)) {
    throw new Error('workflow detail fixture has invalid scopeKind');
  }
  if (!Array.isArray(raw.detail.nodes)) {
    throw new Error('workflow detail fixture missing detail.nodes');
  }
  if (!Array.isArray(raw.detail.edges)) {
    throw new Error('workflow detail fixture missing detail.edges');
  }
  if (!isRecord(raw.diff)) throw new Error('workflow detail fixture missing diff');
  if (!isRecord(raw.transcripts)) {
    throw new Error('workflow detail fixture missing transcripts');
  }
  if (!isRecord(raw.streamTurns)) {
    throw new Error('workflow detail fixture missing streamTurns');
  }
  return raw as unknown as WorkflowRunDetailFixture;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWorkflowScopeKind(value: unknown): value is WorkflowScopeKind {
  return value === 'city' || value === 'rig';
}

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly url: string;
  readonly withCredentials: boolean;
  readyState = FakeEventSource.CONNECTING;
  closed = false;
  readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();

  constructor(url: string | URL, init?: EventSourceInit) {
    this.url = String(url);
    this.withCredentials = init?.withCredentials ?? false;
    eventSources.push(this);
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.(new Event('open'));
  }

  fail(readyState = FakeEventSource.CLOSED): void {
    this.readyState = readyState;
    this.onerror?.(new Event('error'));
  }

  addEventListener(
    type: string,
    listener: ((event: MessageEvent<string>) => void) | null,
  ): void {
    if (!listener) return;
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(
    type: string,
    listener: ((event: MessageEvent<string>) => void) | null,
  ): void {
    if (!listener) return;
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener),
    );
  }

  dispatch(type: string, payload: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(payload) });
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
    if (type === 'message') {
      this.onmessage?.(event);
    }
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.closed = true;
    this.listeners.clear();
  }
}
