export const config = {
  port: Number(process.env.PORT ?? 4000),
  env: process.env.NODE_ENV ?? 'development',
  // Supabase Postgres connection string in production/staging; unset = embedded dev Postgres (PGlite).
  databaseUrl: process.env.DATABASE_URL ?? null,
  jwtSecret: process.env.API_JWT_SECRET ?? 'dev-only-secret-change-me',
  // sms_only | whatsapp_primary come later (FR-02a); dev logs codes instead of sending.
  otpChannelMode: process.env.OTP_CHANNEL_MODE ?? 'dev',
  consentVersionReferred: 'referred-v1-2026-08',
};

export const isDev = config.env !== 'production';
