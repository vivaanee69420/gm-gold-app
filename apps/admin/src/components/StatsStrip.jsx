import { formatPennies } from '@gm-referral/shared/money';
import { REFERRAL_STATUSES } from '@gm-referral/shared/schemas';

// The ledger line: the one figure the owner checks first, set over the gold seam.
export default function StatsStrip({ stats }) {
  const counts = stats.referralCounts ?? {};
  return (
    <section className="overview">
      <div className="stat">
        <p className="stat-label">Liability</p>
        <p className="stat-value">{formatPennies(stats.liabilityPennies)}</p>
        <p className="meta">unpaid balances across referrers</p>
      </div>
      <div className="stat-counts">
        {REFERRAL_STATUSES.filter((s) => counts[s]).map((s) => (
          <span key={s} className="chip">
            {s.replaceAll('_', ' ')} {counts[s]}
          </span>
        ))}
      </div>
    </section>
  );
}
