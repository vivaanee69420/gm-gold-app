// Dentally API spike — the Stage 5 go/no-go (DESIGN.md build sequence).
// Read-only: answers the three assignment-email questions against a real token.
//
//   1. Completed + paid readable?   appointments.completed_at, invoices.paid/paid_on
//   2. Patient mobiles readable?    patients[].mobile_phone / phone_normalized
//   3. One account or six?          /sites under one token lists every practice it covers
//
// Usage:
//   DENTALLY_API_TOKEN=xxx node scripts/dentally-spike.js             # production
//   DENTALLY_API_TOKEN=xxx node scripts/dentally-spike.js --sandbox   # api.sandbox.dentally.co
//
// Every call is a GET. Exit 0 = GO (all critical checks pass), 1 = NO-GO.

const TOKEN = process.env.DENTALLY_API_TOKEN;
const BASE =
  process.env.DENTALLY_API_BASE ??
  (process.argv.includes('--sandbox') ? 'https://api.sandbox.dentally.co' : 'https://api.dentally.co');

if (!TOKEN) {
  console.error('Set DENTALLY_API_TOKEN (and optionally DENTALLY_API_BASE or --sandbox).');
  process.exit(1);
}

const results = [];
let scopes = null;

async function get(path) {
  const res = await fetch(`${BASE}/v1${path}`, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'user-agent': 'GM-Referral-Spike v1', // Dentally 403s without a User-Agent
      accept: 'application/json',
    },
  });
  scopes = res.headers.get('x-oauth-scopes') ?? scopes;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${path} — ${JSON.stringify(body.error ?? body).slice(0, 200)}`);
  return body;
}

function record(name, ok, detail, critical = true) {
  results.push({ name, ok, detail, critical });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

// ---- checks ----
try {
  const { user } = await get('/user');
  record('auth: token accepted (/user)', true, `${user?.email ?? 'ok'}; scopes: ${scopes ?? 'not reported'}`);
} catch (err) {
  record('auth: token accepted (/user)', false, err.message);
  summarize(); // nothing else can work without auth
}

try {
  const { sites = [] } = await get('/sites');
  record(
    'account shape: /sites',
    sites.length > 0,
    `${sites.length} site(s) under this token: ${sites.map((s) => s.name).join(', ').slice(0, 140)} ` +
      `(6 expected if one account covers the whole group)`,
  );
} catch (err) {
  record('account shape: /sites', false, err.message);
}

try {
  const { patients = [] } = await get('/patients?per_page=5');
  const withMobile = patients.filter((p) => p.mobile_phone || p.phone_normalized);
  record(
    'patient mobiles readable',
    patients.length > 0 && withMobile.length > 0,
    `${withMobile.length}/${patients.length} sampled patients expose mobile_phone/phone_normalized`,
  );
} catch (err) {
  record('patient mobiles readable', false, err.message);
}

try {
  const { appointments = [] } = await get(`/appointments?updated_after=${encodeURIComponent(daysAgo(30))}&per_page=25`);
  const completed = appointments.filter((a) => a.completed_at);
  record(
    'appointments: completed_at + updated_after cursor',
    appointments.length > 0,
    `${appointments.length} updated in 30d, ${completed.length} with completed_at`,
  );
} catch (err) {
  record('appointments: completed_at + updated_after cursor', false, err.message);
}

try {
  const { invoices = [] } = await get(`/invoices?updated_after=${encodeURIComponent(daysAgo(30))}&per_page=25`);
  const paid = invoices.filter((i) => i.paid);
  record(
    'invoices: paid/paid_on + updated_after cursor',
    invoices.length > 0,
    `${invoices.length} updated in 30d, ${paid.length} paid — completed+paid detection ${paid.length ? 'CONFIRMED' : 'unproven on this sample'}`,
  );
} catch (err) {
  record('invoices: paid/paid_on + updated_after cursor', false, err.message);
}

try {
  const { payments = [] } = await get('/payments?per_page=5');
  record('payments readable (webhook payment.created backing)', true, `${payments.length} sampled`, false);
} catch (err) {
  record('payments readable (webhook payment.created backing)', false, err.message, false);
}

try {
  const { webhooks = [] } = await get('/webhooks');
  record('webhooks: listable via API', true, `${webhooks.length} registered`, false);
} catch (err) {
  // Non-critical: webhooks can also be created in Dentally Developer Settings by hand,
  // and FR-16 works on polling alone.
  record('webhooks: listable via API', false, err.message, false);
}

summarize();

function summarize() {
  const criticalFails = results.filter((r) => r.critical && !r.ok);
  console.log('\n' + '─'.repeat(60));
  if (criticalFails.length === 0 && results.length > 0) {
    console.log('GO — Stage 5 (patient index + sync worker) is unblocked.');
    process.exit(0);
  }
  console.log(`NO-GO — ${criticalFails.length} critical check(s) failed:`);
  for (const f of criticalFails) console.log(`  • ${f.name}: ${f.detail}`);
  console.log('Likely fixes: missing scopes on the token, or the account does not cover all sites.');
  process.exit(1);
}
