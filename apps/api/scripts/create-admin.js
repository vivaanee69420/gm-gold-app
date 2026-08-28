// Create (or seed) a dashboard account — email + password, its own identity (FR-24).
//   node scripts/create-admin.js <email> <password> [admin|manager] [practiceId]
// role defaults to 'admin' (sees/acts on every practice). 'manager' is a payouts-only
// dashboard scoped to exactly one ACTIVE practice — pass its id as the last argument.
// GET /practices lists each active practice's id and name.
// Run with DATABASE_URL set to target Supabase/Railway; unset targets local PGlite.
import { initDb } from '../src/db.js';
import { createAdmin } from '../src/services/adminService.js';

const [email, password, role = 'admin', practiceId] = process.argv.slice(2);
if (!email || !password || !['admin', 'manager'].includes(role)) {
  console.error('Usage: node scripts/create-admin.js <email> <password> [admin|manager] [practiceId]');
  process.exit(1);
}

await initDb();
try {
  const admin = await createAdmin({
    email,
    password,
    role,
    practiceIds: practiceId ? [practiceId] : [],
  });
  console.log(`Created ${admin.role} ${admin.email} (id: ${admin.id})`);
  process.exit(0);
} catch (err) {
  if (err.message === 'validation') {
    console.error('validation: check the email format, role (admin|manager), and practiceId (must be a UUID)');
  } else {
    console.error(err.message ?? String(err));
  }
  process.exit(1);
}
