import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PayoutQueue from '../src/components/PayoutQueue.jsx';
import { clearToken, setToken } from '../src/api/client.js';
import { stubFetchRoutes } from './helpers.js';

const payouts = [
  { id: 'p1', amount_pennies: 12000, status: 'open', requested_at: '2026-08-14T10:00:00Z', practice: 'Sidcup', member: 'Sarah L.' },
  { id: 'p2', amount_pennies: 10000, status: 'paid', requested_at: '2026-08-10T09:00:00Z', practice: 'Bexley', member: 'M. Osei' },
];

beforeEach(() => {
  clearToken();
  setToken('tok');
});
afterEach(() => vi.unstubAllGlobals());

describe('PayoutQueue', () => {
  it('lists open requests with formatted amounts; settled ones get no button', () => {
    stubFetchRoutes([]);
    render(<PayoutQueue payouts={payouts} onChanged={vi.fn()} notify={vi.fn()} />);

    expect(screen.getByText('Sarah L.')).toBeInTheDocument();
    expect(screen.getByText('£120.00')).toBeInTheDocument();
    expect(screen.getByText(/sidcup/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /mark paid/i })).toHaveLength(1);
  });

  it('marks an open request paid', async () => {
    const calls = stubFetchRoutes([{ method: 'POST', path: '/admin/payouts/p1/mark-paid' }]);
    const onChanged = vi.fn();
    render(<PayoutQueue payouts={payouts} onChanged={onChanged} notify={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /mark paid/i }));

    expect(calls).toEqual([{ method: 'POST', path: '/admin/payouts/p1/mark-paid', body: undefined }]);
    expect(onChanged).toHaveBeenCalled();
  });
});
