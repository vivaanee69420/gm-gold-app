import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import ChangePassword from '../components/ChangePassword.jsx';
import DentallyCard from '../components/DentallyCard.jsx';
import TeamList from '../components/team/TeamList.jsx';
import TeamMember from '../components/team/TeamMember.jsx';
import AddUser from '../components/team/AddUser.jsx';

/**
 * Settings is its own place: a sidebar of sections (rendered by Sidebar in settings mode) and
 * one section at a time here. The url carries the section, so a half-finished edit survives a
 * refresh and the browser's Back button does what it looks like it does.
 *
 *   /settings                 Team
 *   /settings/team/new        Add a user
 *   /settings/team/<id>       One member — their details, and what they may reach
 *   /settings/integrations    The systems this dashboard talks to
 *   /settings/account         Your own password
 */
export default function SettingsPage({ data, loadAll, notify, me, route, navigate, noGrantedPages }) {
  const [team, setTeam] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const isAdmin = me?.role === 'admin';
  const section = route.slice('/settings'.length).replace(/^\//, ''); // '' | 'integrations' | 'account' | 'team/<id>'

  const loadTeam = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const out = await api('/admin/team');
      setTeam(out.team);
    } catch (err) {
      notify(err.code ?? 'load_failed');
    }
  }, [isAdmin, notify]);

  useEffect(() => {
    loadTeam();
  }, [loadTeam]);

  // A manager has no team or integrations to reach, so their Settings is their own account.
  // Landing them on a section they cannot see would show an empty screen with no explanation.
  const forcedAccount = !isAdmin;
  const view = forcedAccount ? 'account' : section;

  const toggleActive = async (member) => {
    setBusyId(member.id);
    try {
      await api(`/admin/team/${member.id}/active`, { method: 'POST', body: { active: !member.active } });
      await loadTeam();
      notify('team_saved');
    } catch (err) {
      notify(err.code ?? 'save_failed');
    } finally {
      setBusyId(null);
    }
  };

  if (view === 'account') {
    return (
      <>
        <header className="settings-head">
          <div>
            <h2>Your account</h2>
            <p className="meta">{me?.email}</p>
          </div>
        </header>
        <div className="settings-narrow">
          {noGrantedPages && (
            <p className="empty settings-note">
              No other screens have been shared with this account yet — ask the owner to add one.
            </p>
          )}
          <ChangePassword notify={notify} onDone={() => notify('password_saved')} />
        </div>
      </>
    );
  }

  if (view === 'integrations') {
    return (
      <>
        <header className="settings-head">
          <div>
            <h2>Integrations</h2>
            <p className="meta">The systems this dashboard reads from</p>
          </div>
        </header>
        <div className="integration-grid">
          <DentallyCard status={data.dentally} onChanged={loadAll} notify={notify} />
        </div>
      </>
    );
  }

  if (!team) return <p className="loading">Loading…</p>;

  if (view === 'team/new') {
    return (
      <AddUser
        practices={me.practices}
        notify={notify}
        onCancel={() => navigate('/settings')}
        onDone={async () => {
          await loadTeam();
          navigate('/settings');
        }}
      />
    );
  }

  if (view.startsWith('team/')) {
    const member = team.find((t) => t.id === view.slice('team/'.length));
    // The id in the url is not in the list: a deleted account, or a hand-typed url. Say so
    // rather than rendering a form bound to nothing.
    if (!member) {
      return (
        <>
          <button type="button" className="go-back" onClick={() => navigate('/settings')}>
            <span aria-hidden="true">←</span> Back
          </button>
          <p className="empty">That account no longer exists.</p>
        </>
      );
    }
    return (
      <TeamMember
        key={member.id}
        member={member}
        practices={me.practices}
        meId={me.id}
        notify={notify}
        onChanged={loadTeam}
        onBack={() => navigate('/settings')}
      />
    );
  }

  return (
    <TeamList
      team={team}
      meId={me.id}
      practices={me.practices}
      busyId={busyId}
      onOpen={(id) => navigate(`/settings/team/${id}`)}
      onAdd={() => navigate('/settings/team/new')}
      onToggleActive={toggleActive}
    />
  );
}
