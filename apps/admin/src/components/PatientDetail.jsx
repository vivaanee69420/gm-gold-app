import { useEffect, useRef } from 'react';
import { formatPennies } from '@gm-referral/shared/money';
import { errorMessage } from '../copy.js';

export const STATUS_LABELS = {
  new: 'New',
  contacted: 'Contacted',
  booked: 'Booked',
  attended: 'Attended',
  treatment_agreed: 'Treatment agreed',
  treatment_started: 'Treatment started',
  treatment_completed: 'Completed',
  lost: 'Lost',
};

const when = (iso) =>
  iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

const label = (status) => STATUS_LABELS[status] ?? status;

/** Who did this — plain words, never a raw actor_kind/null pair. */
function who(entry) {
  if (entry.actorEmail) return entry.actorEmail;
  if (entry.actorKind === 'system') return 'the Dentally sync';
  if (entry.actorKind === 'admin') return 'an admin';
  if (entry.actorKind === 'user') return 'the patient';
  return 'someone';
}

// Reasons are written for an audit log, not a receptionist. Translate the sync's internal
// codes into English; a lost reason (typed by staff) is already plain text and passes through.
function reason(entry) {
  if (!entry.reason) return null;
  if (entry.reason.startsWith('dentally appointment-')) return null; // redundant with who() above
  if (entry.reason.startsWith('booking_window_expired_')) {
    const hours = entry.reason.replace('booking_window_expired_', '').replace(/h$/, '');
    return `No booking within ${hours} hours of the referral.`;
  }
  if (entry.reason.startsWith('privileged (skipped from')) {
    return 'Marked complete directly from Dentally, skipping the stages in between.';
  }
  return entry.reason;
}

/** "New → Booked" for a status move, plain sentences for everything else. */
function what(entry) {
  if (entry.action === 'status_changed') {
    return `${entry.from ? label(entry.from) : 'Start'} → ${label(entry.to)}`;
  }
  if (entry.action === 'practice_reassigned') return 'Practice reassigned';
  if (entry.action === 'created') return 'Referral submitted';
  return entry.action.replaceAll('_', ' ');
}

function detailErrorMessage(code) {
  // "That account no longer exists" is copy.js's generic 404 line, written for admin accounts —
  // wrong noun for a patient row, so this screen gets its own.
  if (code === 'not_found') {
    return "This patient's record couldn't be found — it may have been moved to another practice.";
  }
  return errorMessage(code);
}

function PatientDetailBody({ detail }) {
  const { patient, referrer, practice, appointment, commission, timeline } = detail;
  const bothPractices = Boolean(practice.chosen && practice.booked && practice.chosen !== practice.booked);
  const practiceLine = practice.booked ?? practice.chosen ?? '—';

  return (
    <>
      <dl>
        <dt>Phone</dt>
        <dd>{patient.phone}</dd>
        <dt>Email</dt>
        <dd>{patient.email ?? '—'}</dd>
        <dt>Stage</dt>
        <dd>{label(patient.status)}</dd>
        <dt>Referred by</dt>
        <dd>
          {referrer.name}
          <p className="meta">{referrer.phone}</p>
          <span className="record-code">{referrer.code ?? '—'}</span>
        </dd>
        <dt>Referred on</dt>
        <dd>{when(patient.referredAt)}</dd>
        <dt>Practice</dt>
        <dd>
          {practiceLine}
          {bothPractices && <p className="meta">chose {practice.chosen} on the referral link</p>}
          {!bothPractices && !practice.booked && practice.chosen && <p className="meta">not yet booked</p>}
        </dd>
        <dt>Appointment</dt>
        <dd>
          {when(appointment.startsAt)}
          {appointment.dentallyId && <p className="meta">Dentally ref {appointment.dentallyId}</p>}
        </dd>
        <dt>Commission</dt>
        <dd>
          {commission.amountPennies != null ? (
            <>
              <span className="amount record-credited">{formatPennies(commission.amountPennies)}</span>
              <p className="meta">credited {when(commission.creditedAt)}</p>
            </>
          ) : (
            <span className="meta">not yet credited</span>
          )}
        </dd>
      </dl>

      <h4>History</h4>
      {timeline.length === 0 ? (
        <p className="empty">Nothing recorded yet.</p>
      ) : (
        <ol className="timeline">
          {timeline.map((entry, i) => (
            <li key={`${entry.at}-${i}`}>
              <span className="timeline-when">{when(entry.at)}</span>
              <span className="timeline-what">
                {what(entry)} · {who(entry)}
              </span>
              {reason(entry) && <p className="meta">{reason(entry)}</p>}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

// The panel behind a patient row. One landmark covers all three states it can be in — still
// fetching, failed, or loaded — so focus-on-open and Escape-to-close behave the same regardless
// of how the fetch went, and `name` (already known from the list row) gives it something to
// announce before the detail fetch has answered.
export default function PatientDetail({ name, detail, error, onClose, onRetry }) {
  const panelRef = useRef(null);

  // Runs once per mount: the caller keys this component on the open patient's id, so switching
  // to a different patient remounts it and focus moves again; re-fetching the *same* patient
  // (a retry) must not steal focus back out of whatever the person is doing.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const heading = detail?.patient?.name ?? name;

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      className="patient-detail"
      aria-label={`Details for ${heading}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <h3>{heading}</h3>
        <button className="ghost" onClick={onClose}>
          Close
        </button>
      </header>

      {error ? (
        <div className="patient-detail-error">
          <p>{detailErrorMessage(error)}</p>
          <button className="btn-primary" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : !detail ? (
        <p className="meta" aria-live="polite">
          Loading…
        </p>
      ) : (
        <PatientDetailBody detail={detail} />
      )}
    </aside>
  );
}
