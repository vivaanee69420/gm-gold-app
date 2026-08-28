import { useState } from 'react';
import { formatPennies, parseGBPToPennies } from '@gm-referral/shared/money';
import { formatCode } from '@gm-referral/shared/referral-code';
import { api } from '../api/client.js';
import { Card, ListRow } from './ui.jsx';

export default function PayoutQueue({ payouts, onChanged, notify }) {
  const [cancelDrafts, setCancelDrafts] = useState({}); // payoutId -> reason text
  const [amountDrafts, setAmountDrafts] = useState({}); // payoutId -> typed cash amount
  const open = payouts.filter((p) => p.status === 'open');
  const settled = payouts.filter((p) => p.status !== 'open');

  // Reception types what they physically handed over; it must match the request
  // exactly (FR-24) — no trusting the row figure alone.
  const markPaid = async (id, amountPennies) => {
    try {
      await api(`/admin/payouts/${id}/mark-paid`, { method: 'POST', body: { amountPennies } });
      setAmountDrafts((d) => {
        const { [id]: _dropped, ...rest } = d;
        return rest;
      });
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
        {open.map((p) => {
          const amountPennies = parseGBPToPennies(amountDrafts[p.id] ?? '');
          const canMarkPaid = Number.isInteger(amountPennies) && amountPennies > 0;
          return (
            <ListRow
              key={p.id}
              title={p.member}
              value={formatPennies(p.amount_pennies)}
              meta={`collecting at ${p.practice} · requested ${new Date(p.requested_at).toLocaleDateString('en-GB')}`}
            >
              <p className="meta">{p.phone} · {formatCode(p.referral_code)}</p>
              {p.credits?.length > 0 && (
                <ul className="credits-list">
                  {p.credits.map((c, i) => (
                    <li key={i}>{c.friend} · {formatPennies(c.amountPennies)} · {c.at}</li>
                  ))}
                </ul>
              )}
              <label htmlFor={`amount-${p.id}`}>Cash handed over (£)</label>
              <input
                id={`amount-${p.id}`}
                inputMode="decimal"
                value={amountDrafts[p.id] ?? ''}
                onChange={(e) => setAmountDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
              />
              <button className="btn-gold" disabled={!canMarkPaid} onClick={() => markPaid(p.id, amountPennies)}>
                Paid
              </button>
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
          );
        })}
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
