import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { SelectionActionBar, SlungLink, TriageScore } from './Maintainer';

// gascity-dashboard-5ly: render-level assertions for the bulk action bar.
// The success-state lifecycle (timer cleanup, back-to-back slings) is
// covered by the useSlingSuccess hook tests in maintainerSelection.test.ts;
// this file only verifies the action bar's rendered output for each state
// it can be in (selection-only, error, success).

// vitest.config.ts has globals: false, so RTL's auto-cleanup never
// registers. Each describe block below installs its own afterEach(cleanup)
// so that DOM nodes from prior tests don't accumulate (queryByRole would
// otherwise find duplicates). Co-located rather than module-scope so
// ordering is not load-order-dependent if a future describe ever shares
// mutable DOM state with another.

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
    <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
      <SelectionActionBar
        count={props.count ?? 2}
        onSend={props.onSend ?? (() => {})}
        onSendDraft={props.onSendDraft}
        onClear={props.onClear ?? (() => {})}
        sending={props.sending ?? false}
        error={props.error ?? null}
        success={props.success ?? null}
      />
    </MemoryRouter>,
  );
}

describe('SelectionActionBar — success state', () => {
  afterEach(() => {
    cleanup();
  });

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
  afterEach(() => {
    cleanup();
  });

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

describe('TriageScore — vetted vs heuristic visual distinction', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders nothing when triage_score is null and no assessment', () => {
    const { container } = render(
      <TriageScore item={{ triage_score: null, triage_assessment: null }} />,
    );
    expect(container.textContent).toBe('');
  });

  it('renders heuristic score with t-prefix in faint italic when no assessment', () => {
    const { container } = render(
      <TriageScore item={{ triage_score: 215, triage_assessment: null }} />,
    );
    // 't215' — note the "t" prefix marks heuristic.
    expect(container.textContent).toMatch(/t215/);
    const span = container.querySelector('span.text-fg-faint.italic');
    expect(span).not.toBeNull();
    expect(span?.textContent).toBe('t215');
  });

  it('renders vetted score with check glyph in normal text-fg weight (no italic, no t-prefix)', () => {
    const { container } = render(
      <TriageScore
        item={{
          triage_score: 215,
          triage_assessment: {
            vetted_score: 280,
            source: 'agent',
            notes: '',
            vetted_at: '2026-05-23T00:00:00.000Z',
          },
        }}
      />,
    );
    // Score reads as the vetted_score (not the heuristic), no t-prefix.
    expect(container.textContent).toMatch(/280/);
    expect(container.textContent).not.toMatch(/t280/);
    expect(container.textContent).not.toMatch(/t215/);
    // Check glyph present.
    expect(container.textContent).toMatch(/✓/);
    // Container span is text-fg (normal weight), NOT text-fg-faint, NOT italic.
    const fgSpan = container.querySelector('span.text-fg');
    expect(fgSpan).not.toBeNull();
    expect(container.querySelector('span.italic')).toBeNull();
    expect(container.querySelector('span.text-fg-faint')).toBeNull();
  });

  it('vetted title attribute surfaces source + score for accessibility', () => {
    const { container } = render(
      <TriageScore
        item={{
          triage_score: 100,
          triage_assessment: {
            vetted_score: 340,
            source: 'agent',
            notes: '',
            vetted_at: '2026-05-23T00:00:00.000Z',
          },
        }}
      />,
    );
    const titled = container.querySelector('span[title]');
    expect(titled?.getAttribute('title')).toMatch(/vetted by agent.*340/);
  });
});

