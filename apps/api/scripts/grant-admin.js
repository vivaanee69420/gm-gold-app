// Grant (or update) dashboard access for a signed-up user (FR-24).
//   node scripts/grant-admin.js <phone> <email> [role] [practiceId,practiceId,...]
// role defaults to 'admin'; omit practice ids for all-practice visibility.
// 'manager' is a payouts-only dashboard scoped to exactly one practice (2026-08-28 decision).
// GET /practices lists each active practice's id and name.
// Run with DATABASE_URL set to target Supabase/Railway; unset targets local PGlite.
import { initDb, db } from '../src/db.js';
import { normalizePhone } from '@gm-referral/shared/phone';

const [phoneArg, email, role = 'admin', practiceCsv = ''] = process.argv.slice(2);
if (!phoneArg || !email || !['admin', 'owner', 'manager'].includes(role)) {
  console.error('Usage: node scripts/grant-admin.js <phone> <email> [admin|owner|manager] [practiceId,...]');
  process.exit(1);
}

const practiceIds = practiceCsv ? practiceCsv.split(',').map((s) => s.trim()) : [];
if (role === 'manager' && practiceIds.length !== 1) {
  console.error(`A manager needs exactly one practice id; got ${practiceIds.length}.`);
  process.exit(1);
}

await initDb();
const phone = normalizePhone(phoneArg);
const { rows } = await db.query(`select id from users where phone=$1`, [phone]);
if (!rows[0]) {
  console.error(`No user with phone ${phone} — they must sign in to the dashboard once first.`);
  process.exit(1);
}
if (practiceIds.length) {
  const { rows: validRows } = await db.query(
    `select id from practices where id = any($1::uuid[]) and active`,
    [practiceIds],
  );
  const validIds = new Set(validRows.map((r) => r.id));
  const invalid = practiceIds.filter((id) => !validIds.has(id));
  if (invalid.length) {
    console.error(`Not an active practice id: ${invalid.join(', ')} — GET /practices lists valid ids.`);
    process.exit(1);
  }
}
await db.query(
  `insert into admin_users (user_id, email, role, practice_ids) values ($1,$2,$3,$4)
   on conflict (user_id) do update set email=$2, role=$3, practice_ids=$4, active=true`,
  [rows[0].id, email, role, practiceIds],
);
console.log(`${phone} is now ${role}${practiceIds.length ? ` (practices: ${practiceIds.join(', ')})` : ' (all practices)'}`);
process.exit(0);
