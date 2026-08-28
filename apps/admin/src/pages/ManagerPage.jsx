import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import PayoutQueue from '../components/PayoutQueue.jsx';

// FR-24: a practice manager gets a single-purpose screen — just their practice's
// payout queue, refreshed on a timer so a colleague's mark-paid/cancel shows up
// without a manual reload.
export default function ManagerPage({ me, notify, onSignOut }) {
  const [payouts, setPayouts] = useState(null);
  // Controller ruling (2026-08-28 final review): a manager with no practice assigned yet
  // sees/acts on nothing — don't crash on `me.practices[0].name` and don't show a queue
  // that would (per the API's own empty-scope rule) always come back empty.
  const hasPractice = me.practices.length > 0;

  const reload = useCallback(async () => {
    if (!hasPractice) return;
    try {
      const out = await api('/admin/payouts');
      setPayouts(out.payouts);
    } catch (err) {
      notify(err.code ?? 'load_failed');
    }
  }, [notify, hasPractice]);

  useEffect(() => {
    reload();
    // Poll while the tab is actually in front of someone — no point hammering
    // the API from a backgrounded browser tab at the front desk.
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, 30_000);
    return () => clearInterval(timer);
  }, [reload]);

  const practiceName = me.practices[0]?.name ?? 'Payouts';

  return (
    <div className="dashboard">
      <header className="topbar">
        <p className="wordmark">GM Dental</p>
        <h1>{practiceName}{hasPractice ? ' · Payouts' : ''}</h1>
        <button className="ghost" onClick={onSignOut}>
          Sign out
        </button>
      </header>
      {!hasPractice ? (
        <main>
          <p className="empty">No practice is assigned to this account — ask the owner to fix it.</p>
        </main>
      ) : !payouts ? (
        <p className="loading">Loading…</p>
      ) : (
        <main>
          <PayoutQueue payouts={payouts} onChanged={reload} notify={notify} />
        </main>
      )}
    </div>
  );
}
