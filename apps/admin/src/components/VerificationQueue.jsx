import { api } from '../api/client.js';
import { Card, ListRow } from './ui.jsx';

// Verification is a two-key match now: the patient's verified EMAIL and the phone they typed
// must both land on the same Dental OS contact. So "pending" covers four different situations
// that need four different actions, and you cannot tell them apart by looking at the patient.
//
// Naming the action matters most for email_unconfirmed: that one resolves ITSELF once the
// address is on the contact, so the right move is to fix Dental OS and walk away, not to
// click Approve. Approving instead marks them verified without the second key ever matching,
// which quietly throws away the fraud check.
const REASONS = {
  email_unconfirmed: {
    label: 'Email missing in Dental OS',
    action: 'Their phone matches, but their Dental OS contact has no email (or a different one). '
      + 'Add their address there — the next sync verifies them automatically, no need to approve here.',
    tone: 'fixable',
  },
  phone_unconfirmed: {
    label: 'Phone not on their record',
    action: 'Their email matches, but the number they typed is not on that Dental OS contact. '
      + 'Check which number the practice holds for them.',
    tone: 'check',
  },
  ambiguous_match: {
    label: 'Two records matched',
    action: 'Their phone and email point at different Dental OS contacts, or the number is shared '
      + 'with a family member. Confirm who they are before approving.',
    tone: 'care',
  },
  no_match: {
    label: 'No Dentally record',
    action: 'Nothing in Dental OS matches either key. They may not be a patient here, or Dentally '
      + 'was unreachable when they signed up.',
    tone: 'check',
  },
  phone_missing: {
    label: 'No phone on file',
    action: 'They have not completed their profile, so there is no number to match on yet.',
    tone: 'check',
  },
};

const FALLBACK = { label: 'Needs review', action: 'No clean Dentally match.', tone: 'check' };

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
        <p className="empty">No one waiting. Referrers we can&rsquo;t match to a Dentally record land here.</p>
      )}
      <ul>
        {verifications.map((v) => {
          const reason = REASONS[v.reason] ?? FALLBACK;
          return (
            <ListRow
              key={v.id}
              title={`${v.first_name ?? '—'} ${v.last_name ?? ''}`.trim()}
              value={v.phone ?? '—'}
              meta={`${v.email ?? 'no email'} · signed up ${new Date(v.created_at).toLocaleDateString('en-GB')}`}
            >
              <span className={`verify-reason verify-reason--${reason.tone}`}>{reason.label}</span>
              <p className="verify-action">{reason.action}</p>
              <button className="btn-primary" onClick={() => decide(v.id, 'approve')}>Approve as patient</button>
              <button className="ghost" onClick={() => decide(v.id, 'reject')}>
                Reject
              </button>
            </ListRow>
          );
        })}
      </ul>
    </Card>
  );
}
