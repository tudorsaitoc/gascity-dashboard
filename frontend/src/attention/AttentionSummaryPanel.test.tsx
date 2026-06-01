import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AttentionProvider } from './context';
import { AttentionSummaryPanel } from './AttentionSummaryPanel';
import type { AttentionContributor, AttentionItem } from './compose';

describe('AttentionSummaryPanel', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders top attention items and grouped overflow from the shared model', () => {
    render(
      <AttentionProvider
        contributors={[
          contributor('runs', [
            item('run-1', 'runs', 'attention', { title: 'Run blocked', actionable: true }),
            item('run-2', 'runs', 'watch', { title: 'Run stale' }),
          ]),
          contributor('mail', [
            item('mail-1', 'mail', 'watch', { title: 'Mayor unread' }),
            item('mail-2', 'mail', 'watch', { title: 'Clerk unread' }),
          ]),
        ]}
        topLimit={2}
      >
        <AttentionSummaryPanel />
      </AttentionProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Attention' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Run blocked' }).getAttribute('href')).toBe('/runs');
    expect(screen.getByText('Run stale')).toBeTruthy();
    expect(screen.getByText('2 more in Mail')).toBeTruthy();
    expect(screen.queryByText('Mayor unread')).toBeNull();
  });

  it('renders nothing when there are no attention facts', () => {
    const { container } = render(
      <AttentionProvider contributors={[]}>
        <AttentionSummaryPanel />
      </AttentionProvider>,
    );

    expect(container.firstChild).toBeNull();
  });
});

function contributor(
  domain: AttentionItem['domain'],
  items: readonly AttentionItem[],
): AttentionContributor {
  return {
    id: `${domain}-test`,
    domain,
    getItems: () => items,
  };
}

function item(
  id: string,
  domain: AttentionItem['domain'],
  severity: AttentionItem['severity'],
  overrides: Partial<AttentionItem> = {},
): AttentionItem {
  return {
    id,
    domain,
    severity,
    title: id,
    href: `/${domain}`,
    current: true,
    actionable: false,
    ...overrides,
  };
}
