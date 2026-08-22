import { useState } from 'react';
import { REFERRAL_STATUSES } from '@gm-referral/shared/schemas';
import { api } from '../api/client.js';
import { Card } from './ui.jsx';

const LABELS = {
  new: 'New',
  contacted: 'Contacted',
  booked: 'Booked',
  attended: 'Attended',
  treatment_agreed: 'Treatment agreed',
  treatment_completed: 'Completed',
  lost: 'Lost',
};

export default function PipelineBoard({ referrals, onChanged, notify }) {
  const [lostDrafts, setLostDrafts] = useState({}); // referralId -> reason text

  const advance = async (id, status, lostReason) => {
    try {
      await api(`/admin/referrals/${id}/status`, {
        method: 'PATCH',
        body: lostReason === undefined ? { status } : { status, lostReason },
      });
      setLostDrafts((d) => {
        const { [id]: _dropped, ...rest } = d;
        return rest;
      });
      onChanged();
    } catch (err) {
      notify(err.code ?? 'status_update_failed');
    }
  };

  const pick = (referral, status) => {
    if (status === referral.status) return;
    if (status === 'lost') {
      setLostDrafts((d) => ({ ...d, [referral.id]: '' }));
      return;
    }
    setLostDrafts((d) => {
      const { [referral.id]: _dropped, ...rest } = d;
      return rest;
    });
    advance(referral.id, status);
  };

  return (
    <Card title="Pipeline" count={referrals.length} className="pipeline">
      {referrals.length === 0 && <p className="empty">No referrals yet.</p>}
      <div className="pipeline-groups">
        {REFERRAL_STATUSES.map((status) => {
          const group = referrals.filter((r) => r.status === status);
          if (group.length === 0) return null;
          return (
            <div className="pipeline-group" key={status}>
              <h4>
                {LABELS[status]} <span className="count">{group.length}</span>
              </h4>
              <ul>
                {group.map((r) => (
                  <li key={r.id}>
                    <div>
                      <strong>{r.referred_name}</strong>
                      <span className="meta">{r.treatment_interest} · {r.practice}</span>
                    </div>
                    <p className="meta">referred by {r.referrer} · {r.referred_phone}</p>
                    <select
                      aria-label={`Status for ${r.referred_name}`}
                      value={status === r.status && lostDrafts[r.id] === undefined ? r.status : 'lost'}
                      onChange={(e) => pick(r, e.target.value)}
                    >
                      {REFERRAL_STATUSES.map((s) => (
                        <option key={s} value={s}>{LABELS[s]}</option>
                      ))}
                    </select>
                    {lostDrafts[r.id] !== undefined && (
                      <span className="lost-confirm">
                        <label htmlFor={`lost-${r.id}`}>Lost reason for {r.referred_name}</label>
                        <input
                          id={`lost-${r.id}`}
                          value={lostDrafts[r.id]}
                          onChange={(e) => setLostDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                        />
                        <button className="btn-primary" onClick={() => advance(r.id, 'lost', lostDrafts[r.id])}>Confirm lost</button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
