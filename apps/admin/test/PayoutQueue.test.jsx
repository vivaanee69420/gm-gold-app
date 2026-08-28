import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PayoutQueue from '../src/components/PayoutQueue.jsx';
import { clearToken, setToken } from '../src/api/client.js';
import { stubFetchRoutes } from './helpers.js';

const payouts = [
  {
    id: 'p1',
    amount_pennies: 12000,
    status: 'open',
    requested_at: '2026-08-14T10:00:00Z',
    practice: 'Sidcup',
    member: 'Sarah L.',
    phone: '07700 900111',
    referral_code: 'GMRF7K2X',
    credits: [{ friend: 'Alex', amountPennies: 6000, at: '2026-08-10' }],
  },
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
    expect(screen.getAllByRole('button', { name: 'Paid' })).toHaveLength(1);
  });

  it('shows phone, formatted referral code, and unpaid credits for an open row', () => {
    stubFetchRoutes([]);
    render(<PayoutQueue payouts={payouts} onChanged={vi.fn()} notify={vi.fn()} />);

    expect(screen.getByText('07700 900111 · GMRF-7K2X')).toBeInTheDocument();
    expect(screen.getByText('Alex · £60.00 · 2026-08-10')).toBeInTheDocument();
  });

  it('disables Paid until the typed amount parses to a positive number', () => {
    stubFetchRoutes([]);
    render(<PayoutQueue payouts={payouts} onChanged={vi.fn()} notify={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Paid' })).toBeDisabled();
  });

  it('marks an open request paid once a cash amount is typed', async () => {
    const calls = stubFetchRoutes([{ method: 'POST', path: '/admin/payouts/p1/mark-paid' }]);
    const onChanged = vi.fn();
    render(<PayoutQueue payouts={payouts} onChanged={onChanged} notify={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/cash handed over/i), '100');
    expect(screen.getByRole('button', { name: 'Paid' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Paid' }));

    expect(calls).toEqual([
      { method: 'POST', path: '/admin/payouts/p1/mark-paid', body: { amountPennies: 10000 } },
    ]);
    expect(onChanged).toHaveBeenCalled();
  });

  it('shows a toast when the typed amount does not match the request', async () => {
    stubFetchRoutes([
      { method: 'POST', path: '/admin/payouts/p1/mark-paid', status: 409, body: { error: 'amount_mismatch' } },
    ]);
    const notify = vi.fn();
    render(<PayoutQueue payouts={payouts} onChanged={vi.fn()} notify={notify} />);

    await userEvent.type(screen.getByLabelText(/cash handed over/i), '999');
    await userEvent.click(screen.getByRole('button', { name: 'Paid' }));

    expect(notify).toHaveBeenCalledWith('amount_mismatch');
  });

  it('cancels an open request with a reason (FR-21)', async () => {
    const calls = stubFetchRoutes([{ method: 'POST', path: '/admin/payouts/p1/cancel' }]);
    const onChanged = vi.fn();
    render(<PayoutQueue payouts={payouts} onChanged={onChanged} notify={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /cancel…/i }));
    await userEvent.type(screen.getByLabelText(/cancel reason for sarah l\./i), 'left the practice');
    await userEvent.click(screen.getByRole('button', { name: /confirm cancel/i }));

    expect(calls).toEqual([
      { method: 'POST', path: '/admin/payouts/p1/cancel', body: { reason: 'left the practice' } },
    ]);
    expect(onChanged).toHaveBeenCalled();
  });
});
