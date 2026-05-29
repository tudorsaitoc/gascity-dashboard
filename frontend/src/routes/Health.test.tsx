import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthPage } from './Health';
import { invalidate } from '../api/cache';
import type {
  DoltNomsTrend,
  SupervisorHealth,
  SystemHealth,
} from 'gas-city-dashboard-shared';

// gascity-dashboard-e0hh: coverage for the absent
// supervisor.city / supervisor.version paths in Health.tsx —
// (a) the warn-toned <Kv> blocks render "not reported by supervisor",
// (b) buildSynopsis omits the "on <city>" locator clause, asserted
//     via rendered DOM rather than by exporting the module-private
//     helper. Mirrors the WorkflowRunDetail.test.tsx fetch-stub pattern.

let currentHealth: SystemHealth = baseHealth();
let currentTrend: DoltNomsTrend = baseTrend();

beforeEach(() => {
  invalidate('health');
  currentHealth = baseHealth();
  currentTrend = baseTrend();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/system/system') {
      return jsonResponse(currentHealth);
    }
    if (url === '/api/dolt-noms/trend') {
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
    currentHealth = withSupervisor(absentLocator());

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
    currentHealth = withSupervisor(absentLocator());

    renderPage();
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
    currentHealth = withSupervisor(presentLocator());

    const { container } = renderPage();
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
});

function renderPage() {
  return render(
    <MemoryRouter
      initialEntries={['/health']}
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
    >
      <HealthPage />
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

function withSupervisor(supervisor: SupervisorHealth): SystemHealth {
  return {
    ...baseHealth(),
    supervisor: { status: 'available', data: supervisor },
  };
}

function presentLocator(): SupervisorHealth {
  return {
    status: 'ok',
    city: 'racoon-city',
    version: '1.4.2',
    uptime_sec: 4200,
  };
}

function absentLocator(): SupervisorHealth {
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
    supervisor: {
      status: 'available',
      data: presentLocator(),
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
