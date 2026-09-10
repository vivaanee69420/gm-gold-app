import { NAV_ICONS, CloseIcon } from './icons.jsx';

const ROLE_LABEL = { admin: 'Owner', manager: 'Manager' };

function initials(source) {
  if (!source) return 'GM';
  const cleaned = source.split('@')[0].replace(/[._-]+/g, ' ').trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'GM';
  const letters = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0];
  return letters.toUpperCase();
}

// What this account can see, said once. An owner works across the group; a manager works
// inside one practice, and that practice is the single most important fact on their screen —
// it decides every figure below it.
function scopeOf(me) {
  const practices = me?.practices ?? [];
  if (me?.role === 'manager') {
    if (practices.length === 1) return { name: practices[0].name, kind: 'Practice' };
    if (practices.length > 1) return { name: `${practices.length} practices`, kind: 'Practices' };
    return { name: 'No practice yet', kind: 'Unassigned' };
  }
  return { name: 'GM Dental Group', kind: 'All practices', mark: 'GM' };
}

// One nav row, rendered the same whether it sits in the list or pinned to the foot.
function NavLink({ page, activePath, navigate, badge }) {
  const Icon = NAV_ICONS[page.icon];
  return (
    <a
      href={page.path}
      aria-current={page.path === activePath ? 'page' : undefined}
      className={page.path === activePath ? 'active' : undefined}
      onClick={(e) => {
        e.preventDefault();
        navigate(page.path);
      }}
    >
      <Icon />
      <span>{page.label}</span>
      {badge ? <span className="nav-badge">{badge}</span> : null}
    </a>
  );
}

// The sections inside Settings. A manager has no team and no integrations to reach, so their
// Settings IS their account — it sits at the root rather than one click in, which would leave
// /settings itself an unreachable, unhighlighted page.
export function settingsSections(role) {
  if (role !== 'admin') return [{ path: '/settings', label: 'Your account' }];
  return [
    { path: '/settings', label: 'Team' },
    { path: '/settings/integrations', label: 'Integrations' },
    { path: '/settings/account', label: 'Your account' },
  ];
}

/**
 * Settings is its own place, so while you are in it the sidebar becomes its own: the sections
 * underneath, and a way back out. Showing the whole dashboard nav here would invite you to
 * leave by accident mid-edit, and buries the sections you actually came for.
 */
function SettingsNav({ me, route, navigate }) {
  const sections = settingsSections(me?.role);
  return (
    <div className="sidebar">
      <button type="button" className="go-back" onClick={() => navigate('/')}>
        <span aria-hidden="true">←</span> Go back
      </button>
      <h2 className="settings-title">Settings</h2>
      <nav className="sidenav" aria-label="Settings sections">
        {sections.map((section) => (
          <a
            key={section.path}
            href={section.path}
            aria-current={route === section.path ? 'page' : undefined}
            className={route === section.path ? 'active' : undefined}
            onClick={(e) => {
              e.preventDefault();
              navigate(section.path);
            }}
          >
            <span>{section.label}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}

export default function Sidebar({
  me,
  pages,
  footerPage,
  activePath,
  navigate,
  badges,
  settingsPage,
  route,
  onDismiss,
}) {
  const scope = me ? scopeOf(me) : null;

  if (settingsPage) return <SettingsNav me={me} route={route} navigate={navigate} />;

  return (
    <div className="sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">GM</span>
        <span className="brand-name">
          <strong>GM Dental</strong>
          <span>Referrals</span>
        </span>
        <button className="icon-button sidebar-dismiss" onClick={onDismiss} aria-label="Close menu">
          <CloseIcon />
        </button>
      </div>

      {scope && (
        <div className="side-card side-scope">
          <span className="avatar avatar-scope" aria-hidden="true">{scope.mark ?? initials(scope.name)}</span>
          <span className="side-card-text">
            <strong>{scope.name}</strong>
            <span className="side-card-kind">{scope.kind}</span>
          </span>
        </div>
      )}

      {me && (
        <div className="side-card">
          <span className="avatar" aria-hidden="true">{initials(me.email)}</span>
          <span className="side-card-text">
            <strong title={me.email}>{me.email ?? 'Signed in'}</strong>
            <span className="side-card-kind">{ROLE_LABEL[me.role] ?? me.role}</span>
          </span>
        </div>
      )}

      <nav className="sidenav" aria-label="Sections">
        {pages.map((page) => (
          <NavLink
            key={page.path}
            page={page}
            activePath={activePath}
            navigate={navigate}
            badge={badges?.[page.path]}
          />
        ))}
      </nav>

      {/* Settings sits apart from the work: it configures the dashboard rather than being
          somewhere you do the day's job. It is also the one row no page grant removes. */}
      {footerPage && (
        <nav className="sidenav sidebar-foot" aria-label="Settings">
          <NavLink page={footerPage} activePath={activePath} navigate={navigate} />
        </nav>
      )}
    </div>
  );
}
