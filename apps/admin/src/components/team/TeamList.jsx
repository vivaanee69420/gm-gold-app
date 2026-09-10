import { useMemo, useState } from 'react';
import { initialsOf } from './helpers.js';

const ROLE_LABEL = { admin: 'Owner', manager: 'Manager' };

/**
 * Everyone who can sign in. One row per account: who they are, how to reach them, what they
 * can do, and where. Edit and Remove sit at the end of the row and appear on hover or focus —
 * a destructive control on every row at all times reads as an invitation.
 */
export default function TeamList({ team, meId, practices, onOpen, onAdd, onToggleActive, busyId }) {
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('all');
  const [practice, setPractice] = useState('all');

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return team.filter((t) => {
      if (role !== 'all' && t.role !== role) return false;
      if (practice !== 'all' && !t.practices.some((p) => p.id === practice)) return false;
      if (!q) return true;
      return [t.name, t.email, t.phone].filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
    });
  }, [team, query, role, practice]);

  return (
    <>
      <header className="settings-head">
        <div>
          <h2>Team</h2>
          <p className="meta">Everyone who can sign in to this dashboard</p>
        </div>
        <button className="btn-primary" onClick={onAdd}>Add user</button>
      </header>

      <div className="card team-panel">
        <div className="team-filters">
          <input
            type="search"
            placeholder="Search name, email or phone…"
            aria-label="Search team"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select aria-label="Filter by role" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="all">All roles</option>
            <option value="admin">Owner</option>
            <option value="manager">Manager</option>
          </select>
          <select aria-label="Filter by practice" value={practice} onChange={(e) => setPractice(e.target.value)}>
            <option value="all">All practices</option>
            {practices.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <span className="meta team-count">{rows.length} {rows.length === 1 ? 'person' : 'people'}</span>
        </div>

        <div className="record-scroll">
          <table className="record-table team-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Phone</th>
                <th scope="col">Role</th>
                <th scope="col">Practices</th>
                <th scope="col">Status</th>
                <th scope="col"><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td>
                    <div className="team-person">
                      <span className="avatar" aria-hidden="true">{initialsOf(t.name || t.email)}</span>
                      <span>
                        <strong>
                          {t.name || t.email.split('@')[0]}
                          {t.id === meId && <span className="tag">You</span>}
                        </strong>
                        <span className="meta">{t.email}</span>
                      </span>
                    </div>
                  </td>
                  <td>{t.phone || '—'}</td>
                  <td>{ROLE_LABEL[t.role] ?? t.role}</td>
                  <td>{t.role === 'admin' ? 'Every practice' : t.practices.map((p) => p.name).join(', ') || '—'}</td>
                  <td>
                    <span className={t.active ? 'status-dot status-on' : 'status-dot'}>
                      {t.active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="row-actions">
                    <button className="linklike" onClick={() => onOpen(t.id)}>Edit</button>
                    {t.id !== meId && (
                      <button
                        className="linklike danger"
                        disabled={busyId === t.id}
                        onClick={() => onToggleActive(t)}
                      >
                        {t.active ? 'Remove' : 'Restore'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">Nobody matches those filters.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
