import { api } from '../api/client.js';

export default function ConfirmQueue({ proposals, onChanged, notify }) {
  const confirm = async (id) => {
    try {
      await api(`/admin/proposals/${id}/confirm`, { method: 'POST' });
      onChanged();
    } catch (err) {
      notify(err.code ?? 'confirm_failed');
    }
  };

  const reject = async (id) => {
    const reason = window.prompt('Why is this proposal wrong? (required)');
    if (!reason) return;
    try {
      await api(`/admin/proposals/${id}/reject`, { method: 'POST', body: { reason } });
      onChanged();
    } catch (err) {
      notify(err.code ?? 'reject_failed');
    }
  };

  return (
    <section className="card confirm-queue">
      <h2>Confirm completions</h2>
      {proposals.length === 0 && (
        <p className="empty">Nothing waiting — Dentally proposes completed &amp; paid treatments here.</p>
      )}
      <ul>
        {proposals.map((p) => (
          <li key={p.id}>
            <div>
              <strong>{p.referred_name}</strong>
              <span className="amount">{p.invoice_state}</span>
            </div>
            <p className="meta">
              referred by {p.referrer} · {p.practice ?? 'practice unknown'} · matched {p.matched_phone}
              {p.review_status === 'existing_patient_suspect' && ' · ⚠ under review'}
            </p>
            <button onClick={() => confirm(p.id)} disabled={p.review_status === 'existing_patient_suspect'}>
              Confirm — credit referrer
            </button>
            <button className="ghost" onClick={() => reject(p.id)}>
              Reject
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
