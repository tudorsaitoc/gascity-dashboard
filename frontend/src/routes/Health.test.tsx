import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthPage } from './Health';
import { invalidate } from '../api/cache';
import { AttentionProvider } from '../attention/context';
import {
  createAttentionContributors,
  type HealthAttentionFacts,
} from '../attention/registry';
import type { HealthOutputBody } from '../generated/gc-supervisor-client/types.gen';
import type {
  DoltNomsTrend,
  SystemHealth,
} from 'gas-city-dashboard-shared';

const mockCityHealth = vi.fn<() => Promise<HealthOutputBody>>();

vi.mock('../supervisor/client', () => ({
  supervisorApi: () => ({
    cityHealth: mockCityHealth,
  }),
}));

// gascity-dashboard-e0hh: coverage for the absent supervisor.city /
// supervisor.version paths in Health.tsx —
// (a) the warn-toned <Kv> blocks render "not reported by supervisor",
// (b) buildSynopsis omits the "on <city>" locator clause, asserted
//     via rendered DOM rather than by exporting the module-private
//     helper. Mirrors the WorkflowRunDetail.test.tsx fetch-stub pattern.

let currentHealth: SystemHealth = baseHealth();
let currentTrend: DoltNomsTrend = baseTrend();

beforeEach(() => {
  invalidate('health');
  mockCityHealth.mockReset();
  mockCityHealth.mockResolvedValue(presentLocator());
  currentHealth = baseHealth();
  currentTrend = baseTrend();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/health/system') {
      return jsonResponse(currentHealth);
    }
    if (url === '/api/city/test-city/dolt-noms/trend') {
      return jsonResponse(currentTrend);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('HealthPage', () => {
  it('renders warn-toned "not reported by supervisor" for absent city and version', async () => {
    mockCityHealth.mockResolvedValue(absentLocator());

    const { container } = renderPage();
    await screen.findByRole('heading', { name: /^health$/i });
    await screen.findByRole('heading', { name: /supervisor/i });

    const cityValue = valueFor(container, 'City');
    const versionValue = valueFor(container, 'Version');

    expect(cityValue?.textContent).toBe('not reported by supervisor');
    expect(versionValue?.textContent).toBe('not reported by supervisor');
    expect(cityValue?.className).toMatch(/text-warn/);
    expect(versionValue?.className).toMatch(/text-warn/);
  });

  it('omits the "on <city>" locator clause from the synopsis when city is absent', async () => {
    mockCityHealth.mockResolvedValue(absentLocator());

    renderPage();
    // Wait for the data-dependent Supervisor section heading before
    // reading the synopsis — the page-title 'Health' heading renders
    // even during the initial loading state, so anchoring on it could
    // race the fetch resolution on slow CI workers.
    await screen.findByRole('heading', { name: /supervisor/i });
    const heading = await screen.findByRole('heading', { name: /^health$/i });
    const synopsis = synopsisFor(heading);

    expect(synopsis).not.toBeNull();
    // Structural assertion: between "Supervisor" and "uptime" there is
    // no " on " locator clause. Coupled to the synopsis shape, not the
    // exact copy.
    expect(synopsis?.textContent ?? '').toMatch(/Supervisor healthy, uptime /);
    expect(synopsis?.textContent ?? '').not.toMatch(/Supervisor healthy on /);
  });

  it('renders city/version without warn tone and includes the locator clause when present', async () => {
    // Positive contrast for the absent-path tests — guards against a
    // false-positive where the warn tone or the dropped clause was
    // applied to every supervisor render path.
    mockCityHealth.mockResolvedValue(presentLocator());

    const { container } = renderPage();
    // Same as the test above: wait for the Supervisor section heading
    // so the data has actually loaded before we query for the City /
    // Version Kvs the assertion reads.
    await screen.findByRole('heading', { name: /supervisor/i });
    const heading = await screen.findByRole('heading', { name: /^health$/i });

    const cityValue = valueFor(container, 'City');
    const versionValue = valueFor(container, 'Version');

    expect(cityValue?.textContent).toBe('racoon-city');
    expect(versionValue?.textContent).toBe('1.4.2');
    expect(cityValue?.className).not.toMatch(/text-warn/);
    expect(versionValue?.className).not.toMatch(/text-warn/);

    const synopsis = synopsisFor(heading);
    // Guard against a vacuous pass: if a future PageHeader refactor
    // restructures the synopsis element, synopsisFor would return null
    // and the positive match below would correctly fail — but assert
    // explicitly so the failure mode is "missing synopsis node" rather
    // than "positive match against an empty string".
    expect(synopsis).not.toBeNull();
    expect(synopsis?.textContent ?? '').toMatch(/Supervisor healthy on racoon-city, uptime /);
  });

  it('uses the generated supervisor client for city health and not the dashboard city health mirror', async () => {
    renderPage();

    await screen.findByRole('heading', { name: /supervisor/i });

    expect(mockCityHealth).toHaveBeenCalledWith('test-city');
    expect(fetch).toHaveBeenCalledWith('/api/health/system', expect.any(Object));
    expect(fetch).not.toHaveBeenCalledWith('/api/city/test-city/health/system', expect.any(Object));
  });

  it('keeps dashboard-local host health visible when direct supervisor health fails', async () => {
    mockCityHealth.mockRejectedValue(new Error('supervisor unavailable'));

    renderPage();

    await screen.findByRole('heading', { name: /host/i });
    expect(screen.getByText('Supervisor not reachable. The dashboard shell stays up; live data is stale.')).toBeTruthy();
    expect(screen.getByText('8')).toBeTruthy();
  });

  it('highlights Health sections that match composed attention facts', async () => {
    const supervisor = absentLocator();
    mockCityHealth.mockResolvedValue(supervisor);
    currentHealth = {
      ...baseHealth(),
      host: {
        ...baseHealth().host,
        free_mem_bytes: 400_000_000,
      },
    };
    currentTrend = {
      available: false,
      reason: 'sample_failed',
      samples: [],
    };

    renderPage({
      attention: {
        system: currentHealth,
        supervisor: { status: 'available', data: supervisor },
        trend: currentTrend,
      },
    });

    await screen.findByRole('heading', { name: /dolt-noms/i });

    expect(sectionFor('Supervisor')?.getAttribute('data-attention-severity')).toBe('watch');
    expect(sectionFor('Host')?.getAttribute('data-attention-severity')).toBe('attention');
    expect(sectionFor('Dolt-noms · 24 h')?.getAttribute('data-attention-severity')).toBe('watch');
  });
});

function renderPage({ attention }: { attention?: HealthAttentionFacts } = {}) {
  const contributors = createAttentionContributors(
    attention === undefined ? {} : { health: attention },
  );
  return render(
    <MemoryRouter
      initialEntries={['/health']}
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
    >
      <AttentionProvider contributors={contributors}>
        <HealthPage />
      </AttentionProvider>
    </MemoryRouter>,
  );
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function valueFor(container: HTMLElement, label: string): HTMLElement | null {
  const terms = Array.from(container.querySelectorAll('dt')).filter(
    (dt) => dt.textContent?.trim() === label,
  );
  if (terms.length !== 1) return null;
  return terms[0]?.nextElementSibling as HTMLElement | null;
}

function synopsisFor(heading: HTMLElement): HTMLElement | null {
  // PageHeader renders the synopsis as a sibling of the heading inside
  // a shared header element. Walk up to the nearest <header>, then look
  // for a paragraph descendant. Specific to PageHeader's structure but
  // stable — the alternative (text search) would over-couple to copy.
  const header = heading.closest('header');
  return header?.querySelector('p') ?? null;
}

function sectionFor(heading: string): HTMLElement | null {
  return screen.getByRole('heading', { name: heading }).closest('section');
}

function presentLocator(): HealthOutputBody {
  return {
    status: 'ok',
    city: 'racoon-city',
    version: '1.4.2',
    uptime_sec: 4200,
  };
}

function absentLocator(): HealthOutputBody {
  // The two fields under test are deliberately omitted, not set to
  // undefined or null — that mirrors what a wire-drifted supervisor
  // payload actually looks like over JSON.
  return {
    status: 'ok',
    uptime_sec: 4200,
  };
}

function baseHealth(): SystemHealth {
  return {
    admin: {
      pid: 4242,
      uptime_sec: 600,
      rss_bytes: 50_000_000,
      heap_used_bytes: 30_000_000,
      node_version: 'v20.10.0',
    },
    host: {
      load_avg_1: 0.42,
      load_avg_5: 0.55,
      load_avg_15: 0.61,
      total_mem_bytes: 16_000_000_000,
      free_mem_bytes: 8_000_000_000,
      cpu_count: 8,
      uptime_sec: 86_400,
    },
  };
}

function baseTrend(): DoltNomsTrend {
  return {
    available: true,
    samples: [],
    source: '/var/gc/.dolt/noms',
  };
}
