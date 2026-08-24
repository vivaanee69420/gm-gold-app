import ConfirmQueue from '../components/ConfirmQueue.jsx';
import VerificationQueue from '../components/VerificationQueue.jsx';
import AgingReport from '../components/AgingReport.jsx';
import PayoutQueue from '../components/PayoutQueue.jsx';
import PipelineBoard from '../components/PipelineBoard.jsx';
import StatsStrip from '../components/StatsStrip.jsx';
import ReferralReviewQueue from '../components/ReferralReviewQueue.jsx';
import ReferralRecord from '../components/ReferralRecord.jsx';
import { Zone } from '../components/ui.jsx';

export default function OperationsPage({ data, loadAll, notify }) {
  return (
    <>
      <StatsStrip stats={data.stats} />
      <Zone label="Needs attention">
        <div className="zone-grid">
          <ConfirmQueue proposals={data.proposals} onChanged={loadAll} notify={notify} />
          <PayoutQueue payouts={data.payouts} onChanged={loadAll} notify={notify} />
          <VerificationQueue verifications={data.verifications} onChanged={loadAll} notify={notify} />
          <ReferralReviewQueue reviews={data.reviews} onChanged={loadAll} notify={notify} />
          <AgingReport aging={data.aging} days={data.agingDays} />
        </div>
      </Zone>
      <PipelineBoard referrals={data.referrals} onChanged={loadAll} notify={notify} />
      <ReferralRecord referrals={data.referrals} />
    </>
  );
}
