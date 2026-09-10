import ConfirmQueue from '../components/ConfirmQueue.jsx';
import AgingReport from '../components/AgingReport.jsx';
import ReferralReviewQueue from '../components/ReferralReviewQueue.jsx';
import ReferralRecord from '../components/ReferralRecord.jsx';
import { Zone } from '../components/ui.jsx';

export default function OperationsPage({ data, loadAll, notify }) {
  return (
    <>
      <Zone label="Needs attention">
        <div className="zone-grid">
          <ConfirmQueue proposals={data.proposals} onChanged={loadAll} notify={notify} />
          <ReferralReviewQueue reviews={data.reviews} onChanged={loadAll} notify={notify} />
          <AgingReport aging={data.aging} days={data.agingDays} />
        </div>
      </Zone>
      <ReferralRecord referrals={data.referrals} />
    </>
  );
}
