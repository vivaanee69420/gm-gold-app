import { formatPennies } from '@gm-referral/shared/money';

export default function TopReferrers({ topReferrers }) {
  return (
    <section className="card top-referrers">
      <h2>Top referrers</h2>
      {topReferrers.length === 0 && <p className="empty">No referrals yet.</p>}
      <ul>
        {topReferrers.map((r) => (
          <li key={r.id}>
            <div>
              <strong>{r.name}</strong>
              <span className="amount">{formatPennies(r.credited_pennies)}</span>
            </div>
            <p className="meta">
              {r.completed} completed of {r.referrals} referred
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
