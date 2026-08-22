import { useState } from 'react';
import { api } from '../api/client.js';
import { Card, ListRow } from './ui.jsx';

// FR-25/FR-28: the funnel with the tripwire metric on top. invite_sent is externally
// sourced (GHL campaigns) and hand-entered; share_tapped is shown but noisy —
// share-sheet opens are not messages sent, especially on iOS.
export default function FunnelReport({ funnel, onChanged, notify }) {
  const [invites, setInvites] = useState(String(funnel.inviteSent ?? 0));

  const saveInvites = async (e) => {
    e.preventDefault();
    const n = Number(invites);
    if (!Number.isSafeInteger(n) || n < 0) return notify('validation');
    try {
      await api('/admin/settings', { method: 'PUT', body: { invite_sent_manual_count: n } });
      onChanged();
    } catch (err) {
      notify(err.code ?? 'save_failed');
    }
  };

  const steps = [
    ['App activated', funnel.appActivated],
    ['Share tapped', funnel.shareTapped, 'noisy — share-sheet opens, not messages sent'],
    ['Code entered', funnel.codeEntered],
    ['Referral submitted', funnel.referralSubmitted],
    ['Consult booked', funnel.consultBooked],
    ['Treatment completed', funnel.treatmentCompleted],
    ['Commissions credited', funnel.commissionsCredited],
    ['Payouts collected', funnel.payoutsPaid],
  ];
  const max = Math.max(...steps.map(([, value]) => value ?? 0), 1);
  const hasAny = steps.some(([, value]) => (value ?? 0) > 0);

  return (
    <Card title="Funnel" className="funnel">
      <div className="stat">
        <p className="stat-label">Tripwire · code → submitted</p>
        <p className="stat-value">
          {funnel.tripwireRate == null ? '—' : `${Math.round(funnel.tripwireRate * 100)}%`}
        </p>
        <p className="meta">
          {funnel.tripwireRate == null
            ? 'waiting on code_entered events from the store builds'
            : 'a collapsing rate triggers the web-form fallback decision (DESIGN.md)'}
        </p>
      </div>
      <ul className="funnel-steps">
        {steps.map(([label, value, note]) => (
          <ListRow key={label} title={label} value={value} meta={note}>
            {hasAny && (
              <div
                className={value ? 'funnel-bar' : 'funnel-bar funnel-bar-zero'}
                style={{ width: `${Math.max(((value ?? 0) / max) * 100, 1)}%` }}
              />
            )}
          </ListRow>
        ))}
      </ul>
      <form className="invites-form" onSubmit={saveInvites}>
        <div className="invites-line">
          <div>
            <label htmlFor="invite-count">Invites sent (manual)</label>
            <input
              id="invite-count"
              inputMode="numeric"
              value={invites}
              onChange={(e) => setInvites(e.target.value)}
            />
          </div>
          <button type="submit" className="ghost">Save</button>
        </div>
        <p className="meta">entered by hand from GHL campaign counts — CSV upload is Phase 2</p>
      </form>
    </Card>
  );
}
