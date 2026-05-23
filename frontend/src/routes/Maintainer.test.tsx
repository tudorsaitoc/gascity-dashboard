import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { SelectionActionBar } from './Maintainer';

// gascity-dashboard-5ly: render-level assertions for the bulk action bar.
// The success-state lifecycle (timer cleanup, back-to-back slings) is
// covered by the useSlingSuccess hook tests in maintainerSelection.test.ts;
// this file only verifies the action bar's rendered output for each state
// it can be in (selection-only, error, success).

// vitest.config.ts has globals: false, so RTL's auto-cleanup never
// registers. Without this hook, every test would accumulate DOM nodes
// from prior tests and queryByRole would find duplicates.
afterEach(() => {
  cleanup();
});

// Text matcher that handles the success line, which intentionally
// splits the count into its own <span class="tnum"> for tabular figures
// (DESIGN.md). screen.getByText with a plain regex only matches a
// single text node, so we pass a function that normalises the parent
// element's full text content.
function hasNormalisedText(needle: RegExp) {
  return (_content: string, element: Element | null) => {
    if (element === null) return false;
    const normalised = element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    return needle.test(normalised);
  };
}

function renderBar(props: Partial<React.ComponentProps<typeof SelectionActionBar>> = {}) {
  return render(
    <MemoryRouter>
      <SelectionActionBar
        count={props.count ?? 2}
        onSend={props.onSend ?? (() => {})}
        onClear={props.onClear ?? (() => {})}
        sending={props.sending ?? false}
        error={props.error ?? null}
        success={props.success ?? null}
      />
    </MemoryRouter>,
  );
}

describe('SelectionActionBar — success state', () => {
  it('renders the success line with count + target when success is set', () => {
    renderBar({ success: { count: 3, target: 'triage agent' } });
    // Copy from the bead: 'Slung N to <target>. View in Agents →'.
    // The count is split into its own <span> for tabular figures, so
    // we match on the normalised text of the success container.
    const status = screen.getByRole('status');
    expect(status.textContent?.replace(/\s+/g, ' ').trim()).toMatch(
      /^Slung 3 to triage agent\./,
    );
  });

  it('uses the same copy for count=1 (no plural special-case)', () => {
    renderBar({ success: { count: 1, target: 'triage agent' } });
    const status = screen.getByRole('status');
    expect(status.textContent?.replace(/\s+/g, ' ').trim()).toMatch(
      /^Slung 1 to triage agent\./,
    );
  });

  it('renders a link to /agents on the success line', () => {
    renderBar({ success: { count: 2, target: 'triage agent' } });
    const link = screen.getByRole('link', { name: /view in agents/i });
    expect(link.getAttribute('href')).toBe('/agents');
  });

  it('does NOT render the success line when success is null', () => {
    renderBar({ success: null });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(hasNormalisedText(/Slung/))).toBeNull();
  });
});

describe('SelectionActionBar — error path regression', () => {
  it('still renders the error message in the same region', () => {
    renderBar({ error: '2 of 3 failed: gc sling failed (1)' });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/2 of 3 failed/);
  });

  it('does not render the success line while an error is present', () => {
    renderBar({
      error: 'something went wrong',
      success: null,
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders both error and success simultaneously when a partial-failure batch lands', () => {
    renderBar({
      error: '1 of 3 failed: gc sling failed (1)',
      success: { count: 2, target: 'triage agent' },
    });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();
  });
});

describe('SelectionActionBar — selection counter', () => {
  it('shows the count of selected items', () => {
    renderBar({ count: 7 });
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText(/selected/i)).toBeTruthy();
  });

  it('renders Send and Clear controls', () => {
    renderBar();
    expect(screen.getByRole('button', { name: /send to triage agent/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^clear$/i })).toBeTruthy();
  });

  it('suppresses "0 selected" when count=0 and a success line is showing', () => {
    // After a fully successful dispatch the selection is cleared but the
    // success banner stays up until TTL. Don't surface a confusing
    // "0 selected · Slung 3 to triage agent" — the success line stands alone.
    renderBar({ count: 0, success: { count: 3, target: 'triage agent' } });
    expect(screen.queryByText(/selected/i)).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
  });
});
