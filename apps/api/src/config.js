const env = process.env.NODE_ENV ?? 'development';
const dev = env !== 'production';

// Boot guard: the default JWT secret below is public (it's in this repo). Never let a
// production boot silently sign admin/patient sessions with it.
if (env === 'production' && !process.env.API_JWT_SECRET) {
  throw new Error('API_JWT_SECRET is required in production');
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  env,
  // Supabase Postgres connection string in production/staging; unset = embedded dev Postgres (PGlite).
  databaseUrl: process.env.DATABASE_URL ?? null,
  jwtSecret: process.env.API_JWT_SECRET ?? 'dev-only-secret-change-me',
  // sms_only | whatsapp_primary come later (FR-02a); dev logs codes instead of sending.
  otpChannelMode: process.env.OTP_CHANNEL_MODE ?? 'dev',
  // FR: a referred friend must book within this window or the referral resets.
  referralBookingWindowHours: Number(process.env.REFERRAL_BOOKING_WINDOW_HOURS ?? 12),
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
