import { formatPennies } from '@gm-referral/shared/money';
import { Card, ListRow } from './ui.jsx';

export default function TopReferrers({ topReferrers }) {
  return (
    <Card title="Top referrers" count={topReferrers.length} className="top-referrers">
      {topReferrers.length === 0 && <p className="empty">No referrals yet.</p>}
      <ul>
        {topReferrers.map((r) => (
          <ListRow
            key={r.id}
            title={r.name}
            value={formatPennies(r.credited_pennies)}
            meta={`${r.completed} completed of ${r.referrals} referred`}
          />
        ))}
      </ul>
    </Card>
  );
}
