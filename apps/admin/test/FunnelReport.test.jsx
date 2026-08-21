import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FunnelReport from '../src/components/FunnelReport.jsx';
import { stubFetchRoutes } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());

const funnel = {
  inviteSent: 120,
  appActivated: 40,
  shareTapped: 25,
  codeEntered: 10,
  referralSubmitted: 8,
  consultBooked: 3,
  treatmentCompleted: 1,
  commissionsCredited: 1,
  payoutsPaid: 0,
  tripwireRate: 0.8,
};

describe('FunnelReport', () => {
  it('shows the tripwire rate and marks share_tapped as noisy', () => {
    stubFetchRoutes([]);
    render(<FunnelReport funnel={funnel} onChanged={() => {}} notify={() => {}} />);
    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(screen.getByText(/noisy — share-sheet opens/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/invites sent \(manual\)/i)).toHaveValue('120');
  });

  it('shows a placeholder before code_entered events exist', () => {
    stubFetchRoutes([]);
    render(<FunnelReport funnel={{ ...funnel, tripwireRate: null }} onChanged={() => {}} notify={() => {}} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText(/waiting on code_entered/i)).toBeInTheDocument();
  });

  it('saves the manual invite count', async () => {
    const calls = stubFetchRoutes([{ method: 'PUT', path: '/admin/settings', body: { ok: true } }]);
    const onChanged = vi.fn();
    render(<FunnelReport funnel={funnel} onChanged={onChanged} notify={() => {}} />);

    const input = screen.getByLabelText(/invites sent \(manual\)/i);
    await userEvent.clear(input);
    await userEvent.type(input, '250');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(calls[0].body).toEqual({ invite_sent_manual_count: 250 });
    expect(onChanged).toHaveBeenCalled();
  });

  it('rejects a non-numeric invite count without calling the API', async () => {
    const calls = stubFetchRoutes([]);
    const notify = vi.fn();
    render(<FunnelReport funnel={funnel} onChanged={() => {}} notify={notify} />);

    const input = screen.getByLabelText(/invites sent \(manual\)/i);
    await userEvent.clear(input);
    await userEvent.type(input, 'lots');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(calls.length).toBe(0);
    expect(notify).toHaveBeenCalledWith('validation');
  });
});
