import { api } from '../api/client.js';

const MODE_LABEL = {
  dentalos: 'Live — reading Dentally data from Dental Os',
  live: 'Live — synced with Dentally directly',
  stub: 'Demo mode — using stub data',
  off: 'Off — completions are marked manually',
};

export default function DentallyCard({ status, onChanged, notify }) {
  const connect = async () => {
    try {
      const { url } = await api('/admin/dentally/connect', { method: 'POST', body: {} });
      window.location.href = url; // off to Dentally's approval screen; it redirects back here
    } catch (err) {
      notify(err.code ?? 'connect_failed');
    }
  };

  const disconnect = async () => {
    if (!window.confirm('Disconnect Dentally? Sync stops until someone reconnects.')) return;
    try {
      await api('/admin/dentally/disconnect', { method: 'POST', body: {} });
      onChanged();
    } catch (err) {
      notify(err.code ?? 'disconnect_failed');
    }
  };

  const syncNow = async () => {
    try {
      const out = await api('/admin/sync/run', { method: 'POST', body: {} });
      notify(
        out.skipped
          ? `Sync skipped (${out.skipped}).`
          : `Sync done — ${out.proposalsCreated ?? 0} new proposal(s), ${out.verificationsResolved ?? 0} verification(s) resolved.`,
      );
      onChanged();
    } catch (err) {
      notify(err.code ?? 'sync_failed');
    }
  };

  if (!status) return null;
  const { mode, oauthConfigured, envToken, connection } = status;

  return (
    <section className="card dentally-card">
      <h2>Dentally</h2>
      <p className="meta">{MODE_LABEL[mode] ?? mode}</p>
      {mode === 'dentalos' ? (
        <p className="meta">Completed &amp; paid treatments flow in from the central Dental Os database.</p>
      ) : connection ? (
        <>
          <p className="meta">
            Connected {new Date(connection.connectedAt).toLocaleDateString('en-GB')}
            {connection.scope ? ` · ${connection.scope}` : ''}
          </p>
          <button className="ghost" onClick={disconnect}>Disconnect</button>
        </>
      ) : envToken ? (
        <p className="meta">Using the API token from the server environment.</p>
      ) : oauthConfigured ? (
        <>
          <p className="meta">One click connects every practice under your Dentally account — no keys to copy.</p>
          <button onClick={connect}>Connect Dentally</button>
        </>
      ) : (
        <p className="empty">
          Waiting on OAuth app credentials from Dentally — add DENTALLY_CLIENT_ID and
          DENTALLY_CLIENT_SECRET to the API's .env, then this becomes a one-click connect.
        </p>
      )}
      {mode !== 'off' && (
        <button className="ghost" onClick={syncNow}>Sync now</button>
      )}
    </section>
  );
}
