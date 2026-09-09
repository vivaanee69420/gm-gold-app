-- Anyone can refer (product decision 2026-09-09). Referrer verification is gone.
--
-- The old rule (FR-05) was that a referrer had to be an existing GM Dental patient, proved by
-- matching their phone against Dentally. That is not the product: you download the app, you
-- sign up, you refer. Worth recording that it never actually gated anything either — an
-- unverified referrer earned exactly like a verified one, and the only real control was an
-- admin manually rejecting someone, which deactivated their code.
--
-- The Dentally check that matters is on the REFERRED person: their phone is what confirms the
-- booking and the treatment, and that is what releases commission. That path is untouched.

-- Nobody is "awaiting review" any more, so nobody should be shown as such. Rows sitting at
-- pending_review were waiting on a queue that no longer exists.
update users set verification_status = 'verified'
 where verification_status in ('unverified', 'pending_review');

-- 'rejected' is deliberately NOT swept up. An admin rejected those people on purpose and
-- their referral codes were deactivated; silently reinstating them here would undo a human
-- decision as a side effect of a schema migration. Reactivate by hand if that was wrong.

-- The column itself stays for now rather than being dropped:
--   * events rows reference these states in their history, and the audit log is append-only
--     (NFR-03) — dropping the column would leave that history describing a field that no
--     longer exists
--   * `rejected` is still meaningful as a manual ban, which is the one piece of the old
--     system worth keeping
-- Nothing in the API reads it any more except to write 'verified'. See TODOS.md if you want
-- it gone properly.
comment on column users.verification_status is
  'Legacy (FR-05). Referrer verification was removed 2026-09-09 — anyone can refer. Retained '
  'because the append-only events log references these states, and because ''rejected'' still '
  'works as a manual ban that deactivates a referral code.';

comment on column users.dentally_patient_id is
  'Legacy: set by the old referrer verification. Nothing reads it. The Dentally link that '
  'matters lives on the REFERRED side, matched from referrals.referred_phone by the sync.';
