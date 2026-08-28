import { useState } from 'react';
import { api, setToken } from '../api/client.js';
import { Card } from './ui.jsx';

// Both roles reach this — a header ghost button toggles it inline in both dashboard shells.
// The API bumps sessions_revoked_at on success and hands back a fresh token in the same
// response, so we must store it here or the very next request would 401 the admin out.
export default function ChangePassword({ notify, onDone }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const { token } = await api('/admin/me/password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      });
      setToken(token);
      setCurrentPassword('');
      setNewPassword('');
      onDone?.();
    } catch (err) {
      notify(err.code ?? 'save_failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Change password" className="change-password">
      <form onSubmit={submit}>
        <label htmlFor="cp-current">Current password</label>
        <input
          id="cp-current"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
        />
        <label htmlFor="cp-new">New password</label>
        <input
          id="cp-new"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />
        <button type="submit" disabled={saving}>Save password</button>
      </form>
    </Card>
  );
}
