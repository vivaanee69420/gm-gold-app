import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import PayoutQueue from '../components/PayoutQueue.jsx';

// FR-24: a practice manager gets a single-purpose screen — just their practice's
// payout queue, refreshed on a timer so a colleague's mark-paid/cancel shows up
// without a manual reload.
export default function ManagerPage({ me, notify, onSignOut }) {
  const [payouts, setPayouts] = useState(null);

  const reload = useCallback(async () => {
    try {
      const out = await api('/admin/payouts');
      setPayouts(out.payouts);
    } catch (err) {
      notify(err.code ?? 'load_failed');
    }
  }, [notify]);

  useEffect(() => {
    reload();
    // Poll while the tab is actually in front of someone — no point hammering
    // the API from a backgrounded browser tab at the front desk.
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, 30_000);
    return () => clearInterval(timer);
  }, [reload]);

  return (
    <div className="dashboard">
      <header className="topbar">
        <p className="wordmark">GM Dental</p>
        <h1>{me.practices[0].name} · Payouts</h1>
        <button className="ghost" onClick={onSignOut}>
          Sign out
        </button>
      </header>
      {!payouts ? (
        <p className="loading">Loading…</p>
      ) : (
        <main>
          <PayoutQueue payouts={payouts} onChanged={reload} notify={notify} />
        </main>
      )}
    </div>
  );
}
