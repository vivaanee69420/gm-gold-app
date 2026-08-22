import { Card, ListRow } from './ui.jsx';

export default function AgingReport({ aging, days }) {
  if (aging.length === 0) return null; // quiet when healthy — this is an exceptions surface
  return (
    <Card title={`Waiting on Dentally (${days}+ days)`} count={aging.length} className="aging-report">
      <p className="meta">
        Booked or agreed referrals with no completion proposal — usually a phone mismatch. Complete them
        manually from the pipeline if treatment is done.
      </p>
      <ul>
        {aging.map((a) => (
          <ListRow
            key={a.id}
            title={a.referred_name}
            value={`${a.days_waiting}d`}
            meta={`${a.status.replace('_', ' ')} · referred by ${a.referrer} · ${a.practice ?? 'no practice'} · ${a.referred_phone}`}
          />
        ))}
      </ul>
    </Card>
  );
}
