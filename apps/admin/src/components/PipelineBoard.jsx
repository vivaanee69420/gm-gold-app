import { useEffect, useRef, useState } from 'react';
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

// Moving a card to EITHER of these credits the referrer's wallet — real money, and irreversible
// from this screen. updateStatus (referralService.js) credits on treatment_started OR
// treatment_completed (the "at or past" rule, so a privileged jump straight to Completed still
// pays), and every status here renders as both a droppable column and a <select> option — so a
// one-click move straight to Completed must raise the same confirm as treatment_started, or it's
// a bypass. Both take a second, deliberate click, shown inline (never window.confirm — a browser
// dialog would block the whole tab).
const CREDITS_COMMISSION = new Set(['treatment_started', 'treatment_completed']);

// How long the "card settles into its new column" animation runs. Only a card the user just
// moved gets this class, and only for this long — never the initial board render — so motion
// answers an action instead of decorating a page load.
const SETTLE_MS = 200;

export default function PipelineBoard({ referrals, onChanged, notify }) {
  const [lostDrafts, setLostDrafts] = useState({}); // referralId -> reason text
  const [creditDrafts, setCreditDrafts] = useState({}); // referralId -> the target crediting status while confirming
  const [overrides, setOverrides] = useState({}); // referralId -> { status, from }, optimistic until it fails
  const [settling, setSettling] = useState({}); // referralId -> true briefly after it lands
  const settleTimers = useRef({});
  const draggedId = useRef(null);
  const requestTokens = useRef({}); // referralId -> the latest advance() call's token

  const statusOf = (r) => overrides[r.id]?.status ?? r.status;

  const clear = (setter, id) => setter((d) => {
    const { [id]: _dropped, ...rest } = d;
    return rest;
  });

  const markSettling = (id) => {
    setSettling((s) => ({ ...s, [id]: true }));
    clearTimeout(settleTimers.current[id]);
    settleTimers.current[id] = setTimeout(() => clear(setSettling, id), SETTLE_MS);
  };

  // Clear every pending settle timer on unmount, rather than letting them fire setState calls
  // against a component that's gone.
  useEffect(() => () => {
    Object.values(settleTimers.current).forEach(clearTimeout);
  }, []);

  // An override exists only to cover the gap between the click and the refetch. It records
  // `from` — the prop status we saw at the moment we set it — so this effect can tell "the
  // incoming props just haven't caught up yet" (fresh still equals `from`: keep showing our
  // optimistic value, or the board would flicker back before flickering forward again) apart
  // from "the props moved on" (fresh differs from `from` — whether because our own change
  // landed, or because a colleague's move or the Dentally sync got there first: either way,
  // props are the truth now and the override has done its job). Comparing against the
  // override's own target status instead of `from` would under-prune: it would drop once our
  // own change is confirmed, but keep shadowing a *different* incoming status forever, which is
  // exactly the bug this effect exists to fix.
  useEffect(() => {
    setOverrides((current) => {
      const pruned = Object.fromEntries(
        Object.entries(current).filter(([id, entry]) => {
          const fresh = referrals.find((r) => r.id === id);
          return fresh && fresh.status === entry.from;
        }),
      );
      return Object.keys(pruned).length === Object.keys(current).length ? current : pruned;
    });
  }, [referrals]);

  // Moves the card now, then reconciles with the server. A failure walks it back to where it
  // actually was and explains why — money didn't move, so the board shouldn't say it did.
  const advance = async (referral, status, lostReason) => {
    const previousStatus = statusOf(referral);
    // Stamped so a stale response can tell it's been superseded — see the catch below.
    const token = Symbol();
    requestTokens.current[referral.id] = token;
    setOverrides((o) => ({ ...o, [referral.id]: { status, from: referral.status } }));
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
      // A later move for this same card already started (or already succeeded) — this failure
      // belongs to a request the board has moved on from, so it must not roll back what
      // replaced it. It fails silently; the newer request's own outcome is what the board shows.
      if (requestTokens.current[referral.id] !== token) return;
      setOverrides((o) => ({ ...o, [referral.id]: { status: previousStatus, from: referral.status } }));
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
    if (CREDITS_COMMISSION.has(status)) {
      clear(setLostDrafts, referral.id);
      setCreditDrafts((d) => ({ ...d, [referral.id]: status }));
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
    if (creditDrafts[r.id]) return creditDrafts[r.id];
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
                        <button className="btn-primary" onClick={() => advance(r, creditDrafts[r.id])}>
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
