import { api } from '../api/client.js';

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
    <section className="card verification-queue">
      <h2>Verify referrers</h2>
      {verifications.length === 0 && (
        <p className="empty">No one waiting. Numbers Dentally can't match cleanly land here.</p>
      )}
      <ul>
        {verifications.map((v) => (
          <li key={v.id}>
            <div>
              <strong>
                {v.first_name ?? '—'} {v.last_name ?? ''}
              </strong>
              <span className="amount">{v.phone}</span>
            </div>
            <p className="meta">signed up {new Date(v.created_at).toLocaleDateString('en-GB')} · no clean Dentally match</p>
            <button onClick={() => decide(v.id, 'approve')}>Approve as patient</button>
            <button className="ghost" onClick={() => decide(v.id, 'reject')}>
              Reject
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