describe('SlungLink — inline workflow link for slung items', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders nothing when item.slung is null', () => {
    const { container } = render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <SlungLink item={{ slung: null }} />
      </MemoryRouter>,
    );
    expect(container.textContent).toBe('');
  });

  it('renders a link to /agents/<resolved_session_name> when slung is set with a resolved session', () => {
    // gascity-dashboard-55b: link target is the RESOLVED session_name,
    // not the configured target role label. The bug was the link going
    // to /agents/chief-of-staff (role label) and 404ing because
    // AgentDetail strict-matches against session_name / alias / id.
    const { container } = render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <SlungLink
          item={{
            slung: {
              slung_at: '2026-05-24T12:00:00.000Z',
              target: 'chief-of-staff',
              bead_id: 'gc-abc',
              resolved_session_name: 'oversight-rig__chief-of-staff',
            },
          }}
        />
      </MemoryRouter>,
    );
    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/agents/oversight-rig__chief-of-staff');
    expect(link?.textContent).toMatch(/slung/);
    // Faint weight so it reads as a secondary affordance, not a CTA.
    expect(link?.className).toMatch(/text-fg-faint/);
  });

  it('title attribute carries the target role label so the operator knows where it routed', () => {
    const { container } = render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <SlungLink
          item={{
            slung: {
              slung_at: '2026-05-24T12:00:00.000Z',
              target: 'project-lead',
              bead_id: null,
              resolved_session_name: 'agent-diagnostics--project-lead',
            },
          }}
        />
      </MemoryRouter>,
    );
    const link = container.querySelector('a');
    expect(link?.getAttribute('title')).toMatch(/slung to project-lead/);
    expect(link?.getAttribute('aria-label')).toMatch(/slung to project-lead/);
  });

  // gascity-dashboard-tgk: a resolved_session_name containing '/' is
  // treated defensively as if it were null. encodeURIComponent would
  // turn '/' into '%2F', but React Router's path matching is not
  // guaranteed to leave that encoded slash intact when matching :slug —
  // some configs normalize %2F back to '/' before matching, which splits
  // the path and breaks the :slug capture. Rather than emit a link that
  // may 404, SlungLink renders the same inline non-link path it uses for
  // the null case.
  it('renders inline "no session" error (no link) when resolved_session_name contains "/"', () => {
    const { container } = render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <SlungLink
          item={{
            slung: {
              slung_at: '2026-05-24T12:00:00.000Z',
              target: 'chief-of-staff',
              bead_id: null,
              resolved_session_name: 'hello-world/chief-of-staff',
            },
          }}
        />
      </MemoryRouter>,
    );
    // No link — a '/' in the slug is rejected at the rendering boundary.
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toMatch(/no session for chief-of-staff/i);
    // The accessible label (which differs from the visible text) must still
    // name the role and reassure that the sling itself succeeded.
    expect(
      container.querySelector('[aria-label]')?.getAttribute('aria-label'),
    ).toBe('no session for role chief-of-staff; sling itself succeeded');
  });

  // ── gascity-dashboard-55b: no-session error path ──────────────────
  //
  // When the configured target role doesn't map to any running session
  // (sling routed to an agent that's not spawned yet, OR supervisor was
  // unreachable at sling-write time, OR the entry is a legacy pre-55b
  // shape with no resolved_session_name field at all), the link must
  // NOT render as /agents/<role-label> — that's the 404 bug this bead
  // fixes. Surface an inline error instead so the operator knows the
  // sling itself succeeded but the link can't drill in yet.

  it('renders inline "no session" error when resolved_session_name is null', () => {
    const { container } = render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <SlungLink
          item={{
            slung: {
              slung_at: '2026-05-24T12:00:00.000Z',
              target: 'chief-of-staff',
              bead_id: null,
              resolved_session_name: null,
            },
          }}
        />
      </MemoryRouter>,
    );
    // No link element — this is the error path; nothing to drill in to.
    expect(container.querySelector('a')).toBeNull();
    // The error message names the role so the operator can either spawn
    // the agent or reconfigure MAINTAINER_SLING_TARGET.
    expect(container.textContent).toMatch(/no session for chief-of-staff/i);
  });

  it('renders inline "no session" error when resolved_session_name is undefined (legacy entry)', () => {
    // Legacy pre-55b on-disk entries don't carry resolved_session_name at all.
    // Treat undefined identically to null — no link, surface the error.
    const { container } = render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <SlungLink
          item={{
            slung: {
              slung_at: '2026-05-24T12:00:00.000Z',
              target: 'chief-of-staff',
              bead_id: null,
              // resolved_session_name absent
            },
          }}
        />
      </MemoryRouter>,
    );
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toMatch(/no session for chief-of-staff/i);
  });

  // Stale-cache safety: an envelope from a pre-9qs build has slung as
  // undefined. Loose != null in the component must catch both cases.
  it('renders nothing when item.slung is undefined (stale cache from pre-field build)', () => {
    const { container } = render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <SlungLink item={{ slung: undefined as unknown as null }} />
      </MemoryRouter>,
    );
    expect(container.textContent).toBe('');
  });
});

