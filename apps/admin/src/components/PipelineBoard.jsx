import { useRef, useState } from 'react';
import { REFERRAL_STATUSES } from '@gm-referral/shared/schemas';
import { api } from '../api/client.js';
import { Card } from './ui.jsx';

const LABELS = {
  new: 'New',
  contacted: 'Contacted',
  booked: 'Booked',
  attended: 'Attended',
  treatment_agreed: 'Treatment agreed',
  treatment_started: 'Treatment started',
  treatment_completed: 'Completed',
  lost: 'Lost',
};

// Moving a card here credits the referrer's wallet — real money, and irreversible from this
// screen. It is the only transition that takes a second, deliberate click, shown inline
// (never window.confirm — a browser dialog would block the whole tab).
const CREDITS_COMMISSION = 'treatment_started';

// How long the "card settles into its new column" animation runs. Only a card the user just
// moved gets this class, and only for this long — never the initial board render — so motion
// answers an action instead of decorating a page load.
const SETTLE_MS = 200;

export default function PipelineBoard({ referrals, onChanged, notify }) {
  const [lostDrafts, setLostDrafts] = useState({}); // referralId -> reason text
  const [creditDrafts, setCreditDrafts] = useState({}); // referralId -> true while confirming
  const [overrides, setOverrides] = useState({}); // referralId -> status, optimistic until it fails
  const [settling, setSettling] = useState({}); // referralId -> true briefly after it lands
  const settleTimers = useRef({});
  const draggedId = useRef(null);

  const statusOf = (r) => overrides[r.id] ?? r.status;

  const clear = (setter, id) => setter((d) => {
    const { [id]: _dropped, ...rest } = d;
    return rest;
  });

  const markSettling = (id) => {
    setSettling((s) => ({ ...s, [id]: true }));
    clearTimeout(settleTimers.current[id]);
    settleTimers.current[id] = setTimeout(() => clear(setSettling, id), SETTLE_MS);
  };

  // Moves the card now, then reconciles with the server. A failure walks it back to where it
  // actually was and explains why — money didn't move, so the board shouldn't say it did.
  const advance = async (referral, status, lostReason) => {
    const previousStatus = statusOf(referral);
    setOverrides((o) => ({ ...o, [referral.id]: status }));
    markSettling(referral.id);
    clear(setLostDrafts, referral.id);
    clear(setCreditDrafts, referral.id);
    try {
      await api(`/admin/referrals/${referral.id}/status`, {
        method: 'PATCH',
        body: lostReason === undefined ? { status } : { status, lostReason },
      });
      onChanged();
    } catch (err) {
      setOverrides((o) => ({ ...o, [referral.id]: previousStatus }));
      markSettling(referral.id);
      notify(err.code === 'not_found' ? 'referral_not_found' : err.code ?? 'status_update_failed');
    }
  };

  const pick = (referral, status) => {
    if (status === statusOf(referral)) return;
    if (status === 'lost') {
      clear(setCreditDrafts, referral.id);
      setLostDrafts((d) => ({ ...d, [referral.id]: '' }));
      return;
    }
    if (status === CREDITS_COMMISSION) {
      clear(setLostDrafts, referral.id);
      setCreditDrafts((d) => ({ ...d, [referral.id]: true }));
      return;
    }
    clear(setLostDrafts, referral.id);
    clear(setCreditDrafts, referral.id);
    advance(referral, status);
  };

  // What the <select> shows while a lost reason or a commission credit is still being decided —
  // the referral hasn't actually moved yet, but the control needs to reflect the pending choice
  // instead of snapping back to the current status.
  const displayValue = (r) => {
    if (lostDrafts[r.id] !== undefined) return 'lost';
    if (creditDrafts[r.id]) return CREDITS_COMMISSION;
    return statusOf(r);
  };

  const dropOnto = (status) => (e) => {
    e.preventDefault();
    const id = e.dataTransfer?.getData('text/plain') || draggedId.current;
    draggedId.current = null;
    const referral = referrals.find((r) => r.id === id);
    if (referral) pick(referral, status);
  };

  return (
    <Card title="Pipeline" count={referrals.length} className="pipeline">
      {referrals.length === 0 && <p className="empty">No referrals yet.</p>}
      <div className="pipeline-groups">
        {REFERRAL_STATUSES.map((status) => {
          const group = referrals.filter((r) => statusOf(r) === status);
          return (
            <div
              className="pipeline-group"
              data-stage={status}
              key={status}
              onDragOver={(e) => e.preventDefault()}
              onDrop={dropOnto(status)}
            >
              <h4>
                {LABELS[status]} <span className="count">{group.length}</span>
              </h4>
              {group.length === 0 && <p className="empty">—</p>}
              <ul>
                {group.map((r) => (
                  <li
                    key={r.id}
                    className={settling[r.id] ? 'is-settling' : undefined}
                    draggable
                    onDragStart={(e) => {
                      draggedId.current = r.id;
                      e.dataTransfer?.setData('text/plain', r.id);
                      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                    }}
                  >
                    <div>
                      <strong>{r.referred_name}</strong>
                      <span className="meta">{r.treatment_interest} · {r.practice}</span>
                    </div>
                    <p className="meta">referred by {r.referrer} · {r.referred_phone}</p>
                    <select
                      aria-label={`Status for ${r.referred_name}`}
                      value={displayValue(r)}
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
                        <button className="btn-primary" onClick={() => advance(r, 'lost', lostDrafts[r.id])}>
                          Confirm lost
                        </button>
                      </span>
                    )}
                    {creditDrafts[r.id] && (
                      <span className="credit-confirm">
                        <span className="meta">
                          This credits {r.referrer}'s commission and can't be undone here.
                        </span>
                        <button className="btn-primary" onClick={() => advance(r, CREDITS_COMMISSION)}>
                          Credit {r.referrer}'s commission
                        </button>
                        <button className="ghost" onClick={() => clear(setCreditDrafts, r.id)}>
                          Cancel
                        </button>
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
