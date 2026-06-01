import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GC_MUTATION_HEADERS,
  resetSupervisorApiForTests,
  setSupervisorApiForTests,
  type SupervisorApi,
} from './client';
import { closeSupervisorBead, nudgeSupervisorAgent } from './beadWrites';

const baseApi: SupervisorApi = {
  baseUrl: '/gc-supervisor',
  health: vi.fn(),
  cityHealth: vi.fn(),
  listCities: vi.fn(),
  listAgents: vi.fn(),
  listBeads: vi.fn(),
  listEvents: vi.fn(),
  getBead: vi.fn(),
  createBead: vi.fn(),
  updateBead: vi.fn(),
  closeBead: vi.fn(),
  nudgeAgent: vi.fn(),
  agentPrime: vi.fn(),
  sling: vi.fn(),
  formulaFeed: vi.fn(),
  listMail: vi.fn(),
  markMailRead: vi.fn(),
  markMailUnread: vi.fn(),
  archiveMail: vi.fn(),
  replyMail: vi.fn(),
  sendMail: vi.fn(),
  mailThread: vi.fn(),
  cityEventStreamUrl: vi.fn(),
  sessionStreamUrl: vi.fn(),
  listSessions: vi.fn(),
  sessionPending: vi.fn(),
  respondSession: vi.fn(),
  sessionTranscript: vi.fn(),
  workflowRun: vi.fn(),
  formulaDetail: vi.fn(),
  mutationHeaders: () => ({ ...GC_MUTATION_HEADERS }),
};

describe('supervisor bead writes', () => {
  afterEach(() => {
    resetSupervisorApiForTests();
  });

  it('closes a bead directly through the supervisor API with a trimmed reason', async () => {
    const closeBead = vi.fn(async () => ({ status: 'closed' }));
    setSupervisorApiForTests({ ...baseApi, closeBead });

    await closeSupervisorBead('td-bead-abc123', '  operator verified duplicate  ');

    expect(closeBead).toHaveBeenCalledWith('test-city', 'td-bead-abc123', {
      reason: 'operator verified duplicate',
    });
  });

  it('omits the optional close body when the reason is blank', async () => {
    const closeBead = vi.fn(async () => ({ status: 'closed' }));
    setSupervisorApiForTests({ ...baseApi, closeBead });

    await closeSupervisorBead('td-bead-abc123', '   ');

    expect(closeBead).toHaveBeenCalledWith('test-city', 'td-bead-abc123', undefined);
  });

  it('nudges an agent directly through the supervisor API with a trimmed alias', async () => {
    const nudgeAgent = vi.fn(async () => ({ status: 'ok' }));
    setSupervisorApiForTests({ ...baseApi, nudgeAgent });

    await nudgeSupervisorAgent('  mayor  ');

    expect(nudgeAgent).toHaveBeenCalledWith('test-city', 'mayor');
  });
});
