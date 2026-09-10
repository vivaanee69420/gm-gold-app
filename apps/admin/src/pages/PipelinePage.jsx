import PipelineBoard from '../components/PipelineBoard.jsx';
import StatsStrip from '../components/StatsStrip.jsx';

// The pipeline is the manager's main screen and one of the owner's, so it is its own page
// rather than a card buried in Operations.
export default function PipelinePage({ data, loadAll, patchReferral, notify }) {
  return (
    <>
      <StatsStrip stats={data.stats} />
      <PipelineBoard
        referrals={data.referrals}
        onMoved={(id, status) => patchReferral(id, { status })}
        onCardEdited={patchReferral}
        onChanged={loadAll}
        notify={notify}
      />
    </>
  );
}
