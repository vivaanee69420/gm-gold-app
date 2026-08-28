import { useCallback, useEffect, useState } from 'react';
import { api, setToken } from '../api/client.js';
import { Card } from './ui.jsx';

const ROLES = [
  { value: 'manager', label: 'Manager' },
  { value: 'admin', label: 'Admin' },
];

// Admin-only (Reports & Setup → Setup zone). Fetches its own list from /admin/team rather
// than being fed it, so it can reload itself after a create/set-password/active mutation
// without asking the parent page to know about team data at all.
//
// `meId` is the signed-in admin's own id: their row gets no destructive controls, because
// setting your own password here revokes your own sessions mid-click and deactivating
// yourself is a 409 the API refuses outright. The header's "Change password" is the path.
export default function TeamCard({ practices, meId, notify }) {
  const [team, setTeam] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [role, setRole] = useState('manager');
  const [practiceId, setPracticeId] = useState('');
  const [creating, setCreating] = useState(false);
  const [passwordDrafts, setPasswordDrafts] = useState({}); // admin id -> typed new password
  const [practiceDrafts, setPracticeDrafts] = useState({}); // admin id -> chosen practice id
  const [savingId, setSavingId] = useState(null);
  const [togglingId, setTogglingId] = useState(null);
  const [movingId, setMovingId] = useState(null);

  const load = useCallback(async () => {
    try {
      const out = await api('/admin/team');
      setTeam(out.team);
    } catch (err) {
      notify(err.code ?? 'load_failed');
    }
  }, [notify]);

  useEffect(() => {
    load();
  }, [load]);

  const addAccount = async (e) => {
    e.preventDefault();
    setCreating(true);
    try {
      const body = { email, password, role };
      if (role === 'manager') body.practiceId = practiceId;
      await api('/admin/team', { method: 'POST', body });
      setEmail('');
      setPassword('');
      setPracticeId('');
      await load();
      notify('team_saved');
    } catch (err) {
      notify(err.code ?? 'create_failed');
    } finally {
      setCreating(false);
    }
  };

  const setNewPassword = async (id) => {
    setSavingId(id);
    try {
      // Targeting yourself revokes your own sessions, so the API hands back a replacement
      // token. The card hides that case, but store the token whenever one arrives rather
      // than letting the next request 401 the admin out.
      const out = await api(`/admin/team/${id}/password`, { method: 'POST', body: { password: passwordDrafts[id] } });
      if (out?.token) setToken(out.token);
      setPasswordDrafts((d) => {
        const { [id]: _dropped, ...rest } = d;
        return rest;
      });
      await load();
      notify('team_saved');
    } catch (err) {
      notify(err.code ?? 'save_failed');
    } finally {
      setSavingId(null);
    }
  };

  const savePractice = async (id, current) => {
    setMovingId(id);
    try {
      await api(`/admin/team/${id}/practice`, { method: 'POST', body: { practiceId: practiceDrafts[id] ?? current } });
      await load();
      notify('team_saved');
    } catch (err) {
      notify(err.code ?? 'save_failed');
    } finally {
      setMovingId(null);
    }
  };

  const toggleActive = async (id, active) => {
    setTogglingId(id);
    try {
      await api(`/admin/team/${id}/active`, { method: 'POST', body: { active } });
      await load();
      notify('team_saved');
    } catch (err) {
      notify(err.code ?? 'save_failed');
    } finally {
      setTogglingId(null);
    }
  };

  return (
    <Card title="Team" count={team?.length} className="team-card">
      {!team ? (
        <p className="loading">Loading…</p>
      ) : (
        <div className="record-scroll">
          <table className="record-table">
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Practice</th>
                <th scope="col">Active</th>
                <th scope="col">Last login</th>
                <th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {team.map((t) => {
                const isSelf = Boolean(meId) && t.id === meId;
                const currentPractice = t.practices[0]?.id ?? '';
                return (
                  <tr key={t.id}>
                    <td>
                      <span>{t.email}</span>
                      {isSelf && <span className="muted"> (you)</span>}
                    </td>
                    <td>{t.role}</td>
                    <td>
                      {t.role === 'manager' && !isSelf ? (
                        <>
                          <label htmlFor={`team-move-${t.id}`}>Practice</label>
                          <select
                            id={`team-move-${t.id}`}
                            value={practiceDrafts[t.id] ?? currentPractice}
                            onChange={(e) => setPracticeDrafts((d) => ({ ...d, [t.id]: e.target.value }))}
                          >
                            {practices.map((p) => (
                              <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                          </select>
                          <button
                            className="ghost"
                            disabled={movingId === t.id}
                            onClick={() => savePractice(t.id, currentPractice)}
                          >
                            Save practice
                          </button>
                        </>
                      ) : (
                        t.practices.map((p) => p.name).join(', ') || '—'
                      )}
                    </td>
                    <td>{t.active ? 'Active' : 'Inactive'}</td>
                    <td>{t.lastLoginAt ? new Date(t.lastLoginAt).toLocaleDateString('en-GB') : 'Never'}</td>
                    <td>
                      {isSelf ? (
                        <span className="muted">Use “Change password” in the header.</span>
                      ) : (
                        <>
                          <label htmlFor={`team-newpw-${t.id}`}>New password</label>
                          <input
                            id={`team-newpw-${t.id}`}
                            type="password"
                            value={passwordDrafts[t.id] ?? ''}
                            onChange={(e) => setPasswordDrafts((d) => ({ ...d, [t.id]: e.target.value }))}
                          />
                          <button
                            className="ghost"
                            disabled={savingId === t.id || !passwordDrafts[t.id]}
                            onClick={() => setNewPassword(t.id)}
                          >
                            Save password
                          </button>
                          <button
                            className="ghost"
                            disabled={togglingId === t.id}
                            onClick={() => toggleActive(t.id, !t.active)}
                          >
                            {t.active ? 'Deactivate' : 'Reactivate'}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {team.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">No accounts yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <form onSubmit={addAccount} className="team-add-form">
        <label htmlFor="team-email">Email</label>
        <input
          id="team-email"
          type="email"
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <label htmlFor="team-password">Temporary password</label>
        {/* This password is about to be read out loud to a colleague — being able to see what
            you typed before sending it is the point, not a leak. */}
        <input
          id="team-password"
          type={showPassword ? 'text' : 'password'}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="button" className="ghost" onClick={() => setShowPassword((v) => !v)}>
          {showPassword ? 'Hide' : 'Show'}
        </button>
        <label htmlFor="team-role">Role</label>
        <select id="team-role" value={role} onChange={(e) => setRole(e.target.value)}>
          {ROLES.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
        {role === 'manager' && (
          <>
            <label htmlFor="team-practice">Practice</label>
            <select id="team-practice" value={practiceId} onChange={(e) => setPracticeId(e.target.value)}>
              <option value="">Select a practice</option>
              {practices.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </>
        )}
        <button type="submit" disabled={creating}>Add account</button>
      </form>
    </Card>
  );
}
