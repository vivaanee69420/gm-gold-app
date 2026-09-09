// Supabase access-token verification (decision 2026-09-09: Supabase Auth owns patient
// identity). The API stopped issuing patient tokens; it verifies Supabase's.
//
//   Bearer <jwt>
//     |
//     v
//   jose.createRemoteJWKSet  -- caches the project's public keys, refetches on an unseen
//     |                         `kid` (so key rotation is handled for us rather than by a
//     |                         hand-rolled cache that gets rotation subtly wrong)
//     v
//   jwtVerify(token, jwks, { issuer, audience: 'authenticated' })
//     |
//     |-- signature / expiry / issuer bad --> AuthError('invalid_token')      -> 401
//     |-- JWKS unreachable ----------------> AuthError('auth_unavailable')    -> 503
//     +-- ok ------------------------------> { sub, email }
//
// The 401-vs-503 split is the whole reason this is its own module. A token we cannot CHECK
// is not the same as a token we checked and rejected. Returning 401 when Supabase's JWKS
// endpoint is briefly unreachable would sign every patient out of the app at once, and the
// mobile client would helpfully clear its session on the way. 503 tells it to retry.
//
// `audience: 'authenticated'` is not decoration: it is what distinguishes a real user
// session from Supabase's own anon key, which is a valid JWT signed by the same project and
// is shipped publicly inside the mobile app.
import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import { config } from '../config.js';

export class AuthError extends Error {
  constructor(code, { status }) {
    super(code);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

let jwks = null;
let jwksUrlInUse = null;

/**
 * Lazily built so config can be read at call time rather than import time — the tests point
 * SUPABASE_JWKS_URL at a local key server, and rebuilding when the URL changes keeps the
 * cached key set from one test leaking into the next.
 */
function keySet() {
  if (!config.supabase.jwksUrl) {
    throw new AuthError('auth_not_configured', { status: 503 });
  }
  if (!jwks || jwksUrlInUse !== config.supabase.jwksUrl) {
    jwks = createRemoteJWKSet(new URL(config.supabase.jwksUrl), {
      // Do not hammer the endpoint when a bad `kid` shows up in a flood of requests.
      cooldownDuration: 30_000,
      // Keys are cached for this long before a refetch is considered.
      cacheMaxAge: 600_000,
    });
    jwksUrlInUse = config.supabase.jwksUrl;
  }
  return jwks;
}

/** Test seam: drop the cached key set so a suite can point at a different local JWKS. */
export function __resetKeySetForTests() {
  jwks = null;
  jwksUrlInUse = null;
}

/**
 * @returns {Promise<{sub: string, email: string|null}>}
 * @throws {AuthError} 401 for a token that is genuinely bad, 503 for one we cannot check.
 */
export async function verifyAccessToken(token) {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, keySet(), {
      issuer: config.supabase.issuer ?? undefined,
      audience: 'authenticated',
    }));
  } catch (err) {
    if (err instanceof AuthError) throw err;
    // jose's own errors mean we successfully checked and the token lost: expired, wrong
    // signature, wrong issuer/audience, malformed, or signed by a key this project does not
    // publish. All of those are the caller's problem -> 401.
    if (err instanceof joseErrors.JOSEError) {
      throw new AuthError('invalid_token', { status: 401 });
    }
    // Anything else reaching here came from fetching the key set: DNS, TLS, timeout, 5xx.
    // We do not know whether the token is good, so we must not claim it is bad.
    throw new AuthError('auth_unavailable', { status: 503 });
  }

  if (!payload.sub) throw new AuthError('invalid_token', { status: 401 });
  // `iat` comes back so requireUser can tell a token minted BEFORE a revocation from one
  // minted after it (a fresh login immediately following a forced sign-out). Supabase issues
  // seconds-granularity iat and no iatMs, which is precisely the fallback path tokenRevoked
  // in userService.js already implements.
  return { sub: payload.sub, email: payload.email ?? null, iat: payload.iat ?? 0 };
}

/**
 * FR-03 "sign out everywhere", Supabase's half. Revokes the user's refresh tokens so no new
 * access token can be minted.
 *
 * Deliberately best-effort: `users.sessions_revoked_at` is still stamped and still checked in
 * requireUser, and that check is what makes revocation take effect IMMEDIATELY. Supabase's
 * global sign-out only stops future refreshes — an access token already in the wild stays
 * cryptographically valid until it expires. Relying on Supabase alone would quietly turn
 * "signed out now" into "signed out within the hour".
 *
 * @returns {Promise<boolean>} whether Supabase acknowledged it.
 */
export async function signOutEverywhere(authUserId) {
  const { url, serviceRoleKey } = config.supabase;
  if (!url || !serviceRoleKey) return false;
  try {
    const res = await fetch(`${url}/auth/v1/admin/users/${authUserId}/logout`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}
