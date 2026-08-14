import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Levers from '../src/components/Levers.jsx';
import { clearToken, setToken } from '../src/api/client.js';
import { stubFetchRoutes } from './helpers.js';

const settings = { payout_threshold_pennies: '10000', payout_expiry_days: '90' };

beforeEach(() => {
  clearToken();
  setToken('tok');
});
afterEach(() => vi.unstubAllGlobals());

describe('Levers', () => {
  it('shows current values in pounds and saves a changed commission', async () => {
    const calls = stubFetchRoutes([{ method: 'PUT', path: '/admin/reward-amount' }]);
    const onChanged = vi.fn();
    render(<Levers commissionPennies={2000} settings={settings} onChanged={onChanged} notify={vi.fn()} />);

    const commission = screen.getByLabelText(/commission per referral/i);
    expect(commission).toHaveValue('20');
    expect(screen.getByLabelText(/payout threshold/i)).toHaveValue('100');

    await userEvent.clear(commission);
    await userEvent.type(commission, '25');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(calls).toEqual([
      { method: 'PUT', path: '/admin/reward-amount', body: { amountPennies: 2500 } },
    ]);
    expect(onChanged).toHaveBeenCalled();
  });

  it('saves a changed threshold via settings without touching the reward rule', async () => {
    const calls = stubFetchRoutes([{ method: 'PUT', path: '/admin/settings' }]);
    render(<Levers commissionPennies={2000} settings={settings} onChanged={vi.fn()} notify={vi.fn()} />);

    const threshold = screen.getByLabelText(/payout threshold/i);
    await userEvent.clear(threshold);
    await userEvent.type(threshold, '120');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(calls).toEqual([
      { method: 'PUT', path: '/admin/settings', body: { payout_threshold_pennies: 12000 } },
    ]);
  });
});
