import { formatPennies } from '@gm-referral/shared/money';
import { api } from '../api/client.js';

export default function PayoutQueue({ payouts, onChanged, notify }) {
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

  return (
    <section className="card payouts">
      <h2>Payout requests</h2>
      {open.length === 0 && <p className="empty">No open requests.</p>}
      <ul>
        {open.map((p) => (
          <li key={p.id}>
            <div>
              <strong>{p.member}</strong>
              <span className="amount">{formatPennies(p.amount_pennies)}</span>
            </div>
            <p className="meta">collecting at {p.practice} · requested {new Date(p.requested_at).toLocaleDateString('en-GB')}</p>
            <button onClick={() => markPaid(p.id)}>Mark paid</button>
          </li>
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
    </section>
  );
}
