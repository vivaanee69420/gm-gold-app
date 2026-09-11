import { isWaitingOnBooking } from '@gm-referral/shared/schemas';
import { Card, ListRow } from './ui.jsx';

// Referrals that exist but have not reached the board yet.
//
// A friend's referral is written the moment they submit the form — which is when they pick a
// practice, before they have booked anything. Dentally decides when an appointment is real, so
// the referral waits here and the sync moves it to Booked when it finds a matching appointment.
//
// This card is why that wait is safe. The sync matches on EXACT phone equality or lowercased
// email, so a friend who books with a different number than they gave — or whose number was
// mistyped on the form — never matches and would otherwise sit invisible forever, taking the
// referrer's commission with them. Anything lingering here with a plausible-looking phone is
// worth checking against Dentally by hand.
const daysSince = (isoDate) => {
  if (!isoDate) return null;
  const then = new Date(isoDate);
  if (Number.isNaN(then.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - then.getTime()) / 86_400_000));
};

export default function WaitingOnBooking({ referrals = [] }) {
  const waiting = referrals.filter((r) => isWaitingOnBooking(r.status));
  if (waiting.length === 0) return null; // quiet when every lead has landed

  return (
    <Card title="Waiting on booking" count={waiting.length} className="waiting-on-booking">
      <p className="meta">
        Submitted, but Dentally has no appointment for them yet. Each one joins the pipeline at
        Booked on its own once the appointment appears — no action needed unless one lingers,
        which usually means the phone number on the referral does not match Dentally.
      </p>
      <ul>
        {waiting.map((r) => {
          const days = daysSince(r.created_at);
          return (
            <ListRow
              key={r.id}
              title={r.referred_name}
              value={days === null ? '—' : `${days}d`}
              meta={[
                r.referred_phone,
                r.practice ?? 'no practice',
                r.referrer ? `referred by ${r.referrer}` : null,
              ].filter(Boolean).join(' · ')}
            />
          );
        })}
      </ul>
    </Card>
  );
}
