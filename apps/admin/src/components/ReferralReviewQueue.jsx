import { api } from '../api/client.js';

// FR-25: referrals flagged existing_patient_suspect. Clear keeps the pipeline open;
// confirming an existing patient marks the referral lost — never creditable.
export default function ReferralReviewQueue({ reviews, onChanged, notify }) {
  const decide = async (id, decision) => {
    try {
      await api(`/admin/referral-review/${id}/decide`, { method: 'POST', body: { decision } });
      onChanged();
    } catch (err) {
      notify(err.code ?? 'review_failed');
    }
  };

  return (
    <section className="card referral-review">
      <h2>Existing-patient review</h2>
      {reviews.length === 0 && (
        <p className="empty">Nothing flagged. Referrals whose phone already matches a patient land here.</p>
      )}
      <ul>
        {reviews.map((r) => (
          <li key={r.id}>
            <div>
              <strong>{r.referred_name}</strong>
              <span className="amount">{r.referred_phone}</span>
            </div>
            <p className="meta">
              referred by {r.referrer} · {r.practice ?? 'any practice'} ·{' '}
              {new Date(r.created_at).toLocaleDateString('en-GB')}
            </p>
            <button onClick={() => decide(r.id, 'clear')}>Genuinely new — clear</button>
            <button className="ghost" onClick={() => decide(r.id, 'existing_patient')}>
              Existing patient — mark lost
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
