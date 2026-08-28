// Dentally OAuth connection (admin-driven, standard authorization-code flow):
//
//   admin clicks Connect ──▶ POST /admin/dentally/connect ──▶ { url } (state = signed JWT)
//        browser ──▶ Dentally /oauth/authorize ──▶ practice owner approves scopes
//        Dentally ──▶ GET /oauth/dentally/callback?code&state
//                          └─ verify state, exchange code at /oauth/token,
//                             upsert the single dentally_oauth row,
//                             redirect back to the admin dashboard
//
// The live client asks getAccessToken() before every call; tokens refresh
// automatically (single-flight) when expiring or on a 401. DENTALLY_API_TOKEN,
// if set, wins over OAuth — both feed the same client.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { db, logEvent } from '../../db.js';
import { config, isDev } from '../../config.js';

// Read-only sync + verification needs (see docs Scopes section):
// patients (mobiles), appointments (completions), financials (paid invoices),
// practice (sites + webhooks), user (token sanity check via /user).
export const OAUTH_SCOPES = 'patient:read appointment:read financials:read practice:read user:read';

const httpError = (message, status) => Object.assign(new Error(message), { status });

// ---- connection row (cached; single row keyed id=true) ----
let cache = { row: undefined, at: 0 };
const CACHE_MS = 15_000;

export function invalidateConnectionCache() {
  cache = { row: undefined, at: 0 };
}

export async function getConnection(force = false) {
  if (!force && cache.row !== undefined && Date.now() - cache.at < CACHE_MS) return cache.row;
  const { rows } = await db.query(`select * from dentally_oauth where id`);
  cache = { row: rows[0] ?? null, at: Date.now() };
  return cache.row;
}

/**
 * Effective Dentally mode, cheap enough to call per request:
 *   DENTALLY_MODE env override > Dental Os read connection (dentalos)
 *   > env token (live) > OAuth connection (live) > stub in dev / off in production.
 */
export async function resolveDentallyMode() {
  const d = config.dentally;
  if (d.modeOverride) return d.modeOverride;
  if (d.dentalOsUrl) return 'dentalos';
  if (d.token) return 'live';
  if (await getConnection()) return 'live';
  return isDev ? 'stub' : 'off';
}

export function oauthConfigured() {
  return Boolean(config.dentally.clientId && config.dentally.clientSecret);
}

export async function connectionStatus() {
  const connection = await getConnection(true);
  return {
    mode: await resolveDentallyMode(),
    oauthConfigured: oauthConfigured(),
    envToken: Boolean(config.dentally.token),
    connection: connection
      ? {
          scope: connection.scope,
          connectedAt: connection.connected_at,
          expiresAt: connection.expires_at,
        }
      : null,
  };
}

// ---- authorize ----
export function buildAuthorizeUrl(adminUserId) {
  if (!oauthConfigured()) throw httpError('dentally_not_configured', 409);
  const state = jwt.sign(
    { sub: String(adminUserId), purpose: 'dentally_oauth', nonce: crypto.randomBytes(8).toString('hex') },
    config.jwtSecret,
    { expiresIn: '10m' },
  );
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.dentally.clientId,
    redirect_uri: config.dentally.redirectUri,
    scope: OAUTH_SCOPES,
    state,
  });
  return `${config.dentally.authorizeUrl}?${params}`;
}

// ---- token endpoint ----
async function tokenRequest(bodyParams) {
  const res = await fetch(config.dentally.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'user-agent': 'GM-Referral v1',
    },
    body: new URLSearchParams({
      client_id: config.dentally.clientId,
      client_secret: config.dentally.clientSecret,
      ...bodyParams,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw httpError(`dentally_token_${body.error ?? res.status}`, 502);
  }
  return body;
}

async function saveTokens(tokens, connectedBy = null) {
  const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null;
  await db.query(
    `insert into dentally_oauth (id, access_token, refresh_token, token_type, scope, expires_at, connected_by)
     values (true, $1, $2, $3, $4, $5, $6)
     on conflict (id) do update set
       access_token = $1,
       refresh_token = coalesce($2, dentally_oauth.refresh_token),
       token_type = $3, scope = coalesce($4, dentally_oauth.scope),
       expires_at = $5,
       connected_by = coalesce($6, dentally_oauth.connected_by),
       updated_at = now()`,
    [
      tokens.access_token,
      tokens.refresh_token ?? null,
      tokens.token_type ?? 'Bearer',
      tokens.scope ?? null,
      expiresAt,
      connectedBy,
    ],
  );
  invalidateConnectionCache();
}

/** Callback leg: verify the signed state, swap the code for tokens, store them. */
export async function handleOauthCallback({ code, state }) {
  let payload;
  try {
    payload = jwt.verify(state, config.jwtSecret);
  } catch {
    throw httpError('oauth_state_invalid', 401);
  }
  if (payload.purpose !== 'dentally_oauth') throw httpError('oauth_state_invalid', 401);
  if (!code) throw httpError('oauth_code_missing', 422);

  const tokens = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.dentally.redirectUri,
  });
  await saveTokens(tokens, payload.sub);
  await logEvent(db, { actorId: payload.sub, actorKind: 'admin', entityType: 'dentally', entityId: 'oauth', action: 'connected', toValue: tokens.scope ?? null });
  return { ok: true };
}

export async function disconnect(adminId) {
  await db.query(`delete from dentally_oauth where id`);
  invalidateConnectionCache();
  await logEvent(db, { actorId: adminId, actorKind: 'admin', entityType: 'dentally', entityId: 'oauth', action: 'disconnected' });
  return { ok: true };
}

// ---- access token with single-flight refresh ----
let refreshInFlight = null;

async function refreshTokens(connection) {
  if (!connection.refresh_token) throw httpError('dentally_token_expired_no_refresh', 502);
  refreshInFlight ??= tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: connection.refresh_token,
  })
    .then(async (tokens) => {
      await saveTokens(tokens);
      return tokens.access_token;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

/** Current bearer token for the live client. Env token wins; OAuth refreshes itself. */
export async function getAccessToken({ forceRefresh = false } = {}) {
  if (config.dentally.token) return config.dentally.token;
  const connection = await getConnection(forceRefresh);
  if (!connection) throw httpError('dentally_not_connected', 409);
  const expiringSoon = connection.expires_at && new Date(connection.expires_at).getTime() - Date.now() < 60_000;
  if (forceRefresh || expiringSoon) return refreshTokens(connection);
  return connection.access_token;
}
