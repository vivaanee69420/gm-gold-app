const env = process.env.NODE_ENV ?? 'development';
const dev = env !== 'production';

// Boot guard: the default JWT secret below is public (it's in this repo). Never let a
// production boot silently sign admin/patient sessions with it.
if (env === 'production' && !process.env.API_JWT_SECRET) {
  throw new Error('API_JWT_SECRET is required in production');
}
// The same guard, independent of NODE_ENV (controller ruling C1): the deployed image boots
// with NODE_ENV=development, so the check above alone would never fire there. A DATABASE_URL
// is the honest signal that this process is talking to a real database with real accounts —
// refuse to sign anything for it with the public default secret.
if (process.env.DATABASE_URL && !process.env.API_JWT_SECRET) {
  throw new Error('API_JWT_SECRET is required when DATABASE_URL is set');
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  env,
  // Browser origins allowed to call this API (see the cors block in app.js). The mobile app
  // sends no Origin header at all and is allowed unconditionally there — this list only ever
  // governs browsers, which means in practice it governs the admin dashboard.
  // Comma-separated so staging and production dashboards can share one deploy.
  // The default must match apps/admin/vite.config.js (`server.port`), or a fresh checkout
  // can't sign in locally — the browser is blocked by CORS and the dashboard reports it as
  // "Couldn't reach the API". 5173 stays for anyone running Vite on its own default.
  adminOrigins: (process.env.ADMIN_ORIGINS ?? process.env.ADMIN_URL ?? 'http://localhost:5174,http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Supabase Postgres connection string in production/staging; unset = embedded dev Postgres (PGlite).
  databaseUrl: process.env.DATABASE_URL ?? null,
  jwtSecret: process.env.API_JWT_SECRET ?? 'dev-only-secret-change-me',
  // Supabase Auth owns patient identity (decision 2026-09-09). The API never issues a patient
  // token any more; it verifies Supabase's, against the project's public keys.
  //
  // jwksUrl is derived from `url` so there is one thing to configure, not two that can drift.
  // `issuer` is what the `iss` claim must equal — checking it is what stops a token minted by
  // somebody else's Supabase project from being accepted by ours.
  //
  // Note for whoever moves this to the London project: new Supabase projects sign with
  // asymmetric keys (ES256) and publish a JWKS endpoint, which is what this expects. A legacy
  // project still on the shared HS256 secret would need a different verification path.
  supabase: (() => {
    const url = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '') || null;
    return {
      url,
      jwksUrl: process.env.SUPABASE_JWKS_URL ?? (url ? `${url}/auth/v1/.well-known/jwks.json` : null),
      issuer: process.env.SUPABASE_JWT_ISSUER ?? (url ? `${url}/auth/v1` : null),
      // Server-side only. Used for "sign out everywhere" (FR-03) and nothing else so far.
      // Never goes near a response body.
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? null,
    };
  })(),
  // Outbound email (Resend, Q4: sending from mail.gmdental.co.uk). No boot guard on the key
  // deliberately: a missing key must not stop the API serving, it must stop the OUTBOX
  // claiming a send succeeded — see emailService, which treats it as a retryable fault in
  // production and falls back to console logging in dev so local work needs no account.
  email: {
    apiKey: process.env.EMAIL_API_KEY ?? null,
    from: process.env.EMAIL_FROM ?? 'GM Dental Gold Card <noreply@mail.gmdental.co.uk>',
    replyTo: process.env.EMAIL_REPLY_TO ?? null,
    // Shared secret for POST /webhooks/resend. Unset means the endpoint refuses everything:
    // an unauthenticated caller must never be able to mark a patient's money notification
    // as failed.
    webhookSecret: process.env.EMAIL_WEBHOOK_SECRET ?? null,
  },
  // How long a referrer's claim on a friend lasts. This is not a nag timer: expiry sets
  // status='lost', and referrals_referred_phone_active is a partial unique index
  // `where status <> 'lost'`, so expiring a referral RELEASES that phone number back into the
  // pool for anyone else to refer. The window is therefore the answer to "how long is this
  // friend reserved exclusively for the person who referred them".
  //
  // Was 12 hours, which answered "until tomorrow morning". A friend picks a practice in the
  // app and then books, usually by phoning during opening hours — submit at 8pm on a Friday
  // and the referral was dead before the practice opened. Since 2026-09-11 a referral also
  // waits off the pipeline board until Dentally confirms a booking, so nobody can see or
  // rescue one before the window closes. 14 days is long enough to survive a weekend, a
  // holiday and simply forgetting; short enough that a cold lead does not lock that person
  // out of the scheme forever.
  referralBookingWindowHours: Number(process.env.REFERRAL_BOOKING_WINDOW_HOURS ?? 336),
  consentVersionReferred: 'referred-v1-2026-08',
  // Dentally (FR-05/FR-16). Effective mode is resolved at runtime by
  // connectionService.resolveDentallyMode(): DENTALLY_MODE override > env token
  // (live) > admin OAuth connection (live) > stub in dev / off in production.
  dentally: {
    modeOverride: process.env.DENTALLY_MODE ?? null,
    // Read Dentally facts from the company's Dental Os database (already fed by
    // Dentally webhooks) instead of calling Dentally directly. Read-only connection.
    dentalOsUrl: process.env.DENTAL_OS_DATABASE_URL ?? null,
    apiBase: process.env.DENTALLY_API_BASE ?? 'https://api.dentally.co',
    token: process.env.DENTALLY_API_TOKEN ?? null,
    webhookSecret: process.env.DENTALLY_WEBHOOK_SECRET ?? null,
    syncIntervalMs: Number(process.env.DENTALLY_SYNC_INTERVAL_MS ?? 15 * 60 * 1000), // FR-16(d)
    // OAuth app credentials (issued by Dentally) + flow endpoints. The admin
    // dashboard's "Connect Dentally" button drives the authorization-code flow.
    clientId: process.env.DENTALLY_CLIENT_ID ?? null,
    clientSecret: process.env.DENTALLY_CLIENT_SECRET ?? null,
    redirectUri:
      process.env.DENTALLY_REDIRECT_URI ??
      `http://localhost:${Number(process.env.PORT ?? 4000)}/oauth/dentally/callback`,
    authorizeUrl:
      process.env.DENTALLY_OAUTH_AUTHORIZE_URL ??
      `${process.env.DENTALLY_API_BASE ?? 'https://api.dentally.co'}/oauth/authorize`,
    tokenUrl:
      process.env.DENTALLY_OAUTH_TOKEN_URL ??
      `${process.env.DENTALLY_API_BASE ?? 'https://api.dentally.co'}/oauth/token`,
    adminUrl: process.env.ADMIN_URL ?? 'http://localhost:5173',
  },
};

export const isDev = dev;
