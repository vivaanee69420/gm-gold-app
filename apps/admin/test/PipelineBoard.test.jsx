import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PipelineBoard from '../src/components/PipelineBoard.jsx';
import { clearToken, setToken } from '../src/api/client.js';
import { stubFetchRoutes } from './helpers.js';

const referrals = [
  { id: 'r1', referred_name: 'Jane Smith', referred_phone: '+447700900456', status: 'new', treatment_interest: 'implants', practice: 'Sidcup', referrer: 'Sarah Lewis' },
  { id: 'r2', referred_name: 'Tom Hall', referred_phone: '+447700900789', status: 'booked', treatment_interest: 'aligners', practice: 'Bexley', referrer: 'Sarah Lewis' },
];

beforeEach(() => {
  clearToken();
  setToken('tok');
});
afterEach(() => vi.unstubAllGlobals());

describe('PipelineBoard', () => {
  it('advances a referral to an adjacent status', async () => {
    const calls = stubFetchRoutes([{ method: 'PATCH', path: '/admin/referrals/r1/status' }]);
    const onChanged = vi.fn();
    render(<PipelineBoard referrals={referrals} onChanged={onChanged} notify={vi.fn()} />);

    expect(screen.getByText('Jane Smith')).toBeInTheDocument();
    expect(screen.getByText('Tom Hall')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText(/status for jane smith/i), 'contacted');

    expect(calls).toEqual([
      { method: 'PATCH', path: '/admin/referrals/r1/status', body: { status: 'contacted' } },
    ]);
    expect(onChanged).toHaveBeenCalled();
  });

  it('requires a reason before marking a referral lost', async () => {
    const calls = stubFetchRoutes([{ method: 'PATCH', path: '/admin/referrals/r2/status' }]);
    render(<PipelineBoard referrals={referrals} onChanged={vi.fn()} notify={vi.fn()} />);

    await userEvent.selectOptions(screen.getByLabelText(/status for tom hall/i), 'lost');
    expect(calls).toHaveLength(0); // nothing sent until a reason is confirmed

    await userEvent.type(screen.getByLabelText(/lost reason for tom hall/i), 'moved away');
    await userEvent.click(screen.getByRole('button', { name: /confirm lost/i }));

    expect(calls).toEqual([
      { method: 'PATCH', path: '/admin/referrals/r2/status', body: { status: 'lost', lostReason: 'moved away' } },
    ]);
  });
});
