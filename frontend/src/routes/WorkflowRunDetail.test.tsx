import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowRunDetailPage } from './WorkflowRunDetail';
import type {
  WorkflowDiffResponse,
  WorkflowRunDetail,
} from 'gas-city-dashboard-shared';

const eventSources: FakeEventSource[] = [];

const detail: WorkflowRunDetail = {
  workflowId: 'gc-root',
  rootBeadId: 'gc-root',
  rootStoreRef: 'city:racoon-city',
  resolvedRootStore: 'city:racoon-city',
  scopeKind: 'city',
  scopeRef: 'racoon-city',
  title: 'Adopt PR #42',
  formula: 'mol-adopt-pr-v2',
  executionPath: '/tmp/adopt-pr',
  snapshotVersion: 7,
  snapshotEventSeq: 42,
  partial: false,
  nodes: [
    {
      id: 'review-loop',
      semanticNodeId: 'review-loop',
      title: 'Review Loop',
      kind: 'check-loop',
      constructKind: 'check-loop',
      status: 'active',
      visibleIteration: 2,
      iterationCount: 2,
      hasHistoricalIterations: true,
      executionInstances: [
        {
          id: 'gc-loop-1',
          semanticNodeId: 'review-loop',
          beadId: 'gc-loop-1',
          iteration: 2,
          status: 'active',
          currentIteration: true,
        },
      ],
    },
    {
      id: 'review-codex',
      semanticNodeId: 'review-codex',
      title: 'Codex Review',
      kind: 'task',
      constructKind: 'step',
      status: 'active',
      currentBeadId: 'gc-codex-iter2',
      loopControlNodeId: 'review-loop',
      visibleIteration: 2,
      iterationCount: 2,
      hasHistoricalIterations: true,
      visibleExecutionInstanceId: 'gc-codex-iter2',
      executionInstances: [
        {
          id: 'gc-codex-iter1',
          semanticNodeId: 'review-codex',
          beadId: 'gc-codex-iter1',
          iteration: 1,
          attempt: 1,
          status: 'completed',
          sessionLink: {
            sessionId: 'gc-session-a',
            sessionName: 'codex-review-1',
            assignee: 'gc-session-a',
          },
          historical: true,
          currentIteration: false,
          streamable: false,
        },
        {
          id: 'gc-codex-iter2',
          semanticNodeId: 'review-codex',
          beadId: 'gc-codex-iter2',
          iteration: 2,
          attempt: 2,
          status: 'active',
          sessionLink: {
            sessionId: 'gc-session-b',
            sessionName: 'codex-review-2',
            assignee: 'gc-session-b',
          },
          historical: false,
          currentIteration: true,
          streamable: true,
        },
      ],
      controlBadges: [
        { id: 'gc-scope-check', label: 'scope check', status: 'completed' },
      ],
    },
    {
      id: 'apply-fixes',
      semanticNodeId: 'apply-fixes',
      title: 'Apply Fixes',
      kind: 'task',
      constructKind: 'step',
      status: 'pending',
      executionInstances: [
        {
          id: 'gc-apply-fixes',
          semanticNodeId: 'apply-fixes',
          beadId: 'gc-apply-fixes',
          status: 'pending',
          currentIteration: true,
        },
      ],
    },
  ],
  edges: [
    { from: 'review-loop', to: 'review-codex', kind: 'execution' },
    { from: 'review-codex', to: 'apply-fixes', kind: 'execution' },
  ],
  lanes: [{ id: '__workflow', label: 'Workflow', nodeIds: ['review-loop', 'review-codex', 'apply-fixes'] }],
};

const diff: WorkflowDiffResponse = {
  kind: 'ok',
  rootPath: '/tmp/adopt-pr',
  status: [' M src/app.ts'],
  changedFiles: [{ path: 'src/app.ts', status: 'M', kind: 'code' }],
  unstagedDiff: [
    'diff --git a/src/app.ts b/src/app.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    ' context',
  ].join('\n'),
  stagedDiff: '',
  truncated: false,
};

beforeEach(() => {
  eventSources.length = 0;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/workflows/gc-root/diff')) {
      return jsonResponse(diff);
    }
    if (url.startsWith('/api/workflows/gc-root')) {
      return jsonResponse(detail);
    }
    if (url === '/api/sessions/gc-session-b/peek') {
      expect(init?.method).toBe('POST');
      return jsonResponse({
        session_id: 'gc-session-b',
        turns: [{ role: 'assistant', text: 'working on iteration 2' }],
        total_chars: 22,
        captured_at: '2026-05-24T12:00:00Z',
        truncated: false,
      });
    }
    if (url === '/api/sessions/gc-session-a/peek') {
      return jsonResponse({
        session_id: 'gc-session-a',
        turns: [{ role: 'assistant', text: 'finished iteration 1' }],
        total_chars: 20,
        captured_at: '2026-05-24T11:00:00Z',
        truncated: false,
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
    expect(screen.getByRole('button', { name: /codex review/i }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: /apply fixes/i }).getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: /codex review/i }));
    expect(screen.getByRole('button', { name: /codex review/i }).getAttribute('aria-pressed')).toBe('true');
    await screen.findByText(/working on iteration 2/i);

    fireEvent.click(screen.getByRole('button', { name: /apply fixes/i }));
    expect(screen.getByRole('button', { name: /codex review/i }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: /apply fixes/i }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/no session is attached/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /apply fixes/i }));
    expect(screen.getByRole('button', { name: /apply fixes/i }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText(/select a node/i)).toBeTruthy();
  });

  it('shows loop iteration history in the session panel for a selected semantic node', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /adopt pr #42/i });
    fireEvent.click(screen.getByRole('button', { name: /codex review/i }));
    await screen.findByText(/working on iteration 2/i);

    fireEvent.click(screen.getByRole('radio', { name: /iteration 1/i }));
    await screen.findByText(/finished iteration 1/i);
    expect(screen.getByText(/historical/i)).toBeTruthy();
  });

  it('streams named turn events for an active selected node', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /adopt pr #42/i });
    fireEvent.click(screen.getByRole('button', { name: /codex review/i }));
    await screen.findByText(/working on iteration 2/i);

    expect(eventSources).toHaveLength(1);
    eventSources[0]?.dispatch('turn', {
      role: 'assistant',
      text: 'streaming progress on iteration 2',
    });

    await screen.findByText(/streaming progress on iteration 2/i);
  });

  it('renders the current execution-folder diff with prefix-based line classes', async () => {
    const { container } = renderPage();
    await screen.findByRole('heading', { name: /adopt pr #42/i });
    expect(screen.getByRole('heading', { name: /current working tree/i })).toBeTruthy();
    await screen.findByText('+new');
    expect(container.querySelector('.diff-line-add')?.textContent).toContain('+new');
    expect(container.querySelector('.diff-line-remove')?.textContent).toContain('-old');
    expect(container.querySelector('.diff-line-hunk')?.textContent).toContain('@@');
  });
});

function renderPage() {
  return render(
    <MemoryRouter
      initialEntries={['/workflows/gc-root']}
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
    >
      <Routes>
        <Route path="/workflows/:workflowId" element={<WorkflowRunDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

class FakeEventSource {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  readonly withCredentials: boolean;
  readonly readyState = 1;
  readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();

  constructor(url: string | URL, init?: EventSourceInit) {
    this.url = String(url);
    this.withCredentials = init?.withCredentials ?? false;
    eventSources.push(this);
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
    this.listeners.clear();
  }
}
