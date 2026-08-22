import { api } from '../api/client.js';
import { Card, ListRow } from './ui.jsx';

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
    <Card title="Confirm completions" count={proposals.length} className="confirm-queue">
      {proposals.length === 0 && (
        <p className="empty">Nothing waiting — Dentally proposes completed &amp; paid treatments here.</p>
      )}
      <ul>
        {proposals.map((p) => (
          <ListRow
            key={p.id}
            title={p.referred_name}
            value={p.invoice_state}
            meta={
              <>
                referred by {p.referrer} · {p.practice ?? 'practice unknown'} · matched {p.matched_phone}
                {p.review_status === 'existing_patient_suspect' && ' · ⚠ under review'}
              </>
            }
          >
            <button
              className="btn-primary"
              onClick={() => confirm(p.id)}
              disabled={p.review_status === 'existing_patient_suspect'}
            >
              Confirm — credit referrer
            </button>
            <button className="ghost" onClick={() => reject(p.id)}>
              Reject
            </button>
          </ListRow>
        ))}
      </ul>
    </Card>
  );
}
