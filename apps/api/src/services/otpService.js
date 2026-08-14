// OTP service — Express-fronted policy (FR-01/FR-02), dev delivery mode.
// Dev mode: code is hashed into otp_deliveries and printed to the API console.
// Production swaps delivery for the Supabase-issued flow (FR-02a); the policy here stays.
import crypto from 'node:crypto';
import { db } from '../db.js';
import { config, isDev } from '../config.js';

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_SENDS_PER_WINDOW = 3;
const SEND_WINDOW_MS = 5 * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;

const hash = (code) => crypto.createHash('sha256').update(code).digest('hex');

export async function sendOtp(phone) {
  // Rate limit: counters are rows in otp_deliveries (survives restarts; Perf finding 6A).
  const { rows: recent } = await db.query(
    `select count(*)::int as n from otp_deliveries where phone = $1 and created_at > now() - interval '5 minutes'`,
    [phone],
  );
  if (recent[0].n >= MAX_SENDS_PER_WINDOW) {
    const err = new Error('rate_limited');
    err.status = 429;
    throw err;
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await db.query(
    `insert into otp_deliveries (phone, code_hash, channel, expires_at) values ($1, $2, $3, now() + interval '5 minutes')`,
    [phone, hash(code), config.otpChannelMode],
  );

  // Delivery. Dev: console. (WhatsApp/SMS delivery lands with the Meta/SMS accounts.)
  console.log(`[otp] ${phone} -> code ${code} (dev mode)`);

  return { ok: true, ...(isDev ? { devHint: `Dev code: ${code}` } : {}) };
}

export async function verifyOtp(phone, code) {
  const { rows } = await db.query(
    `select id, code_hash, attempts, expires_at from otp_deliveries
     where phone = $1 and expires_at > now()
     order by created_at desc limit 1`,
    [phone],
  );
  const record = rows[0];
  const fail = (status = 401) => {
    const err = new Error('invalid_otp');
    err.status = status;
    return err;
  };
  if (!record) throw fail();
  if (record.attempts >= MAX_VERIFY_ATTEMPTS) throw fail(429);

  await db.query(`update otp_deliveries set attempts = attempts + 1 where id = $1`, [record.id]);
  if (record.code_hash !== hash(code)) throw fail();

  // Consumed: delete every outstanding code for this phone.
  await db.query(`delete from otp_deliveries where phone = $1`, [phone]);
  return true;
}
