// One boot sequence for every suite that needs an authenticated patient.
//
// It assigns onto the LOADED config object rather than setting process.env and hoping
// config.js has not been evaluated yet. That hope is unfounded here: ES module imports are
// hoisted, so a static `import { adminSession } from './helpers/admin.js'` at the top of a
// test file pulls in adminService -> config.js BEFORE any module-scope assignment in that
// file runs. dentally.test.js already carried a comment about this trap; setting env in a
// helper walks straight into it, and the symptom is an unhelpful 503 auth_unavailable from
// every authenticated request because config.supabase.jwksUrl was still null at import time.
//
// Assigning to config afterwards is order-independent and needs no dynamic-import discipline
// from the calling file.
import { startSupabaseAuthStub } from './supabase-auth.js';

/**
 * @param {object} [overrides] config.dentally overrides, e.g. { mode: 'stub' }
 * @returns {Promise<{app: object, db: object, stub: object}>}
 */
export async function bootTestApp({ dentallyMode, dentallyWebhookSecret } = {}) {
  const stub = await startSupabaseAuthStub();

  const { config } = await import('../../src/config.js');
  Object.assign(config.supabase, {
    url: stub.env.SUPABASE_URL,
    jwksUrl: `${stub.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
    issuer: stub.env.SUPABASE_JWT_ISSUER,
    serviceRoleKey: stub.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  if (dentallyMode !== undefined) config.dentally.modeOverride = dentallyMode;
  if (dentallyWebhookSecret !== undefined) config.dentally.webhookSecret = dentallyWebhookSecret;

  // jose caches keys per URL; a previous suite in this worker may have cached another
  // stub's, and the ports differ every run.
  const supabaseAuth = await import('../../src/services/supabaseAuth.js');
  supabaseAuth.__resetKeySetForTests();

  const dbMod = await import('../../src/db.js');
  await dbMod.initDb();
  const { buildApp } = await import('../../src/app.js');

  return { app: buildApp(), db: dbMod.db, stub };
}
