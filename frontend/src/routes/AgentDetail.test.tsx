import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { api } from '../api/client';
import { reportClientError } from '../lib/clientErrorReporting';
import { AgentDetailPage } from './AgentDetail';

vi.mock('../api/client', () => ({
  api: {
    listSessions: vi.fn(),
    listBeads: vi.fn(),
    listMail: vi.fn(),
    agentPrime: vi.fn(),
  },
  ApiClientError: class extends Error {
    status: number;
    kind: string | undefined;
    constructor(status: number, message: string, kind?: string) {
      super(message);
      this.status = status;
      this.kind = kind;
    }
  },
}));

vi.mock('../contexts/ViewingAsContext', () => ({
  useViewingAs: () => ({
    viewingAs: { alias: 'stephanie', isOperator: true },
  }),
}));

vi.mock('../hooks/useEntityLinks', () => ({
  useEntityLinks: () => ({
    links: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock('../hooks/useGcEvents', () => ({
  useGcEventRefresh: vi.fn(),
}));

vi.mock('../hooks/useVisibleInterval', () => ({
  useVisibleInterval: vi.fn(),
}));

vi.mock('../lib/clientErrorReporting', () => ({
  reportClientError: vi.fn(),
}));

const mockListSessions = api.listSessions as Mock;
const mockListBeads = api.listBeads as Mock;
const mockListMail = api.listMail as Mock;
const mockAgentPrime = api.agentPrime as Mock;
const mockReportClientError = reportClientError as Mock;

describe('AgentDetailPage error reporting', () => {
  beforeEach(() => {
    mockListSessions.mockResolvedValue({ items: [] });
    mockListBeads.mockRejectedValue(new Error('beads unavailable'));
    mockListMail.mockResolvedValue({ items: [] });
    mockAgentPrime.mockResolvedValue({ prompt: '', bytes: 0 });
    mockReportClientError.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('reports assigned-bead refresh failures instead of silently dropping them', async () => {
    render(
      <MemoryRouter
        initialEntries={['/agents/mayor']}
        future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
      >
        <Routes>
          <Route path="/agents/:slug" element={<AgentDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(mockReportClientError).toHaveBeenCalledWith({
        component: 'AgentDetail',
        operation: 'refreshBeads',
        message: 'beads unavailable',
      });
    });
  });
});
