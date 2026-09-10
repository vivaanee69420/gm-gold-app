import { useState } from 'react';
import { api } from '../../api/client.js';

/** Creating an account: the least it can be and still work — who, what, where, and a way in. */
export default function AddUser({ practices, onDone, onCancel, notify }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [role, setRole] = useState('manager');
  const [practiceId, setPracticeId] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const body = { email, password, role };
      if (role === 'manager') body.practiceId = practiceId;
      const created = await api('/admin/team', { method: 'POST', body });
      // The name is a second call because createAdmin's contract is identity only. It is not
      // worth failing the whole creation over, so a rejected name leaves the account made.
      if (name.trim()) {
        await api(`/admin/team/${created.admin.id}/profile`, { method: 'POST', body: { name, phone: '' } })
          .catch(() => {});
      }
      await onDone();
      notify('team_saved');
    } catch (err) {
      notify(err.code ?? 'create_failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button type="button" className="go-back" onClick={onCancel}>
        <span aria-hidden="true">←</span> Back
      </button>
      <header className="settings-head">
        <div>
          <h2>Add a user</h2>
          <p className="meta">They can sign in as soon as you save.</p>
        </div>
      </header>

      <div className="card member-card">
        <form onSubmit={submit}>
          <div className="field-pair">
            <div>
              <label htmlFor="add-name">Full name</label>
              <input id="add-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <label htmlFor="add-email">Email</label>
              <input
                id="add-email"
                type="email"
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          </div>

          <div className="field-pair">
            <div>
              <label htmlFor="add-role">Role</label>
              <select id="add-role" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="manager">Manager — one practice</option>
                <option value="admin">Owner — every practice</option>
              </select>
            </div>
            <div>
              <label htmlFor="add-practice">Practice</label>
              {role === 'manager' ? (
                <select id="add-practice" value={practiceId} onChange={(e) => setPracticeId(e.target.value)}>
                  <option value="">Select a practice</option>
                  {practices.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              ) : (
                <input id="add-practice" value="Every practice" readOnly />
              )}
            </div>
          </div>

          <label htmlFor="add-password">Temporary password</label>
          <input
            id="add-password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="meta">At least 10 characters. Tell them to change it once they’re in.</p>

          <div className="form-actions">
            <button type="button" className="ghost" onClick={() => setShowPassword((v) => !v)}>
              {showPassword ? 'Hide' : 'Show'}
            </button>
            <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
            <button type="submit" disabled={saving}>Add account</button>
          </div>
        </form>
      </div>
    </>
  );
}
