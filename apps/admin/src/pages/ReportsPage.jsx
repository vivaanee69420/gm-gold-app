import Levers from '../components/Levers.jsx';
import FunnelReport from '../components/FunnelReport.jsx';
import TopReferrers from '../components/TopReferrers.jsx';
import { Zone } from '../components/ui.jsx';

// Team and the Dentally connection moved to Settings; what is left here is the scheme's
// performance and the one lever that changes it.
export default function ReportsPage({ data, loadAll, notify }) {
  return (
    <>
      <Zone label="Reports">
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
      <Zone label="Rewards">
        <div className="zone-grid-wide">
          <Levers
            key={`${data.stats.commissionPennies}:${data.settings.payout_threshold_pennies}:${data.settings.payout_expiry_days}`}
            commissionPennies={data.stats.commissionPennies}
            settings={data.settings}
            onChanged={loadAll}
            notify={notify}
          />
        </div>
      </Zone>
    </>
  );
}
