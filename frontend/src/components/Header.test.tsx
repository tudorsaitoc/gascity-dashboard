import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttentionProvider } from '../attention/context';
import { NowProvider } from '../contexts/NowContext';
import { ThemeProvider } from '../contexts/ThemeContext';
import { ViewingAsProvider } from '../contexts/ViewingAsContext';
import { Header } from './Header';

vi.mock('../api/client', () => ({
  api: {
    config: vi.fn(async () => ({
      cityName: 'test-city',
      defaultView: null,
      enabledModules: [],
      readOnly: false,
    })),
  },
}));

vi.mock('../supervisor/client', () => ({
  supervisorApi: () => ({
    listCities: vi.fn(async () => ({
      items: [{ name: 'test-city', path: '/srv/test-city', running: true }],
      total: 1,
    })),
  }),
}));

vi.mock('../runs/runSummarySubscription', () => ({
  useRunSummary: () => ({ sseState: 'open' }),
}));

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: false,
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
});

function renderHeader() {
  return render(
    <ThemeProvider>
      <ViewingAsProvider>
        <NowProvider>
          <AttentionProvider contributors={[]}>
            <MemoryRouter
              initialEntries={['/runs']}
              future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
            >
              <Header />
            </MemoryRouter>
          </AttentionProvider>
        </NowProvider>
      </ViewingAsProvider>
    </ThemeProvider>,
  );
}

describe('Header mobile nav', () => {
  it('keeps the inline nav row but hides it below sm (desktop unchanged)', () => {
    const { container } = renderHeader();
    // The desktop row is the ul that becomes a flex row at sm:; on phones it is
    // hidden in favor of the hamburger menu.
    const desktopList = container.querySelector('ul.sm\\:flex');
    expect(desktopList).not.toBeNull();
    expect(desktopList?.className).toContain('hidden');
  });

  it('exposes a hamburger button that is hidden from sm: up', () => {
    renderHeader();
    const button = screen.getByRole('button', { name: /menu/i });
    expect(button.className).toContain('sm:hidden');
    // Closed by default — no dialog yet.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the nav menu with every route when the hamburger is tapped', () => {
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: /menu/i }));
    const dialog = within(screen.getByRole('dialog'));
    // Scope to the dialog: the desktop row keeps its own copy of each link.
    for (const label of ['Home', 'Agents', 'Beads', 'Runs', 'Mail']) {
      expect(dialog.getByRole('link', { name: new RegExp(label) })).toBeTruthy();
    }
  });

  it('closes the menu when a route is selected', () => {
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: /menu/i }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.click(dialog.getByRole('link', { name: /Agents/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
