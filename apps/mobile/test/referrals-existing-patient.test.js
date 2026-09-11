// A referrer whose friend turned out to be an existing patient gets no reward. Before this,
// their app showed a bare "Closed" chip and no money — indistinguishable from the app having
// lost the referral. These assert the outcome is stated, and stated only when it is settled.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, act } from '@testing-library/react';

const myReferrals = vi.fn();

vi.mock('../src/api/client', () => ({ api: { myReferrals: () => myReferrals() } }));

// react-navigation's useFocusEffect is what drives the initial load; run the callback once,
// the way a focused screen would.
vi.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb) => useEffect(() => cb(), []),
}));

// screens/referrer.js exports three screens and imports what all of them need, so pulling in
// ReferralsScreen also pulls GoldCard -> react-native-qrcode-svg -> react-native-svg, whose
// Flow-typed source esbuild cannot parse, and BookAppointment -> expo-camera. Neither is on
// this screen. Stubbed rather than aliased in the vitest config, so the swap stays visible
// next to the test that needs it.
vi.mock('../src/components/GoldCard', () => ({ GoldCard: () => null }));
vi.mock('../src/components/BookAppointment', () => ({ default: () => null }));
// Same reason: the Card and Wallet screens in this file use useAppState, which reaches the
// Supabase client and expo-secure-store. ReferralsScreen reads none of it.
vi.mock('../src/state/AppState', () => ({ useAppState: () => ({ user: null }) }));

const { ReferralsScreen } = await import('../src/screens/referrer');

const row = (over = {}) => ({
  id: 'r1', friendName: 'Jane S.', createdAt: '2026-09-01', status: 'booked', ...over,
});

const show = async (referrals) => {
  myReferrals.mockResolvedValue({ referrals });
  await act(async () => {
    render(<ReferralsScreen />);
  });
};

beforeEach(() => {
  myReferrals.mockReset();
  vi.useRealTimers();
});

describe('an existing-patient closure on the referrals list', () => {
  it('names the outcome instead of a bare "Closed"', async () => {
    await show([row({ status: 'lost', closedReason: 'existing_patient' })]);

    expect(screen.getByText('Already a patient')).toBeInTheDocument();
    expect(screen.queryByText('Closed')).not.toBeInTheDocument();
  });

  it('explains in words why there is no reward', async () => {
    await show([row({ status: 'lost', closedReason: 'existing_patient' })]);

    // The chip cannot carry this on its own; someone who referred in good faith and got
    // nothing needs the sentence.
    expect(screen.getByText(/already a patient here before your referral/i)).toBeInTheDocument();
    expect(screen.getByText(/no reward/i)).toBeInTheDocument();
  });

  it('does not blame the referrer', async () => {
    await show([row({ status: 'lost', closedReason: 'existing_patient' })]);
    const note = screen.getByText(/already a patient here before your referral/i).textContent;
    expect(note).not.toMatch(/invalid|rejected|not allowed|your fault|ineligible/i);
  });

  it('still says "Closed" for a closure with no relayed reason', async () => {
    // The API withholds the free-text reason behind other closures on purpose, so the app
    // must not invent an explanation it was not given.
    await show([row({ status: 'lost' })]);

    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.queryByText(/already a patient/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no reward/i)).not.toBeInTheDocument();
  });

  it('says nothing about it on a referral that is still progressing', async () => {
    await show([row({ status: 'booked' })]);

    expect(screen.getByText('Booked')).toBeInTheDocument();
    expect(screen.queryByText(/already a patient/i)).not.toBeInTheDocument();
  });

  it('leaves a paid referral showing its money', async () => {
    await show([row({ status: 'treatment_completed', creditPennies: 2000 })]);

    expect(screen.getByText(/\+£20/)).toBeInTheDocument();
    expect(screen.queryByText(/no reward/i)).not.toBeInTheDocument();
  });

  it('explains an expired claim, and says they can be referred again', async () => {
    // The only closure with a useful next step. It must not read as a telling-off — the
    // referrer did nothing wrong, their friend simply did not book in time.
    await show([row({ status: 'lost', closedReason: 'booking_window_expired' })]);

    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.getByText(/didn’t book in time/i)).toBeInTheDocument();
    expect(screen.getByText(/welcome to refer them again/i)).toBeInTheDocument();
  });

  it('does not blame the referrer for an expiry either', async () => {
    await show([row({ status: 'lost', closedReason: 'booking_window_expired' })]);
    const note = screen.getByText(/didn’t book in time/i).textContent;
    expect(note).not.toMatch(/you failed|your fault|too late|missed your/i);
  });

  it('shows one note per affected referral, not one for the list', async () => {
    await show([
      row({ id: 'a', friendName: 'Ann A.', status: 'lost', closedReason: 'existing_patient' }),
      row({ id: 'b', friendName: 'Ben B.', status: 'booked' }),
      row({ id: 'c', friendName: 'Cal C.', status: 'lost', closedReason: 'existing_patient' }),
    ]);

    expect(screen.getAllByText(/already a patient here before your referral/i)).toHaveLength(2);
    expect(screen.getByText('Ben B.')).toBeInTheDocument();
  });
});
