import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ReferralRecord from '../src/components/ReferralRecord.jsx';

const referrals = [
  {
    id: 'r1',
    referred_name: 'Jane Smith',
    referred_phone: '+447700900456',
    status: 'treatment_completed',
    treatment_interest: 'implants',
    practice: 'Ashford',
    created_at: '2026-08-01',
    source: 'qr',
    referrer: 'Sarah Lewis',
    referrer_phone: '+447700900001',
    referrer_code: 'GMRF7K2X',
    commission_pennies: 2000,
    commission_at: '2026-08-20',
  },
  {
    id: 'r2',
    referred_name: 'Tom Hall',
    referred_phone: '+447700900789',
    status: 'treatment_completed',
    treatment_interest: 'aligners',
    practice: 'Barnet',
    created_at: '2026-08-10',
    source: 'code',
    referrer: 'Priya Patel',
    referrer_phone: '+447700900002',
    referrer_code: 'GMRFAB12',
    commission_pennies: null,
    commission_at: null,
  },
  {
    id: 'r3',
    referred_name: 'Amy Wong',
    referred_phone: '+447700900111',
    status: 'booked',
    treatment_interest: 'veneers',
    practice: 'Rochester',
    created_at: '2026-08-15',
    source: 'code',
    referrer: 'Sarah Lewis',
    referrer_phone: '+447700900001',
    referrer_code: 'GMRF7K2X',
    commission_pennies: null,
    commission_at: null,
  },
];

describe('ReferralRecord', () => {
  it('links each referred friend to their referrer with code and commission state', () => {
    render(<ReferralRecord referrals={referrals} />);

    // Jane: credited — shows the amount and date next to her referrer
    const jane = screen.getByText('Jane Smith').closest('tr');
    expect(jane).toHaveTextContent('Sarah Lewis');
    expect(jane).toHaveTextContent('GMRF7K2X');
    expect(jane).toHaveTextContent('£20.00');
    expect(jane).toHaveTextContent('credited 2026-08-20');

    // Tom: completed but not yet credited — flagged as due
    const tom = screen.getByText('Tom Hall').closest('tr');
    expect(tom).toHaveTextContent('Priya Patel');
    expect(tom).toHaveTextContent('due');

    // Amy: still in the pipeline — no commission yet
    const amy = screen.getByText('Amy Wong').closest('tr');
    expect(amy).toHaveTextContent('Booked');
    expect(amy).not.toHaveTextContent('£');
  });

  it('filters the register by referred name, referrer, or code', async () => {
    render(<ReferralRecord referrals={referrals} />);
    const search = screen.getByLabelText(/search referral record/i);

    await userEvent.type(search, 'priya');
    expect(screen.getByText('Tom Hall')).toBeInTheDocument();
    expect(screen.queryByText('Jane Smith')).not.toBeInTheDocument();

    await userEvent.clear(search);
    await userEvent.type(search, 'GMRF7K2X');
    expect(screen.getByText('Jane Smith')).toBeInTheDocument();
    expect(screen.getByText('Amy Wong')).toBeInTheDocument();
    expect(screen.queryByText('Tom Hall')).not.toBeInTheDocument();
  });

  it('shows an inviting empty state before any referrals exist', () => {
    render(<ReferralRecord referrals={[]} />);
    expect(screen.getByText(/no referrals yet/i)).toBeInTheDocument();
  });
});
