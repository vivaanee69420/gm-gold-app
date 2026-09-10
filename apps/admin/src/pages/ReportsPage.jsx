import Levers from '../components/Levers.jsx';
import DentallyCard from '../components/DentallyCard.jsx';
import FunnelReport from '../components/FunnelReport.jsx';
import TopReferrers from '../components/TopReferrers.jsx';
import TeamCard from '../components/TeamCard.jsx';
import { Zone } from '../components/ui.jsx';

export default function ReportsPage({ data, loadAll, notify, me }) {
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
      <Zone label="Setup">
        <div className="zone-grid-wide">
          <Levers
            key={`${data.stats.commissionPennies}:${data.settings.payout_threshold_pennies}:${data.settings.payout_expiry_days}`}
            commissionPennies={data.stats.commissionPennies}
            settings={data.settings}
            onChanged={loadAll}
            notify={notify}
          />
          <DentallyCard status={data.dentally} onChanged={loadAll} notify={notify} />
        </div>
      </Zone>
      {/* Its own full-width zone: the team table carries an email, a practice picker, three
          tab checkboxes and two destructive controls per row, and none of that fits in half
          a page beside another card. */}
      {me?.role === 'admin' && (
        <Zone label="Accounts">
          <TeamCard practices={me.practices} meId={me.id} notify={notify} />
        </Zone>
      )}
    </>
  );
}
