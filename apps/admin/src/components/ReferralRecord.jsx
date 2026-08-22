import { useMemo, useState } from 'react';
import { formatPennies } from '@gm-referral/shared/money';
import { Card } from './ui.jsx';

const STATUS_LABELS = {
  new: 'New',
  contacted: 'Contacted',
  booked: 'Booked',
  attended: 'Attended',
  treatment_agreed: 'Treatment agreed',
  treatment_completed: 'Completed',
  lost: 'Lost',
};

// The register: every referred person, who referred them (name, phone, code used),
// and whether the commission has been credited. This is the audit trail behind
// "this person was referred by this referrer, pay them when treatment completes".
export default function ReferralRecord({ referrals }) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return referrals;
    return referrals.filter((r) =>
      [r.referred_name, r.referred_phone, r.referrer, r.referrer_phone, r.referrer_code, r.practice]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q)),
    );
  }, [referrals, query]);

  return (
    <Card title="Referral record" count={referrals.length} className="referral-record">
      {referrals.length === 0 ? (
        <p className="empty">No referrals yet — every friend who joins with a member's code appears here.</p>
      ) : (
        <>
          <input
            type="search"
            className="record-search"
            placeholder="Search by name, phone, or code…"
            aria-label="Search referral record"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="record-scroll">
            <table className="record-table">
              <thead>
                <tr>
                  <th scope="col">Referred friend</th>
                  <th scope="col">Referred by</th>
                  <th scope="col">Code used</th>
                  <th scope="col">Practice · interest</th>
                  <th scope="col">Date</th>
                  <th scope="col">Status</th>
                  <th scope="col">Commission</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.referred_name}</strong>
                      <p className="meta">{r.referred_phone}</p>
                    </td>
                    <td>
                      <strong>{r.referrer}</strong>
                      <p className="meta">{r.referrer_phone}</p>
                    </td>
                    <td>
                      <span className="record-code">{r.referrer_code ?? '—'}</span>
                      {r.source === 'qr' && <p className="meta">scanned</p>}
                    </td>
                    <td>
                      {r.practice ?? 'any practice'}
                      <p className="meta">{r.treatment_interest?.replaceAll('_', ' ')}</p>
                    </td>
                    <td>{r.created_at}</td>
                    <td>
                      <span className={`chip chip-status-${r.status}`}>{STATUS_LABELS[r.status] ?? r.status}</span>
                    </td>
                    <td>
                      {r.commission_pennies != null ? (
                        <>
                          <span className="amount record-credited">{formatPennies(r.commission_pennies)}</span>
                          <p className="meta">credited {r.commission_at}</p>
                        </>
                      ) : r.status === 'treatment_completed' ? (
                        <span className="record-due">due</span>
                      ) : (
                        <span className="meta">—</span>
                      )}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="empty">
                      No matches for “{query}”.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
