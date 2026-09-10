import { NAV_ICONS, CloseIcon, LockIcon } from './icons.jsx';

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

export default function Sidebar({
  me,
  pages,
  activePath,
  navigate,
  badges,
  onChangePassword,
  changePasswordOpen,
  onDismiss,
}) {
  const scope = me ? scopeOf(me) : null;

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
        {pages.map(({ path, label, icon }) => {
          const Icon = NAV_ICONS[icon];
          const badge = badges?.[path];
          return (
            <a
              key={path}
              href={path}
              aria-current={path === activePath ? 'page' : undefined}
              className={path === activePath ? 'active' : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate(path);
              }}
            >
              <Icon />
              <span>{label}</span>
              {badge ? <span className="nav-badge">{badge}</span> : null}
            </a>
          );
        })}
      </nav>

      <div className="sidebar-foot">
        <button
          type="button"
          className={changePasswordOpen ? 'sidefoot-button active' : 'sidefoot-button'}
          aria-expanded={changePasswordOpen}
          onClick={onChangePassword}
        >
          <LockIcon />
          <span>Change password</span>
        </button>
      </div>
    </div>
  );
}
