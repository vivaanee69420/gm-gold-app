import { useEffect, useRef, useState } from 'react';
import { formatPennies, parseGBPToPennies } from '@gm-referral/shared/money';
import { missingTreatmentDetails } from '@gm-referral/shared/schemas';
import { api } from '../api/client.js';
import { STATUS_LABELS } from './PatientDetail.jsx';

const INTEREST = {
  implants: 'Implants',
  aligners: 'Aligners',
  veneers: 'Veneers',
  bonding: 'Bonding',
  not_sure: 'Undecided',
};

const SECTIONS = [
  { key: 'details', label: 'Patient details' },
  { key: 'treatment', label: 'Treatment' },
  { key: 'notes', label: 'Notes' },
  { key: 'history', label: 'History' },
];

const when = (value) =>
  value ? new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : null;
const day = (value) => (value ? new Date(value).toLocaleDateString('en-GB', { dateStyle: 'medium' }) : null);

function Field({ label, children }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div className="modal-field">
      <span className="modal-label">{label}</span>
      <span className="modal-value">{children}</span>
    </div>
  );
}

/**
 * One patient's whole record, in the middle of the screen.
 *
 * A dialog rather than a panel beside the board: this is a place you go into and come back
 * from, and it needs the width for two columns of fields. Sections down the left, one at a
 * time on the right, and the way out in two corners.
 *
 * `blockedMove` is set when someone tried to start treatment on a card that has not got the
 * three facts a commission credit needs. The dialog then opens on Treatment, says what is
 * missing, and pays the commission itself the moment they are all filled in — so the answer to
 * "why won't this move" and the fix for it are the same screen.
 */
