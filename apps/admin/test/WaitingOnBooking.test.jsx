// The safety net for the pipeline's new entry rule. Leads now wait off the board until the
// Dentally sync confirms an appointment, and the sync matches on exact phone equality — so
// without somewhere to see the waiting population, a mistyped number would take a referral and
// its commission out of the business with nobody able to notice.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import WaitingOnBooking from '../src/components/WaitingOnBooking.jsx';

const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

const waiting = {
  id: 'rw', referred_name: 'Wendy Waiting', referred_phone: '+447700900999',
  status: 'new', practice: 'Sidcup', referrer: 'Sarah Lewis', created_at: twoDaysAgo,
};
const contacted = {
  id: 'rc', referred_name: 'Carl Contacted', referred_phone: '+447700900888',
  status: 'contacted', practice: 'Ashford', referrer: 'Sarah Lewis', created_at: twoDaysAgo,
};
const onBoard = {
  id: 'rb', referred_name: 'Bea Booked', referred_phone: '+447700900777',
  status: 'booked', practice: 'Bexley', referrer: 'Sarah Lewis', created_at: twoDaysAgo,
};

describe('WaitingOnBooking', () => {
  it('lists referrals that have no confirmed appointment yet', () => {
    render(<WaitingOnBooking referrals={[waiting, onBoard]} />);

    expect(screen.getByText('Wendy Waiting')).toBeInTheDocument();
    // The phone is the thing to check against Dentally when one of these lingers, so it has
    // to be on screen rather than behind a click.
    expect(screen.getByText(/\+447700900999/)).toBeInTheDocument();
  });

  it('does not list referrals that already reached the board', () => {
    render(<WaitingOnBooking referrals={[waiting, onBoard]} />);
    expect(screen.queryByText('Bea Booked')).not.toBeInTheDocument();
  });

  it('counts contacted as still waiting — it sits behind Booked on the ladder', () => {
    render(<WaitingOnBooking referrals={[waiting, contacted, onBoard]} />);
    expect(screen.getByText('Wendy Waiting')).toBeInTheDocument();
    expect(screen.getByText('Carl Contacted')).toBeInTheDocument();
  });

  it('shows how long each has been waiting, so a stuck one stands out', () => {
    render(<WaitingOnBooking referrals={[waiting]} />);
    expect(screen.getByText('2d')).toBeInTheDocument();
  });

  it('renders nothing at all when every lead has landed', () => {
    // Same choice as AgingReport: an empty exceptions card is noise on a busy screen.
    const { container } = render(<WaitingOnBooking referrals={[onBoard]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('survives a missing created_at rather than printing NaN', () => {
    render(<WaitingOnBooking referrals={[{ ...waiting, created_at: null }]} />);
    expect(screen.getByText('Wendy Waiting')).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it('tolerates being handed no referrals at all', () => {
    const { container } = render(<WaitingOnBooking />);
    expect(container).toBeEmptyDOMElement();
  });
});

// Waiting is not indefinite: expireUnbookedReferrals closes a referral that has not booked
// inside the claim window, which also frees that friend to be referred by someone else. These
// leads have no card on the board, so this card is the only place the deadline can be beaten.
describe('WaitingOnBooking deadlines', () => {
  const WINDOW = 336; // 14 days, the configured default

  const at = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
  const lead = (id, name, daysAgo) => ({
    id, referred_name: name, referred_phone: '+447700900111',
    status: 'new', practice: 'Sidcup', referrer: 'Sarah Lewis', created_at: at(daysAgo),
  });

  it('counts down the days left rather than the days waited', () => {
    render(<WaitingOnBooking referrals={[lead('a', 'Ann Aging', 4)]} windowHours={WINDOW} />);
    // 14-day window, waiting 4 days -> 10 left. The number that can still be acted on.
    expect(screen.getByText('10d left')).toBeInTheDocument();
  });

  it('still shows the time waited in the detail line', () => {
    render(<WaitingOnBooking referrals={[lead('a', 'Ann Aging', 4)]} windowHours={WINDOW} />);
    expect(screen.getByText(/waiting 4d/)).toBeInTheDocument();
  });

  it('never counts below zero', () => {
    // A lead past its window but not yet swept — the sweep runs on the sync, not on a clock.
    render(<WaitingOnBooking referrals={[lead('a', 'Ann Overdue', 40)]} windowHours={WINDOW} />);
    expect(screen.getByText('0d left')).toBeInTheDocument();
  });

  it('puts the closest to lapsing first', () => {
    const { container } = render(
      <WaitingOnBooking
        referrals={[lead('b', 'Ben Fresh', 1), lead('a', 'Ann Urgent', 12)]}
        windowHours={WINDOW}
      />,
    );
    const names = [...container.querySelectorAll('li')].map((li) => li.textContent);
    expect(names[0]).toContain('Ann Urgent');
    expect(names[1]).toContain('Ben Fresh');
  });

  it('falls back to the days waited when the window is unknown', () => {
    // A dashboard that loaded before the settings call resolved must not print "NaNd left".
    render(<WaitingOnBooking referrals={[lead('a', 'Ann Aging', 4)]} />);
    expect(screen.getByText('4d')).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
    expect(screen.queryByText(/left/)).not.toBeInTheDocument();
  });

  it('warns in the copy that running out of time frees the friend', () => {
    // The consequence is not obvious and is not reversible, so the card says it.
    render(<WaitingOnBooking referrals={[lead('a', 'Ann Aging', 4)]} windowHours={WINDOW} />);
    expect(screen.getByText(/frees that friend to be referred by someone else/i)).toBeInTheDocument();
  });
});
