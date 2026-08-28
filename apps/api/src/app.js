// Express app assembly (imported by server.js and by tests via supertest).
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import {
  otpSendSchema,
  otpVerifySchema,
  profileSchema,
  roleSchema,
  referralSubmitSchema,
  statusUpdateSchema,
  payoutRequestSchema,
  adminLoginSchema,
} from '@gm-referral/shared/schemas';
import { db, logEvent } from './db.js';
import { sendOtp, verifyOtp } from './services/otpService.js';
import {
  getOrCreateUserByPhone,
  issueToken,
  saveProfile,
  pickRole,
  publicUser,
  publicUserWithCode,
} from './services/userService.js';
import {
  authenticate,
  publicAdmin,
  practicesForAdmin,
  createAdmin,
  listAdmins,
  setPassword,
  setActive,
  setPractice,
  changeOwnPassword,
  normalizePracticeIds,
} from './services/adminService.js';
import {
  submitReferral,
  updateStatus,
  referralsForReferrer,
  referredStatusFor,
  firstNameInitial,
} from './services/referralService.js';
import { walletFor, requestPayout, markPayoutPaid, cancelPayout, getSetting, resolveRule } from './services/walletService.js';
import { runSync, agingReport } from './services/dentally/syncService.js';
import {
  openProposals,
  confirmProposal,
  rejectProposal,
  pendingVerifications,
  decideVerification,
} from './services/dentally/proposalService.js';
import { stubAddBookedAppointment, stubAddCompletedTreatment, stubAddPatient } from './services/dentally/client.js';
import {
  connectionStatus,
  buildAuthorizeUrl,
  handleOauthCallback,
  disconnect as disconnectDentally,
  resolveDentallyMode,
} from './services/dentally/connectionService.js';
import { requireUser, requireAdmin } from './middleware/auth.js';
import { config, isDev } from './config.js';

// Shared 422 envelope for every zod rejection in this file — {error, details: [message, ...]}
// — so a body-shape failure (validate) and a route-param-shape failure (requireUuidParam) come
// back looking identical to a caller, not two different ad hoc shapes.
const validationError = (zodError) => ({ error: 'validation', details: zodError.issues.map((i) => i.message) });

const validate = (schema) => (req, res, next) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json(validationError(parsed.error));
  req.data = parsed.data;
  return next();
};

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

// A malformed :id (e.g. "not-a-uuid") reaching a raw `where id = $1` against a uuid column is a
// Postgres 22P02 (invalid input syntax for type uuid) — an uncaught error with no .status, so the
// global error boundary would 500 it verbatim, leaking raw DB text. Reject the shape at the route
// instead, before it ever reaches a query; a well-formed-but-unknown id still 404s downstream.
const uuidParamSchema = z.string().uuid({ message: 'must be a uuid' });
const requireUuidParam = (name) => (req, res, next) => {
  const parsed = uuidParamSchema.safeParse(req.params[name]);
  if (!parsed.success) return res.status(422).json(validationError(parsed.error));
  return next();
};

// FR-24: two roles now — `admin` sees/acts on every practice (createAdmin never lets an
// admin carry practice ids, so this is unconditional, not just "empty means all"); `manager`
// is scoped to exactly one practice. A manager row with an empty practiceIds (shouldn't arise
// through createAdmin, but the fence still holds defensively) sees/acts on NOTHING rather than
// falling through to "all".
//
// practiceScope: for reads — a Postgres array literal (cast with ::uuid[] in SQL), or null
// for "no filter" (admin). '{}' for a scopeless manager matches no rows.
const practiceScope = (req) => {
  if (!req.admin) return '{}'; // fail closed: no admin context on the request means no access
  if (req.admin.role === 'admin') return null;
  return `{${req.admin.practiceIds.join(',')}}`;
};

