import ChangePassword from '../components/ChangePassword.jsx';
import DentallyCard from '../components/DentallyCard.jsx';
import TeamCard from '../components/TeamCard.jsx';
import { Zone } from '../components/ui.jsx';

// Everything that configures the dashboard rather than reports on it: your own password, the
// people who can sign in, and the systems this app talks to. A manager reaches this page too —
// it is the only one no page grant can take away — but sees just their own password.
export default function SettingsPage({ data, loadAll, notify, me, noGrantedPages }) {
  const isAdmin = me?.role === 'admin';

  return (
    <>
      <Zone label="Your account">
        <div className="settings-narrow">
          {noGrantedPages && (
            <p className="empty settings-note">
              No other screens have been shared with this account yet — ask the owner to add one.
            </p>
          )}
          <ChangePassword notify={notify} onDone={() => notify('password_saved')} />
        </div>
      </Zone>

      {/* No zone label over this one: the card's own header already says Team, and two
          headings reading "Team" is a heading the page says twice. */}
      {isAdmin && (
        <Zone>
          <TeamCard practices={me.practices} meId={me.id} notify={notify} />
        </Zone>
      )}

      {isAdmin && (
        <Zone label="Integrations">
          <div className="zone-grid-wide">
            <DentallyCard status={data.dentally} onChanged={loadAll} notify={notify} />
          </div>
        </Zone>
      )}
    </>
  );
}
