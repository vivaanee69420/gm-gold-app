import { useState } from 'react';
import { formatPennies } from '@gm-referral/shared/money';
import { api } from '../api/client.js';
import { Card, ListRow } from './ui.jsx';

export default function PayoutQueue({ payouts, onChanged, notify }) {
  const [cancelDrafts, setCancelDrafts] = useState({}); // payoutId -> reason text
  const open = payouts.filter((p) => p.status === 'open');
  const settled = payouts.filter((p) => p.status !== 'open');

  const markPaid = async (id) => {
    try {
      await api(`/admin/payouts/${id}/mark-paid`, { method: 'POST' });
      onChanged();
    } catch (err) {
      notify(err.code ?? 'mark_paid_failed');
    }
  };

  // FR-21: admin cancel requires a reason; the member keeps their balance.
  const cancel = async (id) => {
    try {
      await api(`/admin/payouts/${id}/cancel`, { method: 'POST', body: { reason: cancelDrafts[id] } });
      setCancelDrafts((d) => {
        const { [id]: _dropped, ...rest } = d;
        return rest;
      });
      onChanged();
    } catch (err) {
      notify(err.code ?? 'cancel_failed');
    }
  };

  return (
    <Card title="Payout requests" count={open.length} className="payouts">
      {open.length === 0 && <p className="empty">No open requests.</p>}
      <ul>
        {open.map((p) => (
          <ListRow
            key={p.id}
            title={p.member}
            value={formatPennies(p.amount_pennies)}
            meta={`collecting at ${p.practice} · requested ${new Date(p.requested_at).toLocaleDateString('en-GB')}`}
          >
            <button className="btn-gold" onClick={() => markPaid(p.id)}>Mark paid</button>
            {cancelDrafts[p.id] === undefined ? (
              <button className="ghost" onClick={() => setCancelDrafts((d) => ({ ...d, [p.id]: '' }))}>
                Cancel…
              </button>
            ) : (
              <span className="lost-confirm">
                <label htmlFor={`cancel-${p.id}`}>Cancel reason for {p.member}</label>
                <input
                  id={`cancel-${p.id}`}
                  value={cancelDrafts[p.id]}
                  onChange={(e) => setCancelDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                />
                <button className="btn-primary" onClick={() => cancel(p.id)}>Confirm cancel</button>
              </span>
            )}
          </ListRow>
        ))}
      </ul>
      {settled.length > 0 && (
        <details>
          <summary>Settled ({settled.length})</summary>
          <ul>
            {settled.map((p) => (
              <li key={p.id}>
                <strong>{p.member}</strong> <span className="amount">{formatPennies(p.amount_pennies)}</span>
                <span className={`chip chip-${p.status}`}>{p.status}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
