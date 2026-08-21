export default function AgingReport({ aging, days }) {
  if (aging.length === 0) return null; // quiet when healthy — this is an exceptions surface
  return (
    <section className="card aging-report">
      <h2>Waiting on Dentally ({days}+ days)</h2>
      <p className="meta">
        Booked or agreed referrals with no completion proposal — usually a phone mismatch. Complete them
        manually from the pipeline if treatment is done.
      </p>
      <ul>
        {aging.map((a) => (
          <li key={a.id}>
            <div>
              <strong>{a.referred_name}</strong>
              <span className="amount">{a.days_waiting}d</span>
            </div>
            <p className="meta">
              {a.status.replace('_', ' ')} · referred by {a.referrer} · {a.practice ?? 'no practice'} · {a.referred_phone}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
