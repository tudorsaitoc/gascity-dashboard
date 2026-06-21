import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Table, type TableColumn } from './Table';

interface Row {
  id: string;
  name: string;
  state: string;
}

const columns: ReadonlyArray<TableColumn<Row>> = [
  { key: 'name', label: 'Name', render: (r) => r.name },
  { key: 'state', label: 'State', render: (r) => r.state },
];

const rows: Row[] = [
  { id: 'a', name: 'alpha', state: 'idle' },
  { id: 'b', name: 'bravo', state: 'busy' },
];

afterEach(() => {
  cleanup();
});

describe('Table', () => {
  it('renders only the table (no mobile list) when mobileRow is not provided', () => {
    render(<Table columns={columns} rows={rows} rowKey={(r) => r.id} />);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('renders a dedicated stacked mobile list when mobileRow is provided', () => {
    render(
      <Table
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        mobileRow={(r) => <span>{r.name}</span>}
      />,
    );
    const list = screen.getByRole('list');
    // The mobile list shows below sm:, the table from sm: up.
    expect(list.className).toContain('sm:hidden');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    const tableWrapper = screen.getByRole('table').parentElement;
    expect(tableWrapper?.className).toContain('hidden');
    expect(tableWrapper?.className).toContain('sm:block');
  });

  it('shows the empty message in the mobile list when there are no rows', () => {
    render(
      <Table
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        empty="No agents"
        mobileRow={(r) => <span>{r.name}</span>}
      />,
    );
    const list = screen.getByRole('list');
    expect(within(list).getByText('No agents')).toBeTruthy();
  });
});