// actionScope: for writes (mark-paid/cancel) — null means unrestricted (admin); otherwise
// the ids array is handed to assertInScope in walletService.js, which rejects anything
// outside it — so a scopeless manager's `[]` (and a missing req.admin's `[]`) rejects every
// practice, never falling through to "all".
const actionScope = (req) => {
  if (!req.admin) return []; // fail closed
  if (req.admin.role === 'admin') return null;
  return req.admin.practiceIds;
};

export function buildApp() {
  const app = express();
  // One hop: Railway's edge. Without this, req.ip (used by the admin login rate limiter)
  // is the same internal proxy address for every request, collapsing the per-IP bucket into
  // one shared global one — 30 bad logins from anyone would 429 every admin for 15 minutes.
  app.set('trust proxy', 1);
  app.use(cors());

  // Dentally webhook (FR-16d): a doorbell, not an ingestion path — the body is never
  // ingested, it only triggers an immediate sync pass. Two callers, two auths:
  //   • Dentally itself: HMAC over the RAW body (hence registered before express.json)
  //   • the Dental Os database trigger: static x-gmref-secret header (same secret)
  // 204 for everything valid, including unknown events.
  app.post('/webhooks/dentally', express.raw({ type: '*/*' }), (req, res) => {
    const secret = config.dentally.webhookSecret;
    if (!secret) {
      if (!isDev) return res.status(503).json({ error: 'webhook_not_configured' });
      // Dev without a secret: accept, so local/staging can be exercised before one is set.
    } else {
      const eq = (given, expected) => {
        const a = Buffer.from(String(given));
        const b = Buffer.from(expected);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
      };
      const hmac = crypto.createHmac('sha256', secret).update(req.body ?? Buffer.alloc(0)).digest('hex');
      const signatureOk = eq(req.headers['x-dentally-signature'] ?? '', hmac);
      const doorbellOk = eq(req.headers['x-gmref-secret'] ?? '', secret);
      if (!signatureOk && !doorbellOk) return res.status(401).json({ error: 'invalid_signature' });
    }
    res.status(204).end(); // respond fast; Dentally retries non-2xx up to 10 times
    runSync('webhook').catch(() => {}); // runSync logs its own failures
  });

  app.use(express.json());

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // ---- auth ----
  app.post('/auth/otp/send', validate(otpSendSchema), wrap(async (req, res) => {
    res.json(await sendOtp(req.data.phone));
  }));

  app.post('/auth/otp/verify', validate(otpVerifySchema), wrap(async (req, res) => {
    await verifyOtp(req.data.phone, req.data.code);
    const user = await getOrCreateUserByPhone(req.data.phone);
    res.json({ ok: true, token: issueToken(user), user: await publicUserWithCode(user) });
  }));

  // Dashboard accounts: email + password, its own identity table (admin_users), not a
  // patient session. See middleware/auth.js requireAdmin / services/adminService.js.
  app.post('/auth/admin/login', validate(adminLoginSchema), wrap(async (req, res) => {
    const { token, admin } = await authenticate(req.data.email, req.data.password, { ip: req.ip });
    res.json({ token, admin });
  }));

  // ---- me ----
  app.get('/me', requireUser, wrap(async (req, res) => {
    res.json({ user: await publicUserWithCode(req.user) });
  }));

  app.post('/me/profile', requireUser, validate(profileSchema), wrap(async (req, res) => {
    const user = await saveProfile(req.user.id, req.data);
    res.json({ ok: true, user: await publicUserWithCode(user) });
  }));

  app.post('/me/role', requireUser, validate(roleSchema), wrap(async (req, res) => {
    await pickRole(req.user.id, req.data.role);
    const { rows } = await db.query('select * from users where id=$1', [req.user.id]);
    res.json({ ok: true, user: await publicUserWithCode(rows[0]) });
  }));

  // ---- reference data ----
  app.get('/practices', wrap(async (_req, res) => {
    const { rows } = await db.query('select id, name, booking_url from practices where active order by name');
    res.json({ practices: rows.map((p) => ({ id: p.id, name: p.name, bookingUrl: p.booking_url })) });
  }));

  // ---- referrals ----
  app.post('/referrals', requireUser, validate(referralSubmitSchema), wrap(async (req, res) => {
    const referral = await submitReferral({ ...req.data, consentVersion: req.data.consentVersion, referredUser: req.user });
    const { rows } = await db.query('select name, booking_url from practices where id=$1', [req.data.preferredPracticeId]);
    res.json({
      ok: true,
      referral: { id: referral.id, status: referral.status },
      practiceName: rows[0]?.name,
      bookingUrl: rows[0]?.booking_url ?? null,
    });
  }));

  app.get('/referrals/mine', requireUser, wrap(async (req, res) => {
    res.json({ referrals: await referralsForReferrer(req.user.id) });
  }));

  app.get('/referrals/referred-status', requireUser, wrap(async (req, res) => {
    res.json((await referredStatusFor(req.user.id)) ?? { status: 'new' });
  }));

  // ---- wallet & payouts ----
  app.get('/wallet', requireUser, wrap(async (req, res) => {
    res.json({ wallet: await walletFor(req.user.id) });
  }));

  app.post('/payouts', requireUser, validate(payoutRequestSchema), wrap(async (req, res) => {
    const payout = await requestPayout(req.user.id, req.data.practiceId);
    const { rows } = await db.query('select name from practices where id=$1', [payout.practice_id]);
    res.json({ ok: true, payout: { id: payout.id, amountPennies: payout.amount_pennies, practiceName: rows[0]?.name, status: payout.status } });
  }));

  app.delete('/payouts/:id', requireUser, requireUuidParam('id'), wrap(async (req, res) => {
    res.json(await cancelPayout(req.params.id, req.user.id));
  }));

  // ---- instrumentation (FR-28): client-side funnel events from the mobile app ----
  const CLIENT_EVENTS = ['app_activated', 'share_tapped', 'code_entered'];
  app.post('/events', requireUser, wrap(async (req, res) => {
    const name = req.body?.name;
    if (!CLIENT_EVENTS.includes(name)) return res.status(422).json({ error: 'validation' });
    await db.query(
      `insert into analytics_events (user_id, name, properties) values ($1,$2,$3)`,
      [req.user.id, name, JSON.stringify(req.body?.properties ?? {})],
    );
    res.json({ ok: true });
  }));

  // ---- admin (gate reads admin_users; email+password identity — see middleware/auth.js) ----
  // FR-24: what the dashboard uses to pick a view — a manager's single practice vs. an
  // admin's full practice list.
  app.get('/admin/me', requireAdmin, wrap(async (req, res) => {
    const practices = await practicesForAdmin(req.admin);
    res.json(publicAdmin(req.admin, practices));
  }));

  // ---- team management (FR-24): admin-only — the manager fence in middleware/auth.js
  // (MANAGER_ALLOWED) blocks every /admin/team* route before it reaches here. Every
  // mutation logs an events row (entity_type 'admin_user') so who-changed-what is auditable.
  app.get('/admin/team', requireAdmin, wrap(async (_req, res) => {
    res.json({ team: await listAdmins() });
  }));

  // Validation lives entirely in createAdmin() (adminCreateSchema + its own weak_password /
  // practice_required / email_taken checks) — kept as the single source of truth rather than
  // re-validating here, so the error code a bad request gets back never depends on which
  // caller (this route, scripts/create-admin.js, a test) reached it.
  app.post('/admin/team', requireAdmin, wrap(async (req, res) => {
    const row = await createAdmin({
      email: req.body?.email,
      password: req.body?.password,
      role: req.body?.role,
      practiceIds: req.body?.practiceId ? [req.body.practiceId] : [],
      createdBy: req.admin.id,
    });
    const practices = await practicesForAdmin({ role: row.role, practiceIds: normalizePracticeIds(row.practice_ids) });
    res.json({ admin: publicAdmin(row, practices) });
  }));

  // { password } — sets a new hash for :id and bumps its sessions_revoked_at, so every token
  // issued before this call dies.
  app.post('/admin/team/:id/password', requireAdmin, requireUuidParam('id'), wrap(async (req, res) => {
    res.json(await setPassword({ id: req.params.id, password: req.body?.password, actorId: req.admin.id }));
  }));

  // { practiceId } — move a manager to another practice (FR-24). Admin-only like the rest of
  // /admin/team*; an admin target is a 422, since an admin isn't practice-scoped at all.
  app.post('/admin/team/:id/practice', requireAdmin, requireUuidParam('id'), wrap(async (req, res) => {
    res.json(await setPractice({ id: req.params.id, practiceId: req.body?.practiceId, actorId: req.admin.id }));
  }));

  // { active: boolean } — 409 cannot_deactivate_self / last_admin guard which admins this can
  // touch; deactivating also bumps sessions_revoked_at. `active` must be a real JSON boolean —
  // a missing/malformed value (e.g. the string "true", or an absent field) previously fell
  // through `=== true` to `false` and silently deactivated the target instead of rejecting.
  app.post('/admin/team/:id/active', requireAdmin, requireUuidParam('id'), wrap(async (req, res) => {
    if (typeof req.body?.active !== 'boolean') return res.status(422).json({ error: 'validation' });
    res.json(await setActive({ id: req.params.id, active: req.body.active, actorId: req.admin.id }));
  }));

  // Both roles reach this one (see MANAGER_ALLOWED): { currentPassword, newPassword } — wrong
  // current -> 401 wrong_password; on success, sessions_revoked_at is bumped for THIS admin
  // too, so the response carries a fresh token in the same breath.
  app.post('/admin/me/password', requireAdmin, wrap(async (req, res) => {
    res.json(await changeOwnPassword({
      admin: req.admin,
      currentPassword: req.body?.currentPassword,
      newPassword: req.body?.newPassword,
    }));
  }));

  app.get('/admin/referrals', requireAdmin, wrap(async (req, res) => {
    const scope = practiceScope(req);
    const { rows } = await db.query(
      `select r.id, r.referred_name, r.referred_phone, r.referred_email, r.status, r.treatment_interest,
              r.appointment_starts_at, r.created_at::date::text as created_at, r.source,
              p.name as practice, u.first_name || ' ' || coalesce(u.last_name,'') as referrer,
              u.phone as referrer_phone, rc.code as referrer_code,
              wl.amount_pennies as commission_pennies, wl.created_at::date::text as commission_at
       from referrals r
       left join practices p on p.id = r.preferred_practice_id
       join users u on u.id = r.referrer_id
       left join lateral (
         select code from referral_codes
         where user_id = r.referrer_id and active
         order by created_at desc limit 1
       ) rc on true
       left join wallet_ledger wl on wl.referral_id = r.id and wl.kind = 'credit'
       ${scope ? 'where r.preferred_practice_id = any($1::uuid[])' : ''}
       order by r.created_at desc`,
      scope ? [scope] : [],
    );
    res.json({ referrals: rows });
  }));

  app.patch('/admin/referrals/:id/status', requireAdmin, requireUuidParam('id'), validate(statusUpdateSchema), wrap(async (req, res) => {
    const out = await updateStatus({
      referralId: req.params.id,
      status: req.data.status,
      lostReason: req.data.lostReason,
      actorId: req.admin.id,
      actorKind: 'admin',
      privilegedComplete: true,
    });
    res.json(out);
  }));

  // Reception needs enough to verify identity and see the credits behind the balance:
  // the member's phone, their active referral code, and their unpaid credits (a second
  // query keyed by user id, since it's a one-to-many the main row can't carry cleanly).
  app.get('/admin/payouts', requireAdmin, wrap(async (req, res) => {
    const scope = practiceScope(req);
    const { rows } = await db.query(
      `select pr.id, pr.user_id, pr.amount_pennies, pr.status, pr.requested_at, p.name as practice,
              u.first_name || ' ' || coalesce(u.last_name,'') as member, u.phone,
              rc.code as referral_code
       from payout_requests pr
       join practices p on p.id = pr.practice_id
       join users u on u.id = pr.user_id
       left join lateral (
         select code from referral_codes
         where user_id = pr.user_id and active
         order by created_at desc limit 1
       ) rc on true
       ${scope ? 'where pr.practice_id = any($1::uuid[])' : ''}
       order by pr.requested_at desc`,
      scope ? [scope] : [],
    );

    // Credits are only meaningful behind an OPEN request (what reception is about to pay
    // out); a settled row's balance has already moved, so it always gets credits: [].
    const openUserIds = [...new Set(rows.filter((r) => r.status === 'open').map((r) => r.user_id))];
    const creditsByUser = new Map();
    if (openUserIds.length) {
      const { rows: creditRows } = await db.query(
        `select wl.user_id, wl.amount_pennies, wl.created_at::date::text as at, r.referred_name
         from wallet_ledger wl
         left join referrals r on r.id = wl.referral_id
         where wl.kind = 'credit' and wl.user_id = any($1::uuid[])
           and wl.created_at > coalesce(
             (select max(pr2.paid_at) from payout_requests pr2 where pr2.user_id = wl.user_id and pr2.status = 'paid'),
             '-infinity'::timestamptz
           )
         order by wl.created_at`,
        [`{${openUserIds.join(',')}}`],
      );
      for (const c of creditRows) {
        const list = creditsByUser.get(c.user_id) ?? [];
        list.push({
          friend: c.referred_name ? firstNameInitial(c.referred_name) : 'Referral',
          amountPennies: c.amount_pennies,
          at: c.at,
        });
        creditsByUser.set(c.user_id, list);
      }
    }

    res.json({
      payouts: rows.map(({ user_id, ...row }) => ({
        ...row,
        credits: row.status === 'open' ? (creditsByUser.get(user_id) ?? []) : [],
      })),
    });
  }));

  // Mark-paid requires the manager/admin to type the amount they physically handed over —
  // it must match the request exactly, not just be trusted from the row (FR-24).
  app.post('/admin/payouts/:id/mark-paid', requireAdmin, requireUuidParam('id'), wrap(async (req, res) => {
    const amountPennies = req.body?.amountPennies;
    if (!Number.isInteger(amountPennies) || amountPennies <= 0) {
      return res.status(422).json({ error: 'amount_required' });
    }
    res.json(await markPayoutPaid(req.params.id, req.admin.id, { amountPennies, practiceIds: actionScope(req) }));
  }));

  // FR-21: admin cancel needs a reason; the member keeps their balance and is notified.
  app.post('/admin/payouts/:id/cancel', requireAdmin, requireUuidParam('id'), wrap(async (req, res) => {
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) return res.status(422).json({ error: 'reason_required' });
    res.json(await cancelPayout(req.params.id, req.admin.id, { byAdmin: true, reason, practiceIds: actionScope(req) }));
  }));

  app.get('/admin/settings', requireAdmin, wrap(async (_req, res) => {
    const { rows } = await db.query('select key, value from app_settings order by key');
    res.json({ settings: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
  }));

  app.put('/admin/settings', requireAdmin, wrap(async (req, res) => {
    const entries = Object.entries(req.body ?? {}).filter(([k]) =>
      // invite_sent_manual_count: FR-28's hand-entered GHL campaign count (CSV upload is Phase 2).
      ['payout_threshold_pennies', 'payout_expiry_days', 'otp_channel_mode', 'invite_sent_manual_count'].includes(k),
    );
    for (const [key, value] of entries) {
      await db.query(
        `insert into app_settings (key, value, updated_by) values ($1,$2,$3)
         on conflict (key) do update set value=$2, updated_by=$3, updated_at=now()`,
        [key, String(value), req.admin.id],
      );
    }
    res.json({ ok: true, updated: entries.map(([k]) => k) });
  }));

  app.get('/admin/stats', requireAdmin, wrap(async (_req, res) => {
    const rule = await resolveRule(null);
    const liability = await db.query(
      `select coalesce(sum(balance),0)::int as total from
         (select sum(amount_pennies)::int as balance from wallet_ledger group by user_id) b
       where balance > 0`,
    );
    const counts = await db.query(`select status, count(*)::int as n from referrals group by status`);
    res.json({
      stats: {
        commissionPennies: rule?.amount_pennies ?? null,
        liabilityPennies: liability.rows[0].total,
        referralCounts: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])),
      },
    });
  }));

  app.put('/admin/reward-amount', requireAdmin, wrap(async (req, res) => {
    const amount = Number(req.body?.amountPennies);
    if (!Number.isSafeInteger(amount) || amount <= 0) return res.status(422).json({ error: 'validation' });
    await db.query(
      `insert into reward_rules (practice_id, type, amount_pennies, created_by) values (null,'fixed',$1,$2)`,
      [amount, req.admin.id],
    );
    res.json({ ok: true, amountPennies: amount });
  }));

  // ---- dentally: proposals, verifications, aging, sync (FR-16/17/25 admin surfaces) ----
  app.get('/admin/proposals', requireAdmin, wrap(async (_req, res) => {
    res.json({ proposals: await openProposals() });
  }));

  app.post('/admin/proposals/:id/confirm', requireAdmin, requireUuidParam('id'), wrap(async (req, res) => {
    res.json(await confirmProposal(req.params.id, req.admin.id));
  }));

  app.post('/admin/proposals/:id/reject', requireAdmin, requireUuidParam('id'), wrap(async (req, res) => {
    res.json(await rejectProposal(req.params.id, req.admin.id, req.body?.reason));
  }));

  app.get('/admin/verifications', requireAdmin, wrap(async (_req, res) => {
    res.json({ verifications: await pendingVerifications() });
  }));

  app.post('/admin/verifications/:id/approve', requireAdmin, requireUuidParam('id'), wrap(async (req, res) => {
    res.json(await decideVerification(req.params.id, req.admin.id, { approve: true, dentallyPatientId: req.body?.dentallyPatientId }));
  }));

  app.post('/admin/verifications/:id/reject', requireAdmin, requireUuidParam('id'), wrap(async (req, res) => {
    res.json(await decideVerification(req.params.id, req.admin.id, { approve: false }));
  }));

  app.get('/admin/aging', requireAdmin, wrap(async (req, res) => {
    const days = Number.isSafeInteger(Number(req.query.days)) && Number(req.query.days) > 0 ? Number(req.query.days) : 7;
    res.json({ aging: await agingReport(days), days });
  }));

  app.post('/admin/sync/run', requireAdmin, wrap(async (_req, res) => {
    res.json(await runSync('admin'));
  }));

  // ---- referral review (FR-25): existing-patient suspects ----
  app.get('/admin/referral-review', requireAdmin, wrap(async (req, res) => {
    const scope = practiceScope(req);
    const { rows } = await db.query(
      `select r.id, r.referred_name, r.referred_phone, r.status, r.created_at, p.name as practice,
              u.first_name || ' ' || coalesce(u.last_name,'') as referrer
       from referrals r
       left join practices p on p.id = r.preferred_practice_id
       join users u on u.id = r.referrer_id
       where r.review_status = 'existing_patient_suspect' and r.status <> 'lost'
         ${scope ? 'and r.preferred_practice_id = any($1::uuid[])' : ''}
       order by r.created_at`,
      scope ? [scope] : [],
    );
    res.json({ reviews: rows });
  }));

  app.post('/admin/referral-review/:id/decide', requireAdmin, requireUuidParam('id'), wrap(async (req, res) => {
    const decision = req.body?.decision;
    if (!['clear', 'existing_patient'].includes(decision)) return res.status(422).json({ error: 'validation' });
    const { rows } = await db.query(
      `select * from referrals where id=$1 and review_status='existing_patient_suspect'`,
      [req.params.id],
    );
    if (!rows[0] || rows[0].status === 'lost') return res.status(409).json({ error: 'not_in_review' });
    if (decision === 'clear') {
      await db.query(`update referrals set review_status='cleared' where id=$1`, [req.params.id]);
    } else {
      // Confirmed existing patient: lost, never creditable (FR-25).
      await db.query(
        `update referrals set status='lost', lost_reason='existing_patient' where id=$1`,
        [req.params.id],
      );
    }
    await logEvent(db, {
      actorId: req.admin.id, actorKind: 'admin', entityType: 'referral', entityId: req.params.id,
      action: 'review_decided', fromValue: 'existing_patient_suspect', toValue: decision,
    });
    res.json({ ok: true, decision });
  }));

  // ---- reports (FR-25 funnel + top referrers, FR-28 tripwire) ----
  app.get('/admin/reports/funnel', requireAdmin, wrap(async (_req, res) => {
    const { rows: events } = await db.query(`select name, count(*)::int as n from analytics_events group by name`);
    const byName = Object.fromEntries(events.map((e) => [e.name, e.n]));
    const { rows: statuses } = await db.query(`select status, count(*)::int as n from referrals group by status`);
    const byStatus = Object.fromEntries(statuses.map((s) => [s.status, s.n]));
    const { rows: [credits] } = await db.query(`select count(*)::int as n from wallet_ledger where kind='credit'`);
    const { rows: [paid] } = await db.query(`select count(*)::int as n from payout_requests where status='paid'`);
    const codeEntered = byName.code_entered ?? 0;
    const submitted = byName.referral_submitted ?? 0;
    res.json({
      funnel: {
        // Externally sourced and hand-entered (FR-28); the UI labels it as manual.
        inviteSent: Number(await getSetting('invite_sent_manual_count', '0')),
        appActivated: byName.app_activated ?? 0,
        shareTapped: byName.share_tapped ?? 0, // noisy: share-sheet opens ≠ messages sent
        codeEntered,
        referralSubmitted: submitted,
        // Reached-booked-or-beyond; lost referrals drop out (MVP approximation from current status).
        consultBooked:
          (byStatus.booked ?? 0) + (byStatus.attended ?? 0) + (byStatus.treatment_agreed ?? 0) +
          (byStatus.treatment_completed ?? 0),
        treatmentCompleted: byStatus.treatment_completed ?? 0,
        commissionsCredited: credits.n,
        payoutsPaid: paid.n,
        // FR-28 tripwire: code_entered → referral_submitted completion. Null until
        // code_entered flows in (store-build instrumentation).
        tripwireRate: codeEntered > 0 ? submitted / codeEntered : null,
      },
    });
  }));

  app.get('/admin/reports/top-referrers', requireAdmin, wrap(async (_req, res) => {
    const { rows } = await db.query(
      `select u.id, u.first_name || ' ' || coalesce(u.last_name,'') as name,
              count(distinct r.id)::int as referrals,
              count(distinct r.id) filter (where r.status = 'treatment_completed')::int as completed,
              coalesce(sum(l.amount_pennies),0)::int as credited_pennies
       from users u
       join referrals r on r.referrer_id = u.id
       left join wallet_ledger l on l.referral_id = r.id and l.kind = 'credit'
       group by u.id, u.first_name, u.last_name
       order by credited_pennies desc, completed desc, referrals desc
       limit 10`,
    );
    res.json({ topReferrers: rows });
  }));

  // FR-03: "sign out everywhere" for a compromised or offboarded patient account.
  app.post('/admin/users/:id/revoke-sessions', requireAdmin, requireUuidParam('id'), wrap(async (req, res) => {
    const { rows } = await db.query(
      `update users set sessions_revoked_at=now() where id=$1 returning id`,
      [req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    await logEvent(db, { actorId: req.admin.id, actorKind: 'admin', entityType: 'user', entityId: req.params.id, action: 'sessions_revoked' });
    res.json({ ok: true });
  }));

  // ---- dentally OAuth (admin "Connect Dentally" button) ----
  app.get('/admin/dentally/status', requireAdmin, wrap(async (_req, res) => {
    res.json(await connectionStatus());
  }));

  app.post('/admin/dentally/connect', requireAdmin, wrap(async (req, res) => {
    res.json({ url: buildAuthorizeUrl(req.admin.id) });
  }));

  app.post('/admin/dentally/disconnect', requireAdmin, wrap(async (req, res) => {
    res.json(await disconnectDentally(req.admin.id));
  }));

  // Dentally redirects the practice owner's browser here after they approve access.
  // No bearer auth (it's a top-level browser navigation) — the signed state is the auth.
  app.get('/oauth/dentally/callback', wrap(async (req, res) => {
    const back = (q) => res.redirect(`${config.dentally.adminUrl}/?${q}`);
    if (req.query.error) return back(`dentally=error&reason=${encodeURIComponent(req.query.error)}`);
    try {
      await handleOauthCallback({ code: req.query.code, state: req.query.state });
      runSync('oauth-connected').catch(() => {}); // first pass immediately after connecting
      return back('dentally=connected');
    } catch (err) {
      return back(`dentally=error&reason=${encodeURIComponent(err.message)}`);
    }
  }));

  // Dev-only: inject a completed+paid treatment into the Dentally stub and sync at once —
  // lets the whole propose→confirm→credit loop run with zero real Dentally access.
  if (isDev) {
    app.post('/dev/dentally/complete-treatment', wrap(async (req, res) => {
      if ((await resolveDentallyMode()) !== 'stub') return res.status(409).json({ error: 'dentally_not_stub' });
      const { phone, practiceId = null, amountPennies = 34000 } = req.body ?? {};
      if (!phone) return res.status(422).json({ error: 'phone_required' });
      if (practiceId) {
        // Stub convention: a practice's Dentally site id is its own uuid.
        await db.query(`update practices set dentally_site_id=$1 where id=$1::uuid`, [practiceId]);
      }
      stubAddCompletedTreatment({ phone, siteId: practiceId, amountPennies });
      res.json({ ok: true, sync: await runSync('dev-endpoint') });
    }));

    app.post('/dev/dentally/book-appointment', wrap(async (req, res) => {
      if ((await resolveDentallyMode()) !== 'stub') return res.status(409).json({ error: 'dentally_not_stub' });
      const { phone, practiceId = null, startsAt } = req.body ?? {};
      if (!phone) return res.status(422).json({ error: 'phone_required' });
      if (practiceId) {
        await db.query(`update practices set dentally_site_id=$1 where id=$1::uuid`, [practiceId]);
      }
      stubAddBookedAppointment({ phone, siteId: practiceId, ...(startsAt ? { startsAt } : {}) });
      res.json({ ok: true, sync: await runSync('dev-endpoint') });
    }));

    app.post('/dev/dentally/add-patient', wrap(async (req, res) => {
      if ((await resolveDentallyMode()) !== 'stub') return res.status(409).json({ error: 'dentally_not_stub' });
      const { phone, practiceId = null } = req.body ?? {};
      if (!phone) return res.status(422).json({ error: 'phone_required' });
      if (practiceId) {
        await db.query(`update practices set dentally_site_id=$1 where id=$1::uuid`, [practiceId]);
      }
      stubAddPatient({ phone, siteId: practiceId });
      res.json({ ok: true, sync: await runSync('dev-endpoint') });
    }));
  }

  // ---- error boundary ----
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status ?? 500;
    // A 5xx is our bug, not something the caller can act on, and `err.message` there is
    // whatever threw — typically raw Postgres text carrying table/column names and sometimes
    // parameter values. Log the real error, answer with one opaque code. 4xx errors are
    // deliberate, thrown with a code as their message, and keep carrying it.
    if (status >= 500) {
      console.error('[api]', err);
      return res.status(status).json({ error: 'internal' });
    }
    return res.status(status).json({ error: err.message ?? 'internal' });
  });

  return app;
}