describe('SelectionActionBar — selection counter', () => {
  afterEach(() => {
    cleanup();
  });

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

// gascity-dashboard-5xw: the bar now exposes two intent buttons. Triage
// stays the default (back-compat for callers that haven't migrated);
// draft is rendered only when onSendDraft is supplied. Keeps existing
// test contexts working without forcing every callsite to handle both.
describe('SelectionActionBar — dual-intent buttons', () => {
  afterEach(() => {
    cleanup();
  });

  it('hides the draft button when onSendDraft is not provided', () => {
    renderBar();
    expect(screen.queryByRole('button', { name: /send to draft agent/i })).toBeNull();
  });

  it('renders the draft button alongside triage when onSendDraft is provided', () => {
    renderBar({ onSendDraft: () => {} });
    expect(screen.getByRole('button', { name: /send to triage agent/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /send to draft agent/i })).toBeTruthy();
  });

  it('invokes onSendDraft on click', () => {
    let called = 0;
    renderBar({ onSendDraft: () => { called += 1; } });
    screen.getByRole('button', { name: /send to draft agent/i }).click();
    expect(called).toBe(1);
  });

  it('disables both intent buttons while sending', () => {
    renderBar({ onSendDraft: () => {}, sending: true });
    const triage = screen.getByRole('button', { name: /sending/i }) as HTMLButtonElement;
    const draft = screen.getByRole('button', { name: /send to draft agent/i }) as HTMLButtonElement;
    expect(triage.disabled).toBe(true);
    expect(draft.disabled).toBe(true);
  });

  it('disables both intent buttons when count=0 (selection cleared post-success)', () => {
    renderBar({ count: 0, onSendDraft: () => {}, success: { count: 3, target: 'triage agent' } });
    const triage = screen.getByRole('button', { name: /send to triage agent/i }) as HTMLButtonElement;
    const draft = screen.getByRole('button', { name: /send to draft agent/i }) as HTMLButtonElement;
    expect(triage.disabled).toBe(true);
    expect(draft.disabled).toBe(true);
  });

  it("shows 'Sending' on the triage button only when sending='triage'", () => {
    renderBar({ onSendDraft: () => {}, sending: 'triage' });
    // The triage button is the one whose name became 'Sending'.
    expect(screen.queryByRole('button', { name: /send to triage agent/i })).toBeNull();
    expect(screen.getByRole('button', { name: /sending/i })).toBeTruthy();
    // The draft button keeps its static label.
    expect(screen.getByRole('button', { name: /send to draft agent/i })).toBeTruthy();
  });

  it("shows 'Sending' on the draft button only when sending='draft'", () => {
    renderBar({ onSendDraft: () => {}, sending: 'draft' });
    // The draft button is the one whose name became 'Sending'.
    expect(screen.queryByRole('button', { name: /send to draft agent/i })).toBeNull();
    expect(screen.getByRole('button', { name: /sending/i })).toBeTruthy();
    // The triage button keeps its static label.
    expect(screen.getByRole('button', { name: /send to triage agent/i })).toBeTruthy();
  });
});
