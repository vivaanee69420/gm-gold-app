// Test-only Supabase Auth stub.
//
// Mirrors test/helpers/admin.js in intent: get a working session without going through the
// real sign-in, while still exercising the production code path a real client would.
//
// It stands up a tiny HTTP server that serves a JWKS document exactly where Supabase serves
// one, and signs ES256 tokens with the matching private key. So requireUser runs its REAL
// verification — signature, issuer, audience, expiry, `kid` lookup — against keys it fetched
// over HTTP. Nothing in src/ knows it is being tested.
//
// The alternative (a test-only bypass flag inside requireUser) was rejected in review: an
// auth bypass guarded by an env var is one bad deploy from being a production bypass, which
// is the exact class of bug this whole migration exists to remove.
import http from 'node:http';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

const ALG = 'ES256'; // what current Supabase projects sign with
const KID = 'test-key-1';

/**
 * Start the stub. Call BEFORE importing config.js — it returns the env the config module
 * must see, and config reads it once at module evaluation.
 *
 * @returns {Promise<{env: object, signToken: Function, stop: Function, jwksHits: () => number}>}
 */
export async function startSupabaseAuthStub() {
  const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: ALG, use: 'sig' };

  let hits = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/auth/v1/.well-known/jwks.json') {
      hits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  /**
   * Mint an access token shaped like Supabase's.
   * Every field is overridable so tests can produce specifically-wrong tokens: an expired
   * one, one from another project (issuer), the project's public anon key (audience), or one
   * signed by a key the JWKS does not publish.
   */
  async function signToken({
    sub = crypto.randomUUID(),
    email = null,
    issuer = `${url}/auth/v1`,
    audience = 'authenticated',
    expiresIn = '1h',
    issuedAt,
    key = privateKey,
    kid = KID,
  } = {}) {
    const jwt = new SignJWT({ ...(email ? { email } : {}) })
      .setProtectedHeader({ alg: ALG, kid })
      .setSubject(sub)
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime(expiresIn);
    jwt.setIssuedAt(issuedAt); // undefined => now, which is what SignJWT does anyway
    return jwt.sign(key);
  }

  return {
    env: {
      SUPABASE_URL: url,
      SUPABASE_JWT_ISSUER: `${url}/auth/v1`,
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    },
    signToken,
    jwksHits: () => hits,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Set env, run the importer, restore env.
 *
 * config.js captures these once at module evaluation, and vitest reuses worker processes
 * between test FILES while giving each a fresh module registry — so anything left in
 * process.env leaks sideways into whichever suite runs next in the same worker. That is not
 * hypothetical: it was caught flaking the Dentally suites, because a stray
 * NODE_ENV=production flips resolveDentallyMode() from 'stub' to 'off'.
 */
export async function withEnv(env, importer) {
  const restore = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await importer();
  } finally {
    for (const [k, v] of Object.entries(restore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