export default function ReferralModal({
  referral, detail, error, blockedMove, onClose, onRetry, onSaved, onCreditAfterDetails, notify,
}) {
  const [section, setSection] = useState(blockedMove ? 'treatment' : 'details');
  const [treatment, setTreatment] = useState('');
  const [doctor, setDoctor] = useState('');
  const [value, setValue] = useState('');
  const [savingTreatment, setSavingTreatment] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [notes, setNotes] = useState(null);
  const closeRef = useRef(null);

  // Reset every editable field when the dialog switches to a different patient, so a half-typed
  // note can never land on the wrong person's record.
  useEffect(() => {
    setTreatment(detail?.patient?.treatmentName ?? '');
    setDoctor(detail?.patient?.doctorName ?? '');
    setValue(
      detail?.patient?.treatmentValuePennies != null
        ? (detail.patient.treatmentValuePennies / 100).toFixed(2)
        : '',
    );
    setNotes(detail?.notes ?? null);
    setNoteDraft('');
  }, [detail]);

  useEffect(() => {
    closeRef.current?.focus();
  }, [referral.id]);

  // Escape closes, the way every other dismissible layer on the web does.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const valuePennies = value.trim() === '' ? null : parseGBPToPennies(value);
  const valueLooksWrong = value.trim() !== '' && !Number.isInteger(valuePennies);
  const wouldStillBeMissing = missingTreatmentDetails({
    treatment_name: treatment.trim() || null,
    doctor_name: doctor.trim() || null,
    treatment_value_pennies: valuePennies,
  });

  const saveTreatment = async (e) => {
    e.preventDefault();
    if (valueLooksWrong) return;
    setSavingTreatment(true);
    try {
      const out = await api(`/admin/referrals/${referral.id}/treatment`, {
        method: 'PUT',
        body: { treatmentName: treatment, doctorName: doctor, treatmentValuePennies: valuePennies },
      });
      onSaved?.(referral.id, {
        treatment_name: out.treatmentName,
        doctor_name: out.doctorName,
        treatment_value_pennies: out.treatmentValuePennies,
      });
      // The move that brought them here is now possible, so make it — rather than saving,
      // closing, and asking them to drag the card a second time.
      if (blockedMove && wouldStillBeMissing.length === 0) {
        await onCreditAfterDetails(blockedMove);
        return;
      }
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
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${referral.referred_name} — patient record`}
      >
        <header className="modal-head">
          <div>
            <h3>{referral.referred_name}</h3>
            <p className="meta">
              {referral.referred_phone}
              {referral.practice ? ` · ${referral.practice}` : ''}
              {` · ${STATUS_LABELS[referral.status] ?? referral.status}`}
            </p>
          </div>
          <button className="icon-button modal-close" ref={closeRef} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {error ? (
          <div className="modal-body patient-detail-error">
            <p>Couldn’t load this patient. The list may be out of date.</p>
            <button className="ghost" onClick={onRetry}>Try again</button>
          </div>
        ) : !detail ? (
          <p className="loading">Loading…</p>
        ) : (
          <div className="modal-body">
            <nav className="modal-nav" aria-label="Record sections">
              {SECTIONS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className={section === s.key ? 'active' : undefined}
                  aria-current={section === s.key ? 'true' : undefined}
                  onClick={() => setSection(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </nav>

            <div className="modal-panel">
              {section === 'details' && (
                <div className="modal-grid">
                  <Field label="Stage">{STATUS_LABELS[detail.patient.status] ?? detail.patient.status}</Field>
                  <Field label="Phone">{detail.patient.phone}</Field>
                  <Field label="Email">{detail.patient.email}</Field>
                  <Field label="Asked about">
                    {INTEREST[detail.patient.treatmentInterest] ?? detail.patient.treatmentInterest}
                  </Field>
                  <Field label="Referred by">
                    {detail.referrer.name}
                    <span className="meta">
                      {detail.referrer.phone}
                      {detail.referrer.code ? ` · code ${detail.referrer.code}` : ''}
                    </span>
                  </Field>
                  <Field label="Referred on">{day(detail.patient.referredAt)}</Field>
                  <Field label="Practice">
                    {detail.practice.booked ?? detail.practice.chosen ?? 'any practice'}
                    {detail.practice.booked
                      && detail.practice.chosen
                      && detail.practice.booked !== detail.practice.chosen && (
                        <span className="meta">referral link was {detail.practice.chosen}</span>
                      )}
                  </Field>
                  <Field label="Appointment">{when(detail.appointment.startsAt)}</Field>
                  <Field label="Commission">
                    {detail.commission.amountPennies != null ? (
                      <span className="amount record-credited">
                        {formatPennies(detail.commission.amountPennies)}
                      </span>
                    ) : null}
                  </Field>
                  <Field label="Lost because">{detail.patient.lostReason}</Field>
                </div>
              )}

              {section === 'treatment' && (
                <form onSubmit={saveTreatment}>
                  {blockedMove && (
                    <p className="notice" role="status">
                      {referral.referred_name} can’t start treatment until all three are filled in —
                      they’re what the commission payment points at afterwards. Save them and the
                      move goes through.
                    </p>
                  )}
                  <div className="field-pair">
                    <div>
                      <label htmlFor={`treatment-${referral.id}`}>
                        Treatment <span className="required" aria-hidden="true">*</span>
                      </label>
                      <input
                        id={`treatment-${referral.id}`}
                        required
                        value={treatment}
                        placeholder="e.g. Upper arch implants"
                        onChange={(e) => setTreatment(e.target.value)}
                      />
                    </div>
                    <div>
                      <label htmlFor={`doctor-${referral.id}`}>
                        Dentist <span className="required" aria-hidden="true">*</span>
                      </label>
                      <input
                        id={`doctor-${referral.id}`}
                        required
                        value={doctor}
                        placeholder="e.g. Dr Patel"
                        onChange={(e) => setDoctor(e.target.value)}
                      />
                    </div>
                  </div>
                  <label htmlFor={`value-${referral.id}`}>
                    Value <span className="required" aria-hidden="true">*</span>
                  </label>
                  <input
                    id={`value-${referral.id}`}
                    required
                    inputMode="decimal"
                    value={value}
                    placeholder="£ 0.00"
                    aria-invalid={valueLooksWrong || undefined}
                    onChange={(e) => setValue(e.target.value)}
                  />
                  {valueLooksWrong && <p className="error-note">Type an amount in pounds, like 4800 or 4800.50.</p>}
                  <p className="meta">
                    What the patient is paying for this treatment. It doesn’t change the
                    referrer’s commission — that comes from the reward levers.
                  </p>
                  <div className="form-actions">
                    <button type="button" className="ghost" onClick={onClose}>Cancel</button>
                    <button type="submit" className="btn-primary" disabled={savingTreatment || valueLooksWrong}>
                      {blockedMove && wouldStillBeMissing.length === 0
                        ? 'Save and start treatment'
                        : 'Save treatment'}
                    </button>
                  </div>
                </form>
              )}

              {section === 'notes' && (
                <>
                  <ul className="notes">
                    {(notes ?? []).map((note) => (
                      <li key={note.id}>
                        <p>{note.body}</p>
                        <p className="meta">
                          {note.author ?? 'someone'} · {when(note.createdAt)}
                          <button className="linklike note-delete" onClick={() => removeNote(note.id)}>
                            Delete
                          </button>
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
                    <div className="form-actions">
                      <button type="submit" className="btn-primary" disabled={savingNote || !noteDraft.trim()}>
                        Add note
                      </button>
                    </div>
                  </form>
                </>
              )}

              {section === 'history' && (
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
              )}
            </div>
          </div>
        )}

        <footer className="modal-foot">
          <button className="ghost" onClick={onClose}>Close</button>
        </footer>
      </div>
    </div>
  );
}
