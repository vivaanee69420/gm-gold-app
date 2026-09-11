import { formatPennies } from '@gm-referral/shared/money';
import Levers from '../components/Levers.jsx';
import FunnelReport from '../components/FunnelReport.jsx';
import TopReferrers from '../components/TopReferrers.jsx';
import { Zone } from '../components/ui.jsx';

/**
 * One figure, said plainly: what it is, what it is now, and what that means. The caption is
 * the part that earns the card — a number with no unit of meaning beside it is trivia.
 */
function Metric({ label, value, caption, tone }) {
  return (
    <div className={tone ? `metric metric-${tone}` : 'metric'}>
      <p className="metric-label">{label}</p>
      <p className="metric-value">{value}</p>
      {caption && <p className="meta">{caption}</p>}
    </div>
  );
}

const count = (counts, ...statuses) =>
  statuses.reduce((total, status) => total + (counts[status] ?? 0), 0);

/**
 * Where the scheme stands, in cards. The headline figures first, because they answer the
 * questions asked most often — what do we owe, what has this cost, what is in flight — then
 * the funnel and the referrers behind them, then the one lever that changes any of it.
 */
export default function OverviewPage({ data, loadAll, notify }) {
  const counts = data.stats.referralCounts ?? {};
  const openPayouts = data.payouts?.filter((p) => p.status === 'open') ?? [];
  const openPennies = openPayouts.reduce((sum, p) => sum + Number(p.amount_pennies ?? 0), 0);
  const inTreatment = count(counts, 'treatment_started', 'treatment_completed');
  const live = count(counts, 'new', 'contacted', 'booked', 'attended', 'treatment_agreed');

  return (
    <>
      <Zone label="Where things stand">
        <div className="metric-grid">
          <Metric
            label="Owed to referrers"
            value={formatPennies(data.stats.liabilityPennies ?? 0)}
            caption="credited and not yet collected"
            tone="lead"
          />
          <Metric
            label="Awaiting collection"
            value={formatPennies(openPennies)}
            caption={openPayouts.length === 1 ? '1 request to hand over' : `${openPayouts.length} requests to hand over`}
          />
          <Metric
            label="Credited to date"
            value={formatPennies(data.stats.creditedPennies ?? 0)}
            caption="every commission this scheme has released"
          />
          <Metric
            label="Live in the pipeline"
            value={live}
            caption="referred, not yet treated or lost"
          />
          <Metric
            label="In treatment"
            value={inTreatment}
            caption="started or completed"
          />
          {/* A single figure here used to read the global reward rule. There is no single
              figure any more — the manager picks a tier per referral — so this shows the range
              on offer rather than a number that describes no particular payment. */}
          <Metric
            label="Per referral"
            value={
              data.stats.commissionTiersPennies?.length
                ? `${formatPennies(Math.min(...data.stats.commissionTiersPennies))}–${formatPennies(Math.max(...data.stats.commissionTiersPennies))}`
                : '—'
            }
            caption="chosen per referral by the practice"
          />
        </div>
      </Zone>

      <Zone label="Where they come from">
        <div className="zone-grid-wide">
          <FunnelReport
            key={`invites:${data.funnel.inviteSent}`}
            funnel={data.funnel}
            onChanged={loadAll}
            notify={notify}
          />
          <TopReferrers topReferrers={data.topReferrers} />
        </div>
      </Zone>

      <Zone label="Payouts">
        <div className="zone-grid-wide">
          <Levers
            key={`${data.settings.payout_threshold_pennies}:${data.settings.payout_expiry_days}`}
            settings={data.settings}
            onChanged={loadAll}
            notify={notify}
          />
        </div>
      </Zone>
    </>
  );
}
