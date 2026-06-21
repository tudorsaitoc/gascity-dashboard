import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PageHeader } from './PageHeader';

afterEach(() => {
  cleanup();
});

describe('PageHeader', () => {
  it('renders the title as the level-1 page heading', () => {
    render(<PageHeader title="Formula Runs" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Formula Runs' })).toBeTruthy();
  });

  it('scales the heading mobile-first: Headline on phones, Display from sm up', () => {
    render(<PageHeader title="Formula Runs" />);
    const heading = screen.getByRole('heading', { level: 1 });
    // Base (mobile) renders the smaller Headline step so the title does not
    // dominate a ~390px viewport; it grows to Display at sm: and up.
    expect(heading.className).toContain('text-headline');
    expect(heading.className).toContain('sm:text-display');
    // The unconditional Display step would re-dominate mobile, so it must not
    // be applied without a breakpoint prefix.
    expect(heading.className).not.toMatch(/(^|\s)text-display(\s|$)/);
  });

  it('renders the optional synopsis and meta slot', () => {
    render(<PageHeader title="Runs" synopsis="3 active" meta={<span>live</span>} />);
    expect(screen.getByText('3 active')).toBeTruthy();
    expect(screen.getByText('live')).toBeTruthy();
  });
});
