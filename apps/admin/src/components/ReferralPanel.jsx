import { useEffect, useRef, useState } from 'react';
import { formatPennies } from '@gm-referral/shared/money';
import { api } from '../api/client.js';
import { STATUS_LABELS } from './PatientDetail.jsx';

const INTEREST = {
  implants: 'Implants',
  aligners: 'Aligners',
  veneers: 'Veneers',
  bonding: 'Bonding',
  not_sure: 'Undecided',
};

const when = (value) =>
  value ? new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : null;
const day = (value) => (value ? new Date(value).toLocaleDateString('en-GB', { dateStyle: 'medium' }) : null);

function Row({ label, children }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/**
 * Everything known about one referred patient, opened by clicking their card on the board.
 *
 * The card face carries a name and two lines; this is where the rest lives — who referred them,
 * both practices, the appointment, the commission, the stage history, and the two fields the
 * practice fills in itself: the real treatment name and the notes. Both of those are stored
 * (0018), not page state: they are still here tomorrow, and after a colleague's refresh.
 */
export default function ReferralPanel({ referral, detail, error, onClose, onRetry, onSaved, notify }) {
  const [treatment, setTreatment] = useState('');
  const [savingTreatment, setSavingTreatment] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [notes, setNotes] = useState(null);
  const closeRef = useRef(null);

  // Reset every editable field when the panel switches to a different patient, so a half-typed
  // note can never land on the wrong person's record.
  useEffect(() => {
    setTreatment(detail?.patient?.treatmentName ?? '');
    setNotes(detail?.notes ?? null);
    setNoteDraft('');
  }, [detail]);

  useEffect(() => {
    closeRef.current?.focus();
  }, [referral.id]);

  const saveTreatment = async (e) => {
    e.preventDefault();
    setSavingTreatment(true);
    try {
      const out = await api(`/admin/referrals/${referral.id}/treatment`, {
        method: 'PUT',
        body: { treatmentName: treatment },
      });
      setTreatment(out.treatmentName ?? '');
      onSaved?.(referral.id, { treatmentName: out.treatmentName });
      notify('treatment_saved');
    } catch (err) {
      notify(err.code ?? 'save_failed');
    } finally {
      setSavingTreatment(false);
    }
  };

  const addNote = async (e) => {
    e.preventDefault();
    if (!noteDraft.trim()) return;
    setSavingNote(true);
    try {
      // Both note writes answer with the whole list, so there is never a second read to
      // race — what comes back IS what is stored.
      const out = await api(`/admin/referrals/${referral.id}/notes`, {
        method: 'POST',
        body: { body: noteDraft },
      });
      setNotes(out.notes);
      setNoteDraft('');
    } catch (err) {
      notify(err.code ?? 'save_failed');
    } finally {
      setSavingNote(false);
    }
  };

  const removeNote = async (noteId) => {
    try {
      const out = await api(`/admin/referrals/${referral.id}/notes/${noteId}`, { method: 'DELETE' });
      setNotes(out.notes);
    } catch (err) {
      notify(err.code ?? 'save_failed');
    }
  };

  return (
    <aside className="referral-panel" aria-label={`Details for ${referral.referred_name}`}>
      <header>
        <h3>{referral.referred_name}</h3>
        <button className="ghost" ref={closeRef} onClick={onClose}>Close</button>
      </header>

      {error ? (
        <div className="patient-detail-error">
          <p>Couldn’t load this patient. The list may be out of date.</p>
          <button className="ghost" onClick={onRetry}>Try again</button>
        </div>
      ) : !detail ? (
        <p className="loading">Loading…</p>
      ) : (
        <>
          <dl>
            <Row label="Stage">{STATUS_LABELS[detail.patient.status] ?? detail.patient.status}</Row>
            <Row label="Phone">{detail.patient.phone}</Row>
            <Row label="Email">{detail.patient.email}</Row>
            <Row label="Asked about">{INTEREST[detail.patient.treatmentInterest] ?? detail.patient.treatmentInterest}</Row>
            <Row label="Referred by">
              {detail.referrer.name}
              <p className="meta">{detail.referrer.phone}{detail.referrer.code ? ` · code ${detail.referrer.code}` : ''}</p>
            </Row>
            <Row label="Referred on">{day(detail.patient.referredAt)}</Row>
            <Row label="Practice">
              {detail.practice.booked ?? detail.practice.chosen ?? 'any practice'}
              {detail.practice.booked && detail.practice.chosen && detail.practice.booked !== detail.practice.chosen && (
                <p className="meta">referral link was {detail.practice.chosen}</p>
              )}
            </Row>
            <Row label="Appointment">{when(detail.appointment.startsAt)}</Row>
            <Row label="Commission">
              {detail.commission.amountPennies != null ? (
                <span className="amount record-credited">{formatPennies(detail.commission.amountPennies)}</span>
              ) : null}
            </Row>
            <Row label="Lost because">{detail.patient.lostReason}</Row>
          </dl>

          <form onSubmit={saveTreatment} className="panel-field">
            <label htmlFor={`treatment-${referral.id}`}>Treatment</label>
            <input
              id={`treatment-${referral.id}`}
              value={treatment}
              placeholder="e.g. Upper arch implants"
              onChange={(e) => setTreatment(e.target.value)}
            />
            <button type="submit" disabled={savingTreatment}>Save treatment</button>
          </form>

          <h4>Notes</h4>
          <ul className="notes">
            {(notes ?? []).map((note) => (
              <li key={note.id}>
                <p>{note.body}</p>
                <p className="meta">
                  {note.author ?? 'someone'} · {when(note.createdAt)}
                  <button className="linklike note-delete" onClick={() => removeNote(note.id)}>Delete</button>
                </p>
              </li>
            ))}
            {(notes ?? []).length === 0 && <li className="empty">No notes yet.</li>}
          </ul>

          <form onSubmit={addNote} className="panel-field">
            <label htmlFor={`note-${referral.id}`}>Add a note</label>
            <textarea
              id={`note-${referral.id}`}
              rows={3}
              value={noteDraft}
              placeholder="What the desk should know next time."
              onChange={(e) => setNoteDraft(e.target.value)}
            />
            <button type="submit" className="btn-primary" disabled={savingNote || !noteDraft.trim()}>
              Add note
            </button>
          </form>

          <h4>History</h4>
          <ol className="timeline">
            {detail.timeline.map((entry, i) => (
              <li key={i}>
                <span className="timeline-when">{when(entry.at)}</span>
                <span className="timeline-what">
                  {entry.action === 'status_changed'
                    ? `${STATUS_LABELS[entry.from] ?? entry.from} → ${STATUS_LABELS[entry.to] ?? entry.to}`
                    : entry.action.replaceAll('_', ' ')}
                  {entry.actorEmail ? ` · ${entry.actorEmail}` : ''}
                  {entry.reason ? ` · ${entry.reason}` : ''}
                </span>
              </li>
            ))}
            {detail.timeline.length === 0 && <li className="empty">Nothing recorded yet.</li>}
          </ol>
        </>
      )}
    </aside>
  );
}
