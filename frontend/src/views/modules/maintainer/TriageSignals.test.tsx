import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { SlungLink, TriageScore } from './TriageSignals';

describe('maintainer triage row signals', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders a vetted triage score as the authoritative score', () => {
    const { container } = render(
      <TriageScore
        item={{
          triage_score: 210,
          triage_assessment: {
            vetted_score: 320,
            source: 'agent',
            notes: '',
            vetted_at: '2026-05-27T00:00:00.000Z',
          },
        }}
      />,
    );

    expect(container.textContent).toContain('320');
    expect(container.textContent).not.toContain('t210');
  });

  it('links slung work to the resolved session name', () => {
    const { container } = render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <SlungLink
          item={{
            slung: {
              slung_at: '2026-05-27T00:00:00.000Z',
              target: 'triage-agent',
              bead_id: null,
              resolved_session_name: 'formula-runner__triage-agent',
            },
          }}
        />
      </MemoryRouter>,
    );

    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      '/agents/formula-runner__triage-agent',
    );
  });
});
