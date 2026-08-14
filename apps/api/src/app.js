// Express app assembly (imported by server.js and by tests via supertest).
import express from 'express';
import cors from 'cors';
import {
  otpSendSchema,
  otpVerifySchema,
  profileSchema,
  roleSchema,
  referralSubmitSchema,
  statusUpdateSchema,
  payoutRequestSchema,
} from '@gm-referral/shared/schemas';
import { db } from './db.js';
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
  submitReferral,
  updateStatus,
  referralsForReferrer,
  referredStatusFor,
} from './services/referralService.js';
import { walletFor, requestPayout, markPayoutPaid, cancelPayout, getSetting } from './services/walletService.js';
import { requireUser, requireAdmin } from './middleware/auth.js';

const validate = (schema) => (req, res, next) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ error: 'validation', details: parsed.error.issues.map((i) => i.message) });
  }
  req.data = parsed.data;
  return next();
};

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

export function buildApp() {
  const app = express();
  app.use(cors());
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
    const { rows } = await db.query('select id, name from practices where active order by name');
    res.json({ practices: rows });
  }));

  // ---- referrals ----
  app.post('/referrals', requireUser, validate(referralSubmitSchema), wrap(async (req, res) => {
    const referral = await submitReferral({ ...req.data, consentVersion: req.data.consentVersion, referredUser: req.user });
    const { rows } = await db.query('select name from practices where id=$1', [req.data.preferredPracticeId]);
    res.json({ ok: true, referral: { id: referral.id, status: referral.status }, practiceName: rows[0]?.name });
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

  app.delete('/payouts/:id', requireUser, wrap(async (req, res) => {
    res.json(await cancelPayout(req.params.id, req.user.id));
  }));

  // ---- admin (dev-gated; real admin auth lands with the admin web app) ----
  app.get('/admin/referrals', requireUser, requireAdmin, wrap(async (_req, res) => {
    const { rows } = await db.query(
      `select r.id, r.referred_name, r.referred_phone, r.status, r.treatment_interest,
              p.name as practice, u.first_name || ' ' || coalesce(u.last_name,'') as referrer
       from referrals r
       left join practices p on p.id = r.preferred_practice_id
       join users u on u.id = r.referrer_id
       order by r.created_at desc`,
    );
    res.json({ referrals: rows });
  }));

  app.patch('/admin/referrals/:id/status', requireUser, requireAdmin, validate(statusUpdateSchema), wrap(async (req, res) => {
    const out = await updateStatus({
      referralId: req.params.id,
      status: req.data.status,
      lostReason: req.data.lostReason,
      actorId: req.user.id,
      privilegedComplete: true,
    });
    res.json(out);
  }));

  app.get('/admin/payouts', requireUser, requireAdmin, wrap(async (_req, res) => {
    const { rows } = await db.query(
      `select pr.id, pr.amount_pennies, pr.status, pr.requested_at, p.name as practice,
              u.first_name || ' ' || coalesce(u.last_name,'') as member
       from payout_requests pr
       join practices p on p.id = pr.practice_id
       join users u on u.id = pr.user_id
       order by pr.requested_at desc`,
    );
    res.json({ payouts: rows });
  }));

  app.post('/admin/payouts/:id/mark-paid', requireUser, requireAdmin, wrap(async (req, res) => {
    res.json(await markPayoutPaid(req.params.id, req.user.id));
  }));

  app.get('/admin/settings', requireUser, requireAdmin, wrap(async (_req, res) => {
    const { rows } = await db.query('select key, value from app_settings order by key');
    res.json({ settings: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
  }));

  app.put('/admin/settings', requireUser, requireAdmin, wrap(async (req, res) => {
    const entries = Object.entries(req.body ?? {}).filter(([k]) =>
      ['payout_threshold_pennies', 'payout_expiry_days', 'otp_channel_mode'].includes(k),
    );
    for (const [key, value] of entries) {
      await db.query(
        `insert into app_settings (key, value, updated_by) values ($1,$2,$3)
         on conflict (key) do update set value=$2, updated_by=$3, updated_at=now()`,
        [key, String(value), req.user.id],
      );
    }
    res.json({ ok: true, updated: entries.map(([k]) => k) });
  }));

  app.put('/admin/reward-amount', requireUser, requireAdmin, wrap(async (req, res) => {
    const amount = Number(req.body?.amountPennies);
    if (!Number.isSafeInteger(amount) || amount <= 0) return res.status(422).json({ error: 'validation' });
    await db.query(
      `insert into reward_rules (practice_id, type, amount_pennies, created_by) values (null,'fixed',$1,$2)`,
      [amount, req.user.id],
    );
    res.json({ ok: true, amountPennies: amount });
  }));

  // ---- error boundary ----
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error('[api]', err);
    res.status(status).json({ error: err.message ?? 'internal' });
  });

  return app;
}
