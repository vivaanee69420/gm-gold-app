import { formatPennies } from '@gm-referral/shared/money';
import { REFERRAL_STATUSES } from '@gm-referral/shared/schemas';

// The ledger line: the one figure the owner checks first, set over the gold seam.
// A manager's `liabilityPennies` comes back null — company-wide liability is withheld
// from a practice-scoped account — so show what they can see instead: their practice's
// credited total, clearly labelled as that rather than as liability.
export default function StatsStrip({ stats }) {
  const counts = stats.referralCounts ?? {};
  const showCredited = stats.liabilityPennies === null;
  return (
    <section className="overview">
      <div className="stat">
        <p className="stat-label">{showCredited ? 'Credited (your practice)' : 'Liability'}</p>
        <p className="stat-value">
          {formatPennies(showCredited ? stats.creditedPennies : stats.liabilityPennies)}
        </p>
        <p className="meta">
          {showCredited ? 'commissions credited for your practice' : 'unpaid balances across referrers'}
        </p>
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
