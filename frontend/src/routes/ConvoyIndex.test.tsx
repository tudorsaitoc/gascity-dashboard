import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ConvoyRootsLoad, ConvoyRootSummary } from '../supervisor/convoyReads';
import { ConvoyIndex } from './ConvoyIndex';

const mockLoadActiveConvoyRoots = vi.hoisted(() => vi.fn());
vi.mock('../supervisor/convoyReads', () => ({
  loadActiveConvoyRoots: mockLoadActiveConvoyRoots,
}));

const mockLoad = mockLoadActiveConvoyRoots as Mock;

function root(overrides: Partial<ConvoyRootSummary> = {}): ConvoyRootSummary {
  return {
    rootBeadId: 'gc-root-1',
    title: 'root bead 1',
    status: 'in_progress',
    formulaName: 'mol-focus-review',
    formulaNameProvenance: 'metadata',
    ...overrides,
  };
}

function renderIndex() {
  return render(
    <MemoryRouter
      initialEntries={['/convoy']}
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
    >
      <ConvoyIndex />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  mockLoad.mockReset();
});

describe('ConvoyIndex', () => {
  it('shows a loading line while the bounded scan is in flight', () => {
    // A pending promise keeps the hook in its loading state.
    mockLoad.mockReturnValue(new Promise<ConvoyRootsLoad>(() => {}));
    renderIndex();
    expect(screen.getByText('Loading convoys.')).toBeTruthy();
  });

  it('lists each active convoy root as a row linking to its detail page', async () => {
    mockLoad.mockResolvedValue({
      partial: false,
      roots: [
        root({ rootBeadId: 'gc-root-1', formulaName: 'mol-focus-review', status: 'in_progress' }),
        root({ rootBeadId: 'gc-root-2', formulaName: 'mol-pr-iterate', status: 'blocked' }),
      ],
    } satisfies ConvoyRootsLoad);
    renderIndex();

    const first = await screen.findByRole('link', { name: 'mol-focus-review' });
    expect(first.getAttribute('href')).toBe('/convoy/gc-root-1');
    const second = screen.getByRole('link', { name: 'mol-pr-iterate' });
    expect(second.getAttribute('href')).toBe('/convoy/gc-root-2');
    // Status reads as a word (greyscale-safe), not by color alone.
    expect(screen.getByText('in progress')).toBeTruthy();
    expect(screen.getByText('blocked')).toBeTruthy();
    // Synopsis counts the active convoys.
    expect(screen.getByText('2 active convoys.')).toBeTruthy();
  });

  it('surfaces a title-inferred formula name honestly', async () => {
    mockLoad.mockResolvedValue({
      partial: false,
      roots: [root({ formulaName: 'mol-smoke', formulaNameProvenance: 'title_fallback' })],
    } satisfies ConvoyRootsLoad);
    renderIndex();

    expect(await screen.findByText('name inferred from bead title')).toBeTruthy();
  });

  it('renders the calm empty state when no convoys are active', async () => {
    mockLoad.mockResolvedValue({ partial: false, roots: [] } satisfies ConvoyRootsLoad);
    renderIndex();

    expect(await screen.findByText('No active convoys.')).toBeTruthy();
  });

  it('shows the partial-truncation notice when the city scan was truncated', async () => {
    mockLoad.mockResolvedValue({
      partial: true,
      roots: [root()],
    } satisfies ConvoyRootsLoad);
    renderIndex();

    // The row still renders; the notice warns the list may be incomplete.
    expect(await screen.findByRole('link', { name: 'mol-focus-review' })).toBeTruthy();
    expect(screen.getByText(/Partial list: the city bead read was truncated/)).toBeTruthy();
  });

  it('renders an error line when the scan fails', async () => {
    mockLoad.mockRejectedValue(new Error('supervisor unreachable'));
    renderIndex();

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/supervisor unreachable/)).toBeTruthy();
  });
});
