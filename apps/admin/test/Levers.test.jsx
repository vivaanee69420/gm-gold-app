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
  it('shows current values in pounds', async () => {
    stubFetchRoutes([{ method: 'PUT', path: '/admin/settings' }]);
    render(<Levers settings={settings} onChanged={vi.fn()} notify={vi.fn()} />);

    expect(screen.getByLabelText(/payout threshold/i)).toHaveValue('100');
    expect(screen.getByLabelText(/payout expiry/i)).toHaveValue('90');
  });

  it('no longer offers a commission field, because commission is per referral', async () => {
    // It used to write a single global reward_rules row. Commission is chosen per referral on
    // the pipeline card now, so a field here would have let an owner set a number carefully
    // and change nothing — worse than not offering it, because it looks like a control.
    render(<Levers settings={settings} onChanged={vi.fn()} notify={vi.fn()} />);

    expect(screen.queryByLabelText(/commission per referral/i)).not.toBeInTheDocument();
    // And it says where the number actually lives.
    expect(screen.getByText(/set per referral on the pipeline card/i)).toBeInTheDocument();
  });

  it('saves a changed threshold via settings', async () => {
    const calls = stubFetchRoutes([{ method: 'PUT', path: '/admin/settings' }]);
    render(<Levers settings={settings} onChanged={vi.fn()} notify={vi.fn()} />);

    const threshold = screen.getByLabelText(/payout threshold/i);
    await userEvent.clear(threshold);
    await userEvent.type(threshold, '120');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(calls).toEqual([
      { method: 'PUT', path: '/admin/settings', body: { payout_threshold_pennies: 12000 } },
    ]);
  });
});
