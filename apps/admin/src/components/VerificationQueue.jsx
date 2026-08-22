import { api } from '../api/client.js';
import { Card, ListRow } from './ui.jsx';

export default function VerificationQueue({ verifications, onChanged, notify }) {
  const decide = async (id, action) => {
    try {
      await api(`/admin/verifications/${id}/${action}`, { method: 'POST', body: {} });
      onChanged();
    } catch (err) {
      notify(err.code ?? 'verification_failed');
    }
  };

  return (
    <Card title="Verify referrers" count={verifications.length} className="verification-queue">
      {verifications.length === 0 && (
        <p className="empty">No one waiting. Numbers Dentally can't match cleanly land here.</p>
      )}
      <ul>
        {verifications.map((v) => (
          <ListRow
            key={v.id}
            title={`${v.first_name ?? '—'} ${v.last_name ?? ''}`.trim()}
            value={v.phone}
            meta={`signed up ${new Date(v.created_at).toLocaleDateString('en-GB')} · no clean Dentally match`}
          >
            <button className="btn-primary" onClick={() => decide(v.id, 'approve')}>Approve as patient</button>
            <button className="ghost" onClick={() => decide(v.id, 'reject')}>
              Reject
            </button>
          </ListRow>
        ))}
      </ul>
    </Card>
  );
}
