import { useMemo, useRef, useState } from 'react';
import { formatPennies } from '@gm-referral/shared/money';
import { api } from '../api/client.js';
import { Card } from '../components/ui.jsx';
import PatientDetail, { STATUS_LABELS } from '../components/PatientDetail.jsx';

// Every person who came through a referral link, patient-first. The list arrives already
// loaded with the rest of the dashboard's data (data.patients); only the detail — referrer,
// both practices, and the stage timeline — is fetched on demand when someone opens a row.
export default function PatientsPage({ data }) {
  const [query, setQuery] = useState('');
  // The open row's id, its name (known immediately, before the detail fetch answers), the
  // loaded detail once it lands, and an error code if it didn't. Keyed together so switching
  // straight from one open patient to another can't show patient A's detail under patient B's
  // heading.
  const [panel, setPanel] = useState(null);
  const patients = data.patients ?? [];
  const rowRefs = useRef(new Map());
  const requestToken = useRef(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return patients;
    return patients.filter((p) =>
      [p.referred_name, p.referred_phone, p.referred_email, p.referrer, p.practice]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q)),
    );
  }, [patients, query]);

  const fetchDetail = async (id, name) => {
    const token = ++requestToken.current;
    try {
      const result = await api(`/admin/patients/${id}`);
      if (requestToken.current === token) setPanel({ id, name, detail: result, error: null });
    } catch (err) {
      if (requestToken.current === token) {
        setPanel({ id, name, detail: null, error: err.code ?? 'request_failed' });
      }
    }
  };

  const open = (patient) => {
    setPanel({ id: patient.id, name: patient.referred_name, detail: null, error: null });
    fetchDetail(patient.id, patient.referred_name);
  };

  const retry = () => {
    if (panel) fetchDetail(panel.id, panel.name);
  };

  const close = () => {
    const opener = rowRefs.current.get(panel?.id);
    setPanel(null);
    opener?.focus();
  };

  return (
    <div className="patients-layout">
      <Card title="Patients" count={patients.length} className="patients">
        {patients.length === 0 ? (
          <p className="empty">No patients yet — everyone who books through a referral link appears here.</p>
        ) : (
          <>
            <input
              type="search"
              className="record-search"
              placeholder="Search by name, phone, email, referrer, or practice…"
              aria-label="Search patients"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="record-scroll">
              <table className="record-table">
                <thead>
                  <tr>
                    <th scope="col">Patient</th>
                    <th scope="col">Referred by</th>
                    <th scope="col">Practice</th>
                    <th scope="col">Stage</th>
                    <th scope="col">Commission</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <button
                          className="linklike"
                          ref={(el) => {
                            if (el) rowRefs.current.set(p.id, el);
                            else rowRefs.current.delete(p.id);
                          }}
                          aria-expanded={panel?.id === p.id}
                          onClick={() => open(p)}
                        >
                          {p.referred_name}
                        </button>
                        <p className="meta">{p.referred_phone}</p>
                        {p.referred_email && <p className="meta">{p.referred_email}</p>}
                      </td>
                      <td>{p.referrer}</td>
                      <td>{p.practice ?? 'any practice'}</td>
                      <td>
                        <span className={`chip chip-status-${p.status}`}>{STATUS_LABELS[p.status] ?? p.status}</span>
                      </td>
                      <td>
                        {p.commission_pennies != null ? (
                          <span className="amount record-credited">{formatPennies(p.commission_pennies)}</span>
                        ) : (
                          <span className="meta">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={5} className="empty">
                        No matches for “{query}”.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
      {panel && (
        <PatientDetail
          key={panel.id}
          name={panel.name}
          detail={panel.detail}
          error={panel.error}
          onClose={close}
          onRetry={retry}
        />
      )}
    </div>
  );
}
