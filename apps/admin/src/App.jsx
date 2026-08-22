import { useCallback, useEffect, useState } from 'react';
import { api, onUnauthorized } from './api/client.js';
import { isSignedIn, signOut } from './api/auth.js';
import { errorMessage } from './copy.js';
import SignIn from './components/SignIn.jsx';
import Levers from './components/Levers.jsx';
import ConfirmQueue from './components/ConfirmQueue.jsx';
import DentallyCard from './components/DentallyCard.jsx';
import VerificationQueue from './components/VerificationQueue.jsx';
import AgingReport from './components/AgingReport.jsx';
import PayoutQueue from './components/PayoutQueue.jsx';
import PipelineBoard from './components/PipelineBoard.jsx';
import StatsStrip from './components/StatsStrip.jsx';
import ReferralReviewQueue from './components/ReferralReviewQueue.jsx';
import FunnelReport from './components/FunnelReport.jsx';
import TopReferrers from './components/TopReferrers.jsx';
import { Zone } from './components/ui.jsx';

export default function App() {
  const [signedIn, setSignedIn] = useState(isSignedIn());
  const [data, setData] = useState(null);
  const [toast, setToast] = useState(null);

  const notify = useCallback((message) => setToast(errorMessage(message)), []);

  const loadAll = useCallback(async () => {
    try {
      const [settings, stats, payouts, referrals, proposals, verifications, aging, dentally, reviews, funnel, top] = await Promise.all([
        api('/admin/settings'),
        api('/admin/stats'),
        api('/admin/payouts'),
        api('/admin/referrals'),
        api('/admin/proposals'),
        api('/admin/verifications'),
        api('/admin/aging'),
        api('/admin/dentally/status'),
        api('/admin/referral-review'),
        api('/admin/reports/funnel'),
        api('/admin/reports/top-referrers'),
      ]);
      setData({
        settings: settings.settings,
        stats: stats.stats,
        payouts: payouts.payouts,
        referrals: referrals.referrals,
        proposals: proposals.proposals,
        verifications: verifications.verifications,
        aging: aging.aging,
        agingDays: aging.days,
        dentally,
        reviews: reviews.reviews,
        funnel: funnel.funnel,
        topReferrers: top.topReferrers,
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

  // Landing back from Dentally's OAuth approval screen (?dentally=connected|error).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('dentally');
    if (!outcome) return;
    setToast(
      outcome === 'connected'
        ? 'Dentally connected — completed treatments will now be proposed automatically.'
        : `Dentally connection failed: ${params.get('reason') ?? 'unknown error'}. Try again or check the API log.`,
    );
    window.history.replaceState({}, '', window.location.pathname);
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
        <p className="loading">Loading…</p>
      ) : (
        <main>
          <StatsStrip stats={data.stats} />
          <Zone label="Needs attention">
            <div className="zone-grid">
              <ConfirmQueue proposals={data.proposals} onChanged={loadAll} notify={notify} />
              <PayoutQueue payouts={data.payouts} onChanged={loadAll} notify={notify} />
              <VerificationQueue verifications={data.verifications} onChanged={loadAll} notify={notify} />
              <ReferralReviewQueue reviews={data.reviews} onChanged={loadAll} notify={notify} />
              <AgingReport aging={data.aging} days={data.agingDays} />
            </div>
          </Zone>
          <PipelineBoard referrals={data.referrals} onChanged={loadAll} notify={notify} />
          <Zone label="Reports">
            <div className="zone-grid-wide">
              <FunnelReport
                key={`invites:${data.funnel.inviteSent}`}
                funnel={data.funnel}
                onChanged={loadAll}
                notify={notify}
              />
              <TopReferrers topReferrers={data.topReferrers} />
            </div>
          </Zone>
          <Zone label="Setup">
            <div className="zone-grid-wide">
              <Levers
                key={`${data.stats.commissionPennies}:${data.settings.payout_threshold_pennies}:${data.settings.payout_expiry_days}`}
                commissionPennies={data.stats.commissionPennies}
                settings={data.settings}
                onChanged={loadAll}
                notify={notify}
              />
              <DentallyCard status={data.dentally} onChanged={loadAll} notify={notify} />
            </div>
          </Zone>
        </main>
      )}
    </div>
  );
}
