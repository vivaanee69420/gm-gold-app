import { useCallback, useEffect, useState } from 'react';
import { api, onUnauthorized } from './api/client.js';
import { isSignedIn, signOut } from './api/auth.js';
import { errorMessage } from './copy.js';
import SignIn from './components/SignIn.jsx';
import Levers from './components/Levers.jsx';
import ConfirmQueue from './components/ConfirmQueue.jsx';
import PayoutQueue from './components/PayoutQueue.jsx';
import PipelineBoard from './components/PipelineBoard.jsx';
import StatsStrip from './components/StatsStrip.jsx';

export default function App() {
  const [signedIn, setSignedIn] = useState(isSignedIn());
  const [data, setData] = useState(null);
  const [toast, setToast] = useState(null);

  const notify = useCallback((message) => setToast(errorMessage(message)), []);

  const loadAll = useCallback(async () => {
    try {
      const [settings, stats, payouts, referrals] = await Promise.all([
        api('/admin/settings'),
        api('/admin/stats'),
        api('/admin/payouts'),
        api('/admin/referrals'),
      ]);
      setData({
        settings: settings.settings,
        stats: stats.stats,
        payouts: payouts.payouts,
        referrals: referrals.referrals,
      });
    } catch (err) {
      notify(err.code ?? 'load_failed');
    }
  }, [notify]);

  useEffect(() => {
    onUnauthorized(() => {
      setSignedIn(false);
      setData(null);
    });
  }, []);

  useEffect(() => {
    if (signedIn) loadAll();
  }, [signedIn, loadAll]);

  if (!signedIn) return <SignIn onSignedIn={() => setSignedIn(true)} />;

  return (
    <div className="dashboard">
      <header className="topbar">
        <p className="wordmark">GM Dental</p>
        <h1>Referral Admin</h1>
        <button
          className="ghost"
          onClick={() => {
            signOut();
            setSignedIn(false);
            setData(null);
          }}
        >
          Sign out
        </button>
      </header>
      {toast && (
        <div role="alert" className="toast">
          {toast}
          <button className="ghost" onClick={() => setToast(null)}>Dismiss</button>
        </div>
      )}
      {!data ? (
        <p className="empty">Loading…</p>
      ) : (
        <main>
          <div className="row">
            <Levers
              key={`${data.stats.commissionPennies}:${data.settings.payout_threshold_pennies}:${data.settings.payout_expiry_days}`}
              commissionPennies={data.stats.commissionPennies}
              settings={data.settings}
              onChanged={loadAll}
              notify={notify}
            />
            <ConfirmQueue />
            <PayoutQueue payouts={data.payouts} onChanged={loadAll} notify={notify} />
          </div>
          <PipelineBoard referrals={data.referrals} onChanged={loadAll} notify={notify} />
          <StatsStrip stats={data.stats} />
        </main>
      )}
    </div>
  );
}
