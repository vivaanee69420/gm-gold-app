import { useState } from 'react';
import { MANAGER_PAGES } from '@gm-referral/shared/schemas';
import { api, setToken } from '../../api/client.js';

const PAGE_LABELS = { pipeline: 'Pipeline', patients: 'Patients', payouts: 'Payouts' };

// What each screen actually gives someone, said in terms of what they can do rather than
// which endpoints open — this is the sentence the owner is deciding on.
const PAGE_BLURBS = {
  pipeline: 'Move patients through the stages, and credit commission at Treatment started.',
  patients: 'The register of everyone referred, and each patient’s full record.',
  payouts: 'Mark cash paid at the practice, and cancel a request.',
};

const TABS = [
  { key: 'info', label: 'User info' },
  { key: 'access', label: 'Roles & permissions' },
];

/**
 * One team member, edited on their own screen rather than inside a table row.
 *
 * Two tabs, because they are two different decisions: who this person is, and what they may
 * reach. Each saves on its own — nothing here is a single giant form whose Save means four
 * different requests half of which might fail.
 */
export default function TeamMember({ member, practices, meId, onBack, onChanged, notify }) {
  const [tab, setTab] = useState('info');
  const isSelf = member.id === meId;

  const [name, setName] = useState(member.name ?? '');
  const [phone, setPhone] = useState(member.phone ?? '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [role, setRole] = useState(member.role);
  const [practiceId, setPracticeId] = useState(member.practices[0]?.id ?? '');
  const [pages, setPages] = useState(member.pages ?? MANAGER_PAGES);
  const [busy, setBusy] = useState(null);

  const run = async (key, fn, okCode = 'team_saved') => {
    setBusy(key);
    try {
      await fn();
      await onChanged();
      notify(okCode);
    } catch (err) {
      notify(err.code ?? 'save_failed');
    } finally {
      setBusy(null);
    }
  };

  const saveProfile = (e) => {
    e.preventDefault();
    return run('profile', () => api(`/admin/team/${member.id}/profile`, { method: 'POST', body: { name, phone } }));
  };

  const savePassword = (e) => {
    e.preventDefault();
    return run('password', async () => {
      // Setting your own password revokes your own sessions, so the API hands back a
      // replacement token. Store it or the next request 401s you out of your own dashboard.
      const out = await api(`/admin/team/${member.id}/password`, { method: 'POST', body: { password } });
      if (out?.token) setToken(out.token);
      setPassword('');
    });
  };

  const savePractice = () =>
    run('practice', () => api(`/admin/team/${member.id}/practice`, { method: 'POST', body: { practiceId } }));

  const savePages = () =>
    run('pages', () => api(`/admin/team/${member.id}/pages`, { method: 'POST', body: { pages } }));

  return (
    <>
      <button type="button" className="go-back" onClick={onBack}>
        <span aria-hidden="true">←</span> Back
      </button>
      <header className="settings-head">
        <div>
          <h2>Edit or manage your team</h2>
          <p className="meta">{member.email}</p>
        </div>
      </header>

      <div className="member-layout">
        <nav className="member-tabs" aria-label="Member settings">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={tab === t.key ? 'active' : undefined}
              aria-current={tab === t.key ? 'true' : undefined}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="card member-card">
          {tab === 'info' ? (
            <>
              <form onSubmit={saveProfile}>
                <div className="field-pair">
                  <div>
                    <label htmlFor="member-name">Full name</label>
                    <input id="member-name" value={name} onChange={(e) => setName(e.target.value)} />
                  </div>
                  <div>
                    <label htmlFor="member-email">Email</label>
                    {/* Read-only on purpose: email is what this account signs in with and what
                        every audit row records, so changing it is an account migration. */}
                    <input id="member-email" value={member.email} readOnly aria-describedby="member-email-note" />
                    <p className="meta" id="member-email-note">Sign-in address — can’t be changed here.</p>
                  </div>
                </div>
                <label htmlFor="member-phone">Phone</label>
                <input id="member-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
                <div className="form-actions">
                  <button type="button" className="ghost" onClick={onBack}>Cancel</button>
                  <button type="submit" disabled={busy === 'profile'}>Save</button>
                </div>
              </form>

              <form onSubmit={savePassword} className="panel-field">
                <label htmlFor="member-password">Set password</label>
                <input
                  id="member-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <p className="meta">
                  {isSelf
                    ? 'Signs you out everywhere else and keeps this tab signed in.'
                    : 'Signs this person out of every device immediately.'}
                </p>
                <div className="form-actions">
                  <button type="button" className="ghost" onClick={() => setShowPassword((v) => !v)}>
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                  <button type="submit" disabled={busy === 'password' || password.length < 10}>
                    Set password
                  </button>
                </div>
              </form>
            </>
          ) : (
            <>
              <div className="field-pair">
                <div>
                  <label htmlFor="member-role">User role</label>
                  {/* Read-only: role decides practice scoping and the whole permission model,
                      and the API has no route that flips one. Deactivate and re-add instead. */}
                  <input id="member-role" value={role === 'admin' ? 'Owner' : 'Manager'} readOnly />
                </div>
                <div>
                  <label htmlFor="member-practice">Practice</label>
                  {role === 'admin' ? (
                    <input id="member-practice" value="Every practice" readOnly />
                  ) : (
                    <>
                      <select
                        id="member-practice"
                        value={practiceId}
                        onChange={(e) => setPracticeId(e.target.value)}
                      >
                        {practices.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy === 'practice' || practiceId === (member.practices[0]?.id ?? '')}
                        onClick={savePractice}
                      >
                        Save practice
                      </button>
                    </>
                  )}
                </div>
              </div>

              <h4>Screens</h4>
              {role === 'admin' ? (
                <p className="empty">An owner reaches every screen — there is nothing here to narrow.</p>
              ) : (
                <>
                  <ul className="permission-list">
                    {MANAGER_PAGES.map((key) => (
                      <li key={key}>
                        <label htmlFor={`page-${key}`}>
                          <input
                            id={`page-${key}`}
                            type="checkbox"
                            checked={pages.includes(key)}
                            onChange={(e) =>
                              setPages(
                                e.target.checked
                                  ? MANAGER_PAGES.filter((p) => p === key || pages.includes(p))
                                  : pages.filter((p) => p !== key),
                              )
                            }
                          />
                          <span>
                            <strong>{PAGE_LABELS[key]}</strong>
                            <span className="meta">{PAGE_BLURBS[key]}</span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  <p className="meta">
                    Unticking a screen closes the data behind it, not just the link — this
                    person’s dashboard stops asking for it at all.
                  </p>
                  <div className="form-actions">
                    <button type="button" className="ghost" onClick={onBack}>Cancel</button>
                    <button type="button" className="btn-primary" disabled={busy === 'pages'} onClick={savePages}>
                      Save screens
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
