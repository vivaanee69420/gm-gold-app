import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ReferralReviewQueue from '../src/components/ReferralReviewQueue.jsx';
import { stubFetchRoutes } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());

const review = {
  id: 'r1',
  referred_name: 'Jane Smith',
  referred_phone: '+447700900456',
  status: 'new',
  created_at: '2026-08-20T10:00:00Z',
  practice: 'Maidstone',
  referrer: 'Sarah Lewis',
};

describe('ReferralReviewQueue', () => {
  it('shows the empty state', () => {
    stubFetchRoutes([]);
    render(<ReferralReviewQueue reviews={[]} onChanged={() => {}} notify={() => {}} />);
    expect(screen.getByText(/nothing flagged/i)).toBeInTheDocument();
  });

  it('clears a suspect', async () => {
    const calls = stubFetchRoutes([
      { method: 'POST', path: '/admin/referral-review/r1/decide', body: { ok: true, decision: 'clear' } },
    ]);
    const onChanged = vi.fn();
    render(<ReferralReviewQueue reviews={[review]} onChanged={onChanged} notify={() => {}} />);

    await userEvent.click(screen.getByRole('button', { name: /genuinely new/i }));
    expect(calls[0].body).toEqual({ decision: 'clear' });
    expect(onChanged).toHaveBeenCalled();
  });

  it('confirms an existing patient as lost', async () => {
    const calls = stubFetchRoutes([
      { method: 'POST', path: '/admin/referral-review/r1/decide', body: { ok: true, decision: 'existing_patient' } },
    ]);
    const onChanged = vi.fn();
    render(<ReferralReviewQueue reviews={[review]} onChanged={onChanged} notify={() => {}} />);

    await userEvent.click(screen.getByRole('button', { name: /existing patient — mark lost/i }));
    expect(calls[0].body).toEqual({ decision: 'existing_patient' });
    expect(onChanged).toHaveBeenCalled();
  });

  it('surfaces a decide error through notify', async () => {
    stubFetchRoutes([
      { method: 'POST', path: '/admin/referral-review/r1/decide', status: 409, body: { error: 'not_in_review' } },
    ]);
    const notify = vi.fn();
    render(<ReferralReviewQueue reviews={[review]} onChanged={() => {}} notify={notify} />);

    await userEvent.click(screen.getByRole('button', { name: /genuinely new/i }));
    expect(notify).toHaveBeenCalledWith('not_in_review');
  });
});
