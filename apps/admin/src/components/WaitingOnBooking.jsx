import { isWaitingOnBooking } from '@gm-referral/shared/schemas';
import { Card, ListRow } from './ui.jsx';

// Referrals that exist but have not reached the board yet.
//
// A friend's referral is written the moment they submit the form — which is when they pick a
// practice, before they have booked anything. Dentally decides when an appointment is real, so
// the referral waits here and the sync moves it to Booked when it finds a matching appointment.
//
// This card is why that wait is safe, and it has two jobs.
//
// 1. The sync matches on EXACT phone equality or lowercased email, so a friend who books with
//    a different number than they gave — or whose number was mistyped on the form — never
//    matches and would otherwise sit invisible forever, taking the referrer's commission with
//    them. Anything lingering here with a plausible-looking phone is worth checking against
//    Dentally by hand.
//
// 2. Waiting is not indefinite. expireUnbookedReferrals (referralService.js) closes a referral
//    that has not booked inside config.referralBookingWindowHours, which also releases that
//    phone number for anyone else to refer. Since these leads have no card on the board,
//    nobody can rescue one — so the deadline has to be visible here, before it passes, not
//    discovered afterwards in the Lost column.
const DAY_MS = 86_400_000;

const daysSince = (isoDate) => {
  if (!isoDate) return null;
  const then = new Date(isoDate);
  if (Number.isNaN(then.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - then.getTime()) / DAY_MS));
};

/** Whole days left before the claim lapses, or null when we were not told the window. */
const daysLeft = (isoDate, windowHours) => {
  if (!windowHours || !isoDate) return null;
  const then = new Date(isoDate);
  if (Number.isNaN(then.getTime())) return null;
  const deadline = then.getTime() + windowHours * 3_600_000;
  return Math.ceil((deadline - Date.now()) / DAY_MS);
};

export default function WaitingOnBooking({ referrals = [], windowHours }) {
  const waiting = referrals.filter((r) => isWaitingOnBooking(r.status));
  if (waiting.length === 0) return null; // quiet when every lead has landed

  // Closest to lapsing first: this card is a deadline list, not a chronological one.
  const ordered = [...waiting].sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));

  return (
    <Card title="Waiting on booking" count={waiting.length} className="waiting-on-booking">
      <p className="meta">
        Submitted, but Dentally has no appointment for them yet. Each one joins the pipeline at
        Booked on its own once the appointment appears. One that lingers usually means the phone
        number on the referral does not match Dentally — worth checking by hand, because a
        referral that runs out of time closes and frees that friend to be referred by someone else.
      </p>
      <ul>
        {ordered.map((r) => {
          const left = daysLeft(r.created_at, windowHours);
          const waitedDays = daysSince(r.created_at);
          return (
            <ListRow
              key={r.id}
              title={r.referred_name}
              // The number that can still be acted on, not the one that cannot.
              value={left === null ? (waitedDays === null ? '—' : `${waitedDays}d`) : `${Math.max(0, left)}d left`}
              meta={[
                r.referred_phone,
                r.practice ?? 'no practice',
                r.referrer ? `referred by ${r.referrer}` : null,
                waitedDays === null ? null : `waiting ${waitedDays}d`,
              ].filter(Boolean).join(' · ')}
            />
          );
        })}
      </ul>
    </Card>
  );
}
