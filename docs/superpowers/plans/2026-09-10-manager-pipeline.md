# Manager Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a practice manager credit a referrer's commission by moving a patient into a new `treatment_started` stage from a practice-scoped dashboard, with leads automatically landing in the practice they actually booked at.

**Architecture:** One dashboard, role-filtered — managers and admins run the same React app and the same components; the API's practice scope decides what data comes back. A new `treatment_started` stage becomes the crediting stage. The Dentally completion poller is demoted from "the only way commission happens" to a safety net that only surfaces what managers missed. A new `booked_practice_id` column, written by the Dental Os sync, makes the pipeline follow where the patient actually booked.

**Tech Stack:** Node 20 + Express 4 (ESM, layered services), Postgres (PGlite in dev/test, Supabase in prod), React 19 + Vite (admin dashboard), Expo React Native (mobile), Vitest + supertest + @testing-library/react, Zod schemas shared via `packages/shared`.

**Spec:** `docs/superpowers/specs/2026-09-10-manager-pipeline-design.md`

## Global Constraints

- **Owning practice is defined exactly once**, everywhere, as `coalesce(booked_practice_id, preferred_practice_id)`. Never scope on `preferred_practice_id` alone.
- **Out-of-scope resources answer `404 not_found`, never `403`.** A 403 confirms the row exists to someone who should not know that. `403 forbidden` is only for a manager hitting a route that is closed to the manager role entirely.
- **The credit rule is "at or past `treatment_started`, if not already credited"** — never "exactly on `treatment_started`". The privileged path allows jumping straight to `treatment_completed`, and that must still credit.
- **Fail closed.** Any new `/admin/*` route is unreachable by managers unless it is explicitly added to `MANAGER_ROUTES`.
- **Never introduce a browser `confirm()`/`alert()` dialog.** Confirmation is an inline UI step.
- Tests run on in-memory PGlite via `process.env.PGLITE_MEMORY = '1'`. PGlite is the test database and must keep working; it is not a droppable dev convenience.
- Migrations are plain `.sql` files in `supabase/migrations/`, applied in filename order by `apps/api/src/db.js`. Never edit a migration that has shipped; add a new one.
- Commit after every task. Run `ggshield secret scan pre-commit` before each commit.
- Run `cd apps/api && npx vitest run` for API tests and `cd apps/admin && npx vitest run` for dashboard tests.

---

### Task 1: The `treatment_started` stage and `booked_practice_id` column

Adds the schema and the shared constant. Nothing reads them yet, so the suite must stay green on the strength of the migration alone. This task also settles the spec's expression-index question: `migrations.test.js` replays every migration onto a scratch PGlite, so if `coalesce()` in an index is unsupported, it fails here and nowhere later.

**Files:**
- Create: `supabase/migrations/0016_manager_pipeline.sql`
- Modify: `packages/shared/src/schemas.js:8-16` (`REFERRAL_STATUSES`)
- Test: `apps/api/test/migrations.test.js` (append a new `describe`)

**Interfaces:**
- Consumes: nothing.
- Produces: `REFERRAL_STATUSES` now contains `'treatment_started'` at index 5, between `'treatment_agreed'` and `'treatment_completed'`. `referrals.booked_practice_id uuid null references practices(id)`. Index `referrals_owning_practice`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/migrations.test.js`:

```javascript
describe('0016_manager_pipeline.sql', () => {
  let db;

  beforeAll(async () => {
    const restore = process.env.PGLITE_MEMORY;
    process.env.PGLITE_MEMORY = '1';
    try {
      const dbMod = await import('../src/db.js');
      await dbMod.initDb();
      db = dbMod.db;
    } finally {
      if (restore === undefined) delete process.env.PGLITE_MEMORY;
      else process.env.PGLITE_MEMORY = restore;
    }
  });

  it('accepts treatment_started as a referral status', async () => {
    const { rows: [practice] } = await db.query(`select id from practices limit 1`);
    const { rows: [user] } = await db.query(
      `insert into users (phone) values ('+447700900001') returning id`,
    );
    const { rows: [referral] } = await db.query(
      `insert into referrals (referrer_id, referred_phone, referred_name, treatment_interest,
                              preferred_practice_id, consent_version, status)
       values ($1,'+447700900002','Test Patient','implants',$2,'v1','treatment_started')
       returning status`,
      [user.id, practice.id],
    );
    expect(referral.status).toBe('treatment_started');
  });

  it('still rejects a status outside the enum', async () => {
    const { rows: [user] } = await db.query(
      `insert into users (phone) values ('+447700900003') returning id`,
    );
    await expect(
      db.query(
        `insert into referrals (referrer_id, referred_phone, referred_name, treatment_interest,
                                consent_version, status)
         values ($1,'+447700900004','Bad Status','implants','v1','made_up')`,
        [user.id],
      ),
    ).rejects.toThrow();
  });

  it('has booked_practice_id and the owning-practice index', async () => {
    const { rows: cols } = await db.query(
      `select column_name from information_schema.columns
        where table_name = 'referrals' and column_name = 'booked_practice_id'`,
    );
    expect(cols).toHaveLength(1);

    const { rows: idx } = await db.query(
      `select indexname from pg_indexes
        where tablename = 'referrals' and indexname = 'referrals_owning_practice'`,
    );
    expect(idx, 'the coalesce() expression index must apply on PGlite as well as Postgres')
      .toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run test/migrations.test.js`
Expected: FAIL — the `treatment_started` insert violates `referrals_status_check`, and `booked_practice_id` does not exist.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0016_manager_pipeline.sql`:

```sql
-- Manager-driven pipeline (2026-09-10). Managers, not the Dentally poller, are now the
-- primary path to a commission credit: they move a patient into treatment_started and the
-- referrer is credited on the spot. See docs/superpowers/specs/2026-09-10-manager-pipeline-design.md

-- The new crediting stage, between treatment_agreed and treatment_completed.
-- treatment_completed stays as the final bookkeeping stage and credits nothing on its own.
alter table referrals drop constraint referrals_status_check;
alter table referrals add constraint referrals_status_check
  check (status in ('new','contacted','booked','attended',
                    'treatment_agreed','treatment_started','treatment_completed','lost'));

-- Where the appointment actually is, per Dental Os. preferred_practice_id keeps saying what
-- the referral form said. Neither column overwrites the other: a commission dispute needs the
-- original attribution, and the manager who can actually advance the patient needs the real one.
alter table referrals add column booked_practice_id uuid references practices(id);

-- The owning practice — the single definition every scoped query uses. Existing rows have a
-- null booked_practice_id and so keep their current owner; this migration moves nobody.
create index referrals_owning_practice
  on referrals (coalesce(booked_practice_id, preferred_practice_id));
```

- [ ] **Step 4: Add the stage to the shared constant**

In `packages/shared/src/schemas.js`, `REFERRAL_STATUSES` becomes:

```javascript
export const REFERRAL_STATUSES = [
  'new',
  'contacted',
  'booked',
  'attended',
  'treatment_agreed',
  'treatment_started',
  'treatment_completed',
  'lost',
];
```

- [ ] **Step 5: Run the full suite**

Run: `cd apps/api && npx vitest run` then `cd ../shared && npx vitest run`
Expected: PASS. `statusUpdateSchema` derives its enum from `REFERRAL_STATUSES`, so the new value is accepted by validation automatically. Nothing credits on it yet.

- [ ] **Step 6: Commit**

```bash
ggshield secret scan pre-commit
git add supabase/migrations/0016_manager_pipeline.sql packages/shared/src/schemas.js apps/api/test/migrations.test.js
git commit -m "feat: add treatment_started stage and booked_practice_id column"
```

---

### Task 2: Move the credit trigger to `treatment_started`

**Files:**
- Modify: `apps/api/src/services/referralService.js:8` (`STATUS_ORDER`), `:64-110` (`updateStatus`)
- Test: `apps/api/test/api.test.js` (append a `describe`)

**Interfaces:**
- Consumes: `REFERRAL_STATUSES` from Task 1.
- Produces: `STATUS_ORDER` = `['new','contacted','booked','attended','treatment_agreed','treatment_started','treatment_completed']`. `updateStatus()` credits when the target status is `treatment_started` **or** `treatment_completed`, and returns `{ from, to, credit }` where `credit` is `null` when no new credit was written.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/api.test.js`. This reuses the file's existing `agents` object and `auth()` helper:

```javascript
describe('treatment_started credits the referrer', () => {
  async function freshReferral(phoneSuffix) {
    const friend = await signIn(`07700 9${phoneSuffix}`);
    await request(app).post('/me/profile').set(auth(friend.token))
      .send({ firstName: 'Pat', lastName: 'Ient', notifyOptIn: false });
    await request(app).post('/me/role').set(auth(friend.token)).send({ role: 'referred' });
    const sub = await request(app).post('/referrals').set(auth(friend.token)).send({
      code: agents.code,
      fullName: `Pat Ient ${phoneSuffix}`,
      treatmentInterest: 'implants',
      preferredPracticeId: agents.practiceId,
      consent: true,
      consentVersion: 'referred-v1-2026-08',
    });
    expect(sub.status).toBe(200);
    return sub.body.referral.id;
  }

  const setStatus = (id, status) =>
    request(app).patch(`/admin/referrals/${id}/status`).set(auth(agents.admin)).send({ status });

  it('credits on treatment_started, and treatment_completed adds nothing more', async () => {
    const id = await freshReferral('01001');

    const started = await setStatus(id, 'treatment_started');
    expect(started.status).toBe(200);
    expect(started.body.credit).not.toBeNull();

    const completed = await setStatus(id, 'treatment_completed');
    expect(completed.status).toBe(200);
    expect(completed.body.credit).toBeNull(); // already paid — not a second credit

    const { rows } = await db.query(
      `select count(*)::int as n from wallet_ledger where referral_id = $1 and kind = 'credit'`,
      [id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('still credits when an admin jumps straight to treatment_completed', async () => {
    // The privileged path skips stages. Crediting "exactly on treatment_started" would
    // silently never pay this referrer.
    const id = await freshReferral('01002');
    const done = await setStatus(id, 'treatment_completed');
    expect(done.status).toBe(200);
    expect(done.body.credit).not.toBeNull();
  });

  it('does not credit before treatment_started', async () => {
    const id = await freshReferral('01003');
    for (const status of ['contacted', 'booked', 'attended', 'treatment_agreed']) {
      const res = await setStatus(id, status);
      expect(res.status).toBe(200);
      expect(res.body.credit).toBeNull();
    }
  });
});
```

`api.test.js` currently destructures only `app` and `stub` from `bootTestApp()`. Change its `beforeAll` to also capture `db`:

```javascript
({ app, db, stub: authStub } = await bootTestApp());
```

and add `let db;` beside the existing `let app;` declaration.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run test/api.test.js -t "treatment_started credits"`
Expected: FAIL — `treatment_started` is not in `STATUS_ORDER`, so the transition is rejected as `invalid_transition` (409).

- [ ] **Step 3: Update `STATUS_ORDER`**

In `apps/api/src/services/referralService.js` line 8:

```javascript
export const STATUS_ORDER = ['new', 'contacted', 'booked', 'attended', 'treatment_agreed', 'treatment_started', 'treatment_completed'];
```

- [ ] **Step 4: Change the credit branch in `updateStatus`**

In `apps/api/src/services/referralService.js`, replace the privileged-jump branch:

```javascript
  } else if (status === 'treatment_completed' && privilegedComplete) {
```

with one that lets the privileged path land on either paying stage:

```javascript
  } else if (privilegedComplete && (status === 'treatment_started' || status === 'treatment_completed')) {
```

Then replace the credit block at the end of the function:

```javascript
  let credit = null;
  if (status === 'treatment_completed') {
    credit = await creditReferral({
      referral,
      practiceId: referral.preferred_practice_id,
      actorId,
      actorKind,
      reason: 'treatment completed (admin confirmed)',
    });
  }
  return { from, to: status, credit };
```

with:

```javascript
  // "At or past treatment_started, if not already credited" — deliberately NOT "exactly on
  // treatment_started". The privileged path can jump straight to treatment_completed, and a
  // narrower condition would silently never pay that referrer. The partial unique index
  // wallet_ledger_one_credit_per_referral makes the second call a no-op, not a double payment.
  let credit = null;
  if (status === 'treatment_started' || status === 'treatment_completed') {
    try {
      credit = await creditReferral({
        referral,
        // The practice that is actually treating them owns the commission (FR-15 rule
        // resolution is per-practice), falling back to the practice the form chose.
        practiceId: referral.booked_practice_id ?? referral.preferred_practice_id,
        actorId,
        actorKind,
        reason: `treatment started (${actorKind ?? 'system'} confirmed)`,
      });
    } catch (err) {
      // already_credited is the expected, correct outcome of started -> completed. Anything
      // else (no_active_rule, a real failure) still propagates.
      if (err.message !== 'already_credited') throw err;
    }
  }
  return { from, to: status, credit };
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && npx vitest run`
Expected: PASS, including `practice-payouts.test.js` — its `referrerWithOpenPayout` helper credits by jumping to `treatment_completed`, which still pays under the "at or past" rule. If that suite fails, the rule was implemented too narrowly.

- [ ] **Step 6: Commit**

```bash
ggshield secret scan pre-commit
git add apps/api/src/services/referralService.js apps/api/test/api.test.js
git commit -m "feat: credit the referrer at treatment_started, not treatment_completed"
```

---

### Task 3: Practice scope on the status write

The highest-risk change in the plan. `PATCH /admin/referrals/:id/status` has no practice check because it is admin-only today. Task 5 opens it to managers; without this task first, any manager could credit commission against any practice's patient by guessing a uuid.

**Files:**
- Modify: `apps/api/src/services/referralService.js` (`updateStatus` signature + scope guard)
- Modify: `apps/api/src/app.js:333-346` (pass the scope)
- Test: `apps/api/test/practice-payouts.test.js` (append a `describe`)

**Interfaces:**
- Consumes: `updateStatus` from Task 2, `actionScope(req)` from `apps/api/src/app.js:101` (returns `null` for an admin, an array of practice-id strings for a manager, `[]` when there is no admin on the request).
- Produces: `updateStatus({ referralId, status, lostReason, actorId, actorKind, privilegedComplete, practiceScope })` where `practiceScope` is `null` (unrestricted) or an array of practice-id strings. A referral outside scope throws `not_found` with `status: 404`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/practice-payouts.test.js`:

```javascript
describe('status writes are practice-scoped', () => {
  let referralId;
  let otherPracticeManager;

  beforeAll(async () => {
    // A referral belonging to practice[0].
    const ref = await signIn('07700 902001');
    await request(app).post('/me/profile').set(auth(ref.token))
      .send({ firstName: 'Scope', lastName: 'Test', notifyOptIn: false });
    const role = await request(app).post('/me/role').set(auth(ref.token)).send({ role: 'referrer' });

    const friend = await signIn('07700 902002');
    await request(app).post('/me/profile').set(auth(friend.token))
      .send({ firstName: 'Friend', notifyOptIn: false });
    await request(app).post('/me/role').set(auth(friend.token)).send({ role: 'referred' });
    const sub = await request(app).post('/referrals').set(auth(friend.token)).send({
      code: role.body.user.referralCode,
      fullName: 'Scoped Patient',
      treatmentInterest: 'implants',
      preferredPracticeId: t.practices[0].id,
      consent: true,
      consentVersion: 'referred-v1-2026-08',
    });
    referralId = sub.body.referral.id;

    // A manager at a DIFFERENT practice.
    otherPracticeManager = await managerFor('07700 902003', t.practices[1].id);
  });

  it('404s a manager moving another practice\'s referral, and writes no credit', async () => {
    const res = await request(app)
      .patch(`/admin/referrals/${referralId}/status`)
      .set(auth(otherPracticeManager))
      .send({ status: 'treatment_started' });

    // 404, not 403: a 403 would confirm the referral exists to someone who must not know.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');

    const { rows } = await db.query(
      `select count(*)::int as n from wallet_ledger where referral_id = $1`,
      [referralId],
    );
    expect(rows[0].n).toBe(0);

    const { rows: still } = await db.query(`select status from referrals where id = $1`, [referralId]);
    expect(still[0].status).toBe('new');
  });

  it('lets the owning practice\'s manager move it', async () => {
    const owner = await managerFor('07700 902004', t.practices[0].id);
    const res = await request(app)
      .patch(`/admin/referrals/${referralId}/status`)
      .set(auth(owner))
      .send({ status: 'contacted' });
    expect(res.status).toBe(200);
  });

  it('lets an admin move any practice\'s referral', async () => {
    const res = await request(app)
      .patch(`/admin/referrals/${referralId}/status`)
      .set(auth(t.admin))
      .send({ status: 'booked' });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run test/practice-payouts.test.js -t "practice-scoped"`
Expected: FAIL. The first test gets 403 (the current `MANAGER_ALLOWED` regex blocks the route outright) rather than 404. It will keep failing after Task 5 opens the route unless this guard lands.

- [ ] **Step 3: Add the scope guard to `updateStatus`**

In `apps/api/src/services/referralService.js`, change the signature and add the guard immediately after the referral is loaded:

```javascript
export async function updateStatus({ referralId, status, lostReason, actorId, actorKind = null, privilegedComplete = false, practiceScope = null }) {
  const { rows } = await db.query(`select * from referrals where id=$1`, [referralId]);
  const referral = rows[0];
  if (!referral) throw Object.assign(new Error('not_found'), { status: 404 });

  // A manager may only touch their own practice's patients. 404 rather than 403 on purpose:
  // a 403 tells someone who should not know that this referral id exists at all. `null` means
  // unrestricted (an admin); an empty array means a manager with no practice, who reaches nothing.
  if (practiceScope !== null) {
    const owning = referral.booked_practice_id ?? referral.preferred_practice_id;
    if (!owning || !practiceScope.includes(owning)) {
      throw Object.assign(new Error('not_found'), { status: 404 });
    }
  }

  const from = referral.status;
```

- [ ] **Step 4: Pass the scope from the route**

In `apps/api/src/app.js`, the `PATCH /admin/referrals/:id/status` handler becomes:

```javascript
  app.patch('/admin/referrals/:id/status', requireAdmin, requireUuidParam('id'), validate(statusUpdateSchema), wrap(async (req, res) => {
    const out = await updateStatus({
      referralId: req.params.id,
      status: req.data.status,
      lostReason: req.data.lostReason,
      actorId: req.admin.id,
      actorKind: 'admin',
      privilegedComplete: true,
      practiceScope: actionScope(req),
    });
    res.json(out);
  }));
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && npx vitest run`
Expected: The two manager tests still fail with 403 (the route is not open to managers until Task 5); the admin test passes. This is correct and expected at this point — Task 5 turns them green. Confirm the failures say 403, not 500.

- [ ] **Step 6: Commit**

```bash
ggshield secret scan pre-commit
git add apps/api/src/services/referralService.js apps/api/src/app.js apps/api/test/practice-payouts.test.js
git commit -m "feat: practice-scope the referral status write

Guard lands before the route opens to managers in a later commit, so the
window where a manager could credit another practice's patient never exists."
```

---

### Task 4: Scope the reads a manager will see

`GET /admin/stats` is completely unscoped today (`_req`, no filter) and would hand a manager company-wide liability. `GET /admin/referrals` scopes on `preferred_practice_id` alone, which ignores where the patient actually booked.

**Files:**
- Modify: `apps/api/src/app.js:309-331` (`GET /admin/referrals`), `:440-456` (`GET /admin/stats`)
- Test: `apps/api/test/admin.test.js` (append a `describe`)

**Interfaces:**
- Consumes: `practiceScope(req)` from `apps/api/src/app.js:91` (returns `null` for an admin, a `'{uuid,uuid}'` Postgres array literal for a manager, `'{}'` for a scopeless one).
- Produces: `GET /admin/stats` returns `{ stats: { commissionPennies, liabilityPennies, creditedPennies, referralCounts } }`, where `liabilityPennies` is `null` for a manager and `creditedPennies` is the sum of credits for referrals owned by the scoped practice(s).

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/admin.test.js`, matching that file's existing boot and helper conventions:

```javascript
describe('manager-visible reads are practice-scoped', () => {
  it('scopes referral counts and hides company liability from a manager', async () => {
    const practices = (await request(app).get('/practices')).body.practices;
    const { token: manager } = await adminSession(app, {
      email: 'scoped-stats@gmdental.co.uk',
      role: 'manager',
      practiceIds: [practices[1].id],
    });

    const asAdmin = await request(app).get('/admin/stats').set(auth(adminToken));
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.stats.liabilityPennies).toEqual(expect.any(Number));

    const asManager = await request(app).get('/admin/stats').set(auth(manager));
    expect(asManager.status).toBe(200);
    // Company-wide liability is not a manager's number.
    expect(asManager.body.stats.liabilityPennies).toBeNull();
    expect(asManager.body.stats.creditedPennies).toEqual(expect.any(Number));

    const adminTotal = Object.values(asAdmin.body.stats.referralCounts)
      .reduce((a, b) => a + b, 0);
    const managerTotal = Object.values(asManager.body.stats.referralCounts)
      .reduce((a, b) => a + b, 0);
    expect(managerTotal).toBeLessThanOrEqual(adminTotal);
  });

  it('scopes /admin/referrals on the practice the patient actually booked at', async () => {
    const practices = (await request(app).get('/practices')).body.practices;
    const { rows: [referral] } = await db.query(
      `select id, preferred_practice_id from referrals
        where preferred_practice_id is not null limit 1`,
    );
    // The form said practice A; Dental Os says the appointment is at practice B.
    const otherPractice = practices.find((p) => p.id !== referral.preferred_practice_id);
    await db.query(`update referrals set booked_practice_id = $2 where id = $1`,
      [referral.id, otherPractice.id]);

    const { token: bookedManager } = await adminSession(app, {
      email: 'booked-practice@gmdental.co.uk',
      role: 'manager',
      practiceIds: [otherPractice.id],
    });
    const seen = await request(app).get('/admin/referrals').set(auth(bookedManager));
    expect(seen.status).toBe(200);
    expect(seen.body.referrals.map((r) => r.id)).toContain(referral.id);

    const { token: formManager } = await adminSession(app, {
      email: 'form-practice@gmdental.co.uk',
      role: 'manager',
      practiceIds: [referral.preferred_practice_id],
    });
    const notSeen = await request(app).get('/admin/referrals').set(auth(formManager));
    expect(notSeen.body.referrals.map((r) => r.id)).not.toContain(referral.id);
  });
});
```

Both tests need the route open to managers. If `admin.test.js` runs before Task 5 lands, they fail with 403 — expected until then.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run test/admin.test.js -t "practice-scoped"`
Expected: FAIL — `liabilityPennies` is a number for a manager (or the request 403s), and `creditedPennies` does not exist.

- [ ] **Step 3: Scope `GET /admin/referrals` on the owning practice**

In `apps/api/src/app.js`, change the two practice-related lines of the `GET /admin/referrals` query. The join gains the booked practice, and the `where` uses the owning-practice expression:

```javascript
      `select r.id, r.referred_name, r.referred_phone, r.referred_email, r.status, r.treatment_interest,
              r.appointment_starts_at, r.created_at::date::text as created_at, r.source,
              coalesce(bp.name, pp.name) as practice,
              u.first_name || ' ' || coalesce(u.last_name,'') as referrer,
              u.phone as referrer_phone, rc.code as referrer_code,
              wl.amount_pennies as commission_pennies, wl.created_at::date::text as commission_at
       from referrals r
       left join practices pp on pp.id = r.preferred_practice_id
       left join practices bp on bp.id = r.booked_practice_id
       join users u on u.id = r.referrer_id
       left join lateral (
         select code from referral_codes
         where user_id = r.referrer_id and active
         order by created_at desc limit 1
       ) rc on true
       left join wallet_ledger wl on wl.referral_id = r.id and wl.kind = 'credit'
       ${scope ? 'where coalesce(r.booked_practice_id, r.preferred_practice_id) = any($1::uuid[])' : ''}
       order by r.created_at desc`,
```

- [ ] **Step 4: Scope `GET /admin/stats`**

Replace the whole `GET /admin/stats` handler in `apps/api/src/app.js`:

```javascript
  // A manager sees their own practice's numbers. Company-wide liability (every member's
  // unpaid wallet balance) does not decompose by practice and is not a manager's business,
  // so it comes back null for them, with credited-at-this-practice in its place.
  app.get('/admin/stats', requireAdmin, wrap(async (req, res) => {
    const scope = practiceScope(req);
    const rule = await resolveRule(null);

    let liabilityPennies = null;
    if (scope === null) {
      const liability = await db.query(
        `select coalesce(sum(balance),0)::int as total from
           (select sum(amount_pennies)::int as balance from wallet_ledger group by user_id) b
         where balance > 0`,
      );
      liabilityPennies = liability.rows[0].total;
    }

    const owning = 'coalesce(r.booked_practice_id, r.preferred_practice_id)';
    const counts = await db.query(
      `select r.status, count(*)::int as n from referrals r
       ${scope ? `where ${owning} = any($1::uuid[])` : ''}
       group by r.status`,
      scope ? [scope] : [],
    );
    const credited = await db.query(
      `select coalesce(sum(l.amount_pennies),0)::int as total
         from wallet_ledger l join referrals r on r.id = l.referral_id
        where l.kind = 'credit'
        ${scope ? `and ${owning} = any($1::uuid[])` : ''}`,
      scope ? [scope] : [],
    );

    res.json({
      stats: {
        commissionPennies: rule?.amount_pennies ?? null,
        liabilityPennies,
        creditedPennies: credited.rows[0].total,
        referralCounts: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])),
      },
    });
  }));
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && npx vitest run`
Expected: The admin-side assertions pass. The manager-side ones still 403 until Task 5. `StatsStrip` on the dashboard still renders — `liabilityPennies` is unchanged for an admin.

- [ ] **Step 6: Commit**

```bash
ggshield secret scan pre-commit
git add apps/api/src/app.js apps/api/test/admin.test.js
git commit -m "feat: scope /admin/stats and /admin/referrals to the owning practice"
```

---

### Task 5: Open the routes to managers, with a coverage test that keeps it honest

Replaces the `MANAGER_ALLOWED` path regex with an explicit route list, and adds a test that walks the Express router so a future route cannot be added without a deliberate decision. This is the task that turns Tasks 3 and 4's manager tests green.

**Files:**
- Modify: `apps/api/src/middleware/auth.js:68-90`
- Test: Create `apps/api/test/manager-routes.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export const MANAGER_ROUTES` — a `Set` of `"<METHOD> <express route path>"` strings, importable by the coverage test. `requireAdmin` 403s a manager on any `/admin/*` route not in it.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/manager-routes.test.js`:

```javascript
// Fail-closed enforcement for the manager role.
//
// Managers reach a strict subset of /admin. That subset used to be one regex; it is now an
// explicit list, and this file is what stops the list from drifting. Adding an /admin route
// without deciding whether a manager may reach it fails here rather than silently opening it.
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { bootTestApp } from './helpers/app.js';
import { adminSession } from './helpers/admin.js';
import { MANAGER_ROUTES } from '../src/middleware/auth.js';

process.env.PGLITE_MEMORY = '1';

let app;
let managerToken;

const auth = (token) => ({ Authorization: `Bearer ${token}` });

/** Every "<METHOD> <path>" registered under /admin, read off the Express 4 router stack. */
function registeredAdminRoutes(expressApp) {
  const out = [];
  for (const layer of expressApp._router.stack) {
    if (!layer.route?.path || !String(layer.route.path).startsWith('/admin')) continue;
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (enabled) out.push(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
  return out.sort();
}

beforeAll(async () => {
  ({ app } = await bootTestApp());
  const practices = (await request(app).get('/practices')).body.practices;
  ({ token: managerToken } = await adminSession(app, {
    email: 'route-coverage@gmdental.co.uk',
    role: 'manager',
    practiceIds: [practices[0].id],
  }));
});

describe('manager route allowlist', () => {
  it('lists only routes that actually exist', async () => {
    const registered = new Set(registeredAdminRoutes(app));
    const phantom = [...MANAGER_ROUTES].filter((r) => !registered.has(r));
    expect(phantom, 'MANAGER_ROUTES names routes that are not registered — a typo here silently '
      + 'closes a route the manager dashboard needs').toEqual([]);
  });

  it('403s a manager on every /admin route outside the allowlist', async () => {
    const closed = registeredAdminRoutes(app).filter((r) => !MANAGER_ROUTES.has(r));
    expect(closed.length, 'expected some admin-only routes').toBeGreaterThan(0);

    for (const entry of closed) {
      const [method, routePath] = entry.split(' ');
      // Any syntactically valid uuid: the 403 must land before the handler ever looks it up.
      const url = routePath.replace(/:[^/]+/g, '00000000-0000-4000-8000-000000000000');
      const res = await request(app)[method.toLowerCase()](url)
        .set(auth(managerToken))
        .send({});
      expect(res.status, `${entry} should be closed to managers but answered ${res.status}`).toBe(403);
      expect(res.body.error).toBe('forbidden');
    }
  });

  it('does not 403 a manager on the allowlisted routes', async () => {
    for (const entry of MANAGER_ROUTES) {
      const [method, routePath] = entry.split(' ');
      const url = routePath.replace(/:[^/]+/g, '00000000-0000-4000-8000-000000000000');
      const res = await request(app)[method.toLowerCase()](url)
        .set(auth(managerToken))
        .send({});
      // 200/404/409/422 are all fine — the point is the role gate did not reject it.
      expect(res.status, `${entry} should be open to managers`).not.toBe(403);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run test/manager-routes.test.js`
Expected: FAIL — `MANAGER_ROUTES` is not exported from `auth.js`.

- [ ] **Step 3: Replace the regex with the allowlist**

In `apps/api/src/middleware/auth.js`, replace the `MANAGER_ALLOWED` constant:

```javascript
// A manager gets a practice-scoped subset of the dashboard (2026-09-10 decision, superseding
// the 2026-08-28 payouts-only rule): their practice's pipeline, patients, payouts and stats.
//
// This is an explicit list rather than a path regex so that the answer to "can a manager reach
// this?" is a line you can read, and so manager-routes.test.js can enforce that every
// registered /admin route has an answer. Fail closed: anything absent from this list is 403.
//
// Keys are "<METHOD> <express route path>" — the route PATTERN (with :id), not the request url.
export const MANAGER_ROUTES = new Set([
  'GET /admin/me',
  'POST /admin/me/password',
  'GET /admin/payouts',
  'POST /admin/payouts/:id/mark-paid',
  'POST /admin/payouts/:id/cancel',
  'GET /admin/referrals',
  'PATCH /admin/referrals/:id/status',
  'GET /admin/patients',
  'GET /admin/patients/:id',
  'GET /admin/stats',
]);
```

And in `requireAdmin`, replace the role gate:

```javascript
    if (admin.role === 'manager' && !MANAGER_ROUTES.has(`${req.method} ${req.route?.path ?? req.path}`)) {
      return res.status(403).json({ error: 'forbidden' });
    }
```

`req.route` is set by Express before route-level middleware runs, so this sees the pattern (`/admin/payouts/:id/cancel`), not the concrete url. The `?? req.path` fallback can only produce a string with a real uuid in it, which never matches the Set — so an unexpected mounting still fails closed.

- [ ] **Step 4: Remove `GET /admin/patients` entries temporarily**

Task 8 creates those two routes. Until then, the "lists only routes that actually exist" test flags them as phantom. Comment them out of `MANAGER_ROUTES` for this commit with a marker, and Task 8 restores them:

```javascript
  // Restored in the patients-page commit — the routes do not exist yet.
  // 'GET /admin/patients',
  // 'GET /admin/patients/:id',
```

- [ ] **Step 5: Run the full suite**

Run: `cd apps/api && npx vitest run`
Expected: PASS — including Task 3's and Task 4's manager tests, which now reach their routes and assert 404/scoped data instead of 403.

- [ ] **Step 6: Commit**

```bash
ggshield secret scan pre-commit
git add apps/api/src/middleware/auth.js apps/api/test/manager-routes.test.js
git commit -m "feat: explicit manager route allowlist with router coverage test"
```

---

### Task 6: The lead follows the practice they actually booked at

**Files:**
- Modify: `apps/api/src/services/dentally/syncService.js:238-287` (`processBookedPage`)
- Test: `apps/api/test/dentally.test.js` (append a `describe`)

**Interfaces:**
- Consumes: `booked_practice_id` from Task 1, `practiceIdForSite(siteId)` from `syncService.js:65`.
- Produces: `processBookedPage` writes `referrals.booked_practice_id` from the appointment's site, and logs an `events` row with `action: 'practice_reassigned'` when the owning practice changes.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/dentally.test.js`, following that file's existing stub-mode conventions:

```javascript
describe('booking re-attributes the lead to the practice it happened at', () => {
  it('sets booked_practice_id and moves the lead into that practice scope', async () => {
    const practices = (await request(app).get('/practices')).body.practices;
    const formPractice = practices[0];
    const bookedPractice = practices[1];

    // A referral whose form said formPractice.
    const ref = await signIn('07700 903001');
    await request(app).post('/me/profile').set(auth(ref.token))
      .send({ firstName: 'Reattrib', lastName: 'Referrer', notifyOptIn: false });
    const role = await request(app).post('/me/role').set(auth(ref.token)).send({ role: 'referrer' });

    const friendPhone = '+447700903002';
    const friend = await signIn('07700 903002');
    await request(app).post('/me/profile').set(auth(friend.token))
      .send({ firstName: 'Reattrib', lastName: 'Friend', notifyOptIn: false });
    await request(app).post('/me/role').set(auth(friend.token)).send({ role: 'referred' });
    const sub = await request(app).post('/referrals').set(auth(friend.token)).send({
      code: role.body.user.referralCode,
      fullName: 'Reattrib Friend',
      treatmentInterest: 'implants',
      preferredPracticeId: formPractice.id,
      consent: true,
      consentVersion: 'referred-v1-2026-08',
    });
    expect(sub.status).toBe(200);
    const referralId = sub.body.referral.id;

    // In stub mode a practice's dentally_site_id is its own uuid, so booking "at"
    // bookedPractice means handing the stub that practice id.
    await request(app).post('/dev/dentally/add-patient').send({ phone: friendPhone });
    const booked = await request(app).post('/dev/dentally/book-appointment').send({
      phone: friendPhone,
      practiceId: bookedPractice.id,
      startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    expect(booked.status).toBe(200);

    await request(app).post('/admin/sync/run').set(auth(adminToken));

    const { rows } = await db.query(
      `select status, booked_practice_id, preferred_practice_id from referrals where id = $1`,
      [referralId],
    );
    expect(rows[0].status).toBe('booked');
    expect(rows[0].booked_practice_id).toBe(bookedPractice.id);
    // The form's choice is retained, not overwritten — a commission dispute needs it.
    expect(rows[0].preferred_practice_id).toBe(formPractice.id);

    const { rows: events } = await db.query(
      `select action, from_value, to_value from events
        where entity_type = 'referral' and entity_id = $1 and action = 'practice_reassigned'`,
      [referralId],
    );
    expect(events).toHaveLength(1);
    expect(events[0].from_value).toBe(formPractice.id);
    expect(events[0].to_value).toBe(bookedPractice.id);
  });
});
```

If `/dev/dentally/book-appointment` does not accept a `practiceId`, extend it in Step 3 — it is a dev-only stub trigger.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run test/dentally.test.js -t "re-attributes"`
Expected: FAIL — `booked_practice_id` is null; no `practice_reassigned` event.

- [ ] **Step 3: Write `booked_practice_id` in `processBookedPage`**

In `apps/api/src/services/dentally/syncService.js`, inside `processBookedPage`'s loop over `upcoming`, replace the update block:

```javascript
      const { rows: updated } = await client.query(
        `update referrals set status='booked', appointment_dentally_id=$2, appointment_starts_at=$3
         where id=$1 and status in ('new','contacted','booked') returning id`,
        [referral.id, `appointment-${appointment.id}`, appointment.startsAt],
      );
```

with one that also records where the appointment is:

```javascript
      // Where the appointment actually is. This is what puts the lead in front of the manager
      // who can advance them — the referral form's choice is often not where they booked.
      const bookedPracticeId = await practiceIdForSite(appointment.siteId);
      const previousOwner = referral.booked_practice_id ?? referral.preferred_practice_id;

      const { rows: updated } = await client.query(
        `update referrals set status='booked', appointment_dentally_id=$2, appointment_starts_at=$3,
                              booked_practice_id=coalesce($4, booked_practice_id)
         where id=$1 and status in ('new','contacted','booked') returning id`,
        [referral.id, `appointment-${appointment.id}`, appointment.startsAt, bookedPracticeId],
      );
```

Then, after the existing `status_changed` `logEvent` call inside the same `if (updated[0])` block, add:

```javascript
      if (bookedPracticeId && bookedPracticeId !== previousOwner) {
        await logEvent(client, {
          actorKind: 'system',
          entityType: 'referral',
          entityId: referral.id,
          action: 'practice_reassigned',
          fromValue: previousOwner,
          toValue: bookedPracticeId,
          reason: `dentally appointment-${appointment.id}`,
        });
      }
      referral.booked_practice_id = bookedPracticeId ?? referral.booked_practice_id;
```

The `select` that loads candidate referrals near line 249 must also fetch the new columns, so `previousOwner` is real rather than undefined:

```javascript
    `select id, referrer_id, referred_name, referred_phone, referred_email, status,
            appointment_dentally_id, booked_practice_id, preferred_practice_id
```

`coalesce($4, booked_practice_id)` means an appointment whose site does not map to a known practice leaves the existing owner alone instead of orphaning the lead.

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
ggshield secret scan pre-commit
git add apps/api/src/services/dentally/syncService.js apps/api/test/dentally.test.js apps/api/src/app.js
git commit -m "feat: re-attribute a lead to the practice its appointment is at"
```

---

### Task 7: Demote the poller to a safety net

The poller must stop competing with managers. Two changes: it does not file a proposal for a referral that is already credited, and confirming a proposal for an already-credited referral resolves cleanly instead of throwing `409 already_credited`.

**Files:**
- Modify: `apps/api/src/services/dentally/syncService.js:147-231` (`processCompletedPage`)
- Modify: `apps/api/src/services/dentally/proposalService.js:31-110` (`confirmProposal`)
- Test: `apps/api/test/dentally.test.js` (append a `describe`)

**Interfaces:**
- Consumes: `updateStatus`'s crediting behaviour from Task 2.
- Produces: `confirmProposal(proposalId, adminId)` returns `{ ok: true, credit: null, alreadyCredited: true }` when a credit already existed, and `{ ok: true, credit: { amountPennies } }` otherwise. It no longer throws `already_credited`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/dentally.test.js`:

```javascript
describe('the poller is a safety net, not a second payer', () => {
  it('files no proposal for a referral a manager already credited', async () => {
    const { referralId, friendPhone } = await referredFriendReadyToComplete('07700 904001');

    await request(app).patch(`/admin/referrals/${referralId}/status`)
      .set(auth(adminToken)).send({ status: 'treatment_started' });

    await request(app).post('/dev/dentally/complete-treatment')
      .send({ phone: friendPhone, practiceId: practiceId, amountPennies: 52000 });
    await request(app).post('/admin/sync/run').set(auth(adminToken));

    const { rows } = await db.query(
      `select count(*)::int as n from completion_proposals where referral_id = $1`,
      [referralId],
    );
    expect(rows[0].n, 'a credited referral is done — the owner needs no chore for it').toBe(0);
  });

  it('resolves an open proposal cleanly when a manager credits first', async () => {
    const { referralId, friendPhone } = await referredFriendReadyToComplete('07700 904002');

    // Proposal filed first...
    await request(app).post('/dev/dentally/complete-treatment')
      .send({ phone: friendPhone, practiceId, amountPennies: 52000 });
    await request(app).post('/admin/sync/run').set(auth(adminToken));
    const { rows: [proposal] } = await db.query(
      `select id from completion_proposals where referral_id = $1 and status = 'open'`,
      [referralId],
    );
    expect(proposal).toBeDefined();

    // ...then a manager credits before anyone clicks it.
    await request(app).patch(`/admin/referrals/${referralId}/status`)
      .set(auth(adminToken)).send({ status: 'treatment_started' });

    const confirm = await request(app)
      .post(`/admin/proposals/${proposal.id}/confirm`).set(auth(adminToken));
    expect(confirm.status, 'must not 409 — the outcome the poller wanted already happened').toBe(200);
    expect(confirm.body.alreadyCredited).toBe(true);
    expect(confirm.body.credit).toBeNull();

    const { rows: credits } = await db.query(
      `select count(*)::int as n from wallet_ledger where referral_id = $1 and kind = 'credit'`,
      [referralId],
    );
    expect(credits[0].n).toBe(1);

    const { rows: [ref] } = await db.query(`select status from referrals where id = $1`, [referralId]);
    expect(ref.status).toBe('treatment_completed');
  });
});
```

Add the shared setup helper near the top of the same file:

```javascript
/** A referrer + referred friend whose referral is ready to be completed in Dentally. */
async function referredFriendReadyToComplete(referrerPhone) {
  const friendPhoneLocal = referrerPhone.replace(/(\d)$/, (d) => String((Number(d) + 5) % 10));
  const ref = await signIn(referrerPhone);
  await request(app).post('/me/profile').set(auth(ref.token))
    .send({ firstName: 'Safety', lastName: 'Net', notifyOptIn: false });
  const role = await request(app).post('/me/role').set(auth(ref.token)).send({ role: 'referrer' });

  const friend = await signIn(friendPhoneLocal);
  await request(app).post('/me/profile').set(auth(friend.token))
    .send({ firstName: 'Safety', lastName: 'Friend', notifyOptIn: false });
  await request(app).post('/me/role').set(auth(friend.token)).send({ role: 'referred' });
  const sub = await request(app).post('/referrals').set(auth(friend.token)).send({
    code: role.body.user.referralCode,
    fullName: 'Safety Friend',
    treatmentInterest: 'implants',
    preferredPracticeId: practiceId,
    consent: true,
    consentVersion: 'referred-v1-2026-08',
  });
  expect(sub.status).toBe(200);
  const friendPhone = (await db.query(`select referred_phone from referrals where id = $1`,
    [sub.body.referral.id])).rows[0].referred_phone;
  await request(app).post('/dev/dentally/add-patient').send({ phone: friendPhone });
  return { referralId: sub.body.referral.id, friendPhone };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run test/dentally.test.js -t "safety net"`
Expected: FAIL — a proposal is filed for the credited referral, and the confirm returns 409 `already_credited`.

- [ ] **Step 3: Skip proposals for credited referrals**

In `apps/api/src/services/dentally/syncService.js`, `processCompletedPage` loops over matched referrals before inserting into `completion_proposals`. Add a guard immediately before that insert:

```javascript
      // A manager already credited this one — the outcome the proposal exists to produce has
      // happened. Filing it anyway just puts a chore in the owner's queue for settled work.
      const { rows: alreadyCredited } = await db.query(
        `select 1 from wallet_ledger where referral_id = $1 and kind = 'credit' limit 1`,
        [referral.id],
      );
      if (alreadyCredited[0]) continue;
```

Note the handle: in `processCompletedPage`, `client` is the **Dentally source client** (it is what `client.listInvoices(...)` is called on a few lines above), not a database connection. The `completion_proposals` insert immediately below uses the module-level `db` imported from `../../db.js` — use the same here. Place this guard after the `if (!paidInvoice) continue;` line and before the `insert into completion_proposals`.

- [ ] **Step 4: Make `confirmProposal` tolerant of an existing credit**

In `apps/api/src/services/dentally/proposalService.js`, inside the `withWalletLock` callback, after the proposal is marked confirmed and before the credit insert, check for an existing credit and branch:

```javascript
    // The manager path may have credited this referral already. That is success, not a
    // conflict: mark the proposal resolved, advance the referral to its final stage, and
    // write no second ledger row.
    const { rows: existing } = await client.query(
      `select id from wallet_ledger where referral_id = $1 and kind = 'credit' limit 1`,
      [referral.id],
    );

    const { rows: transitioned } = await client.query(
      `update referrals set status='treatment_completed'
       where id=$1 and status not in ('lost','treatment_completed') returning status`,
      [referral.id],
    );

    if (existing[0]) {
      await logEvent(client, {
        actorId: adminId, actorKind: 'admin', entityType: 'proposal', entityId: proposalId,
        action: 'confirmed', toValue: referral.id,
        reason: 'already credited by manager — no second credit written',
      });
      if (transitioned[0]) {
        await logEvent(client, {
          actorId: adminId, actorKind: 'admin', entityType: 'referral', entityId: referral.id,
          action: 'status_changed', fromValue: referral.status, toValue: 'treatment_completed',
          reason: 'dentally proposal confirmed (already credited)',
        });
      }
      return { ok: true, credit: null, alreadyCredited: true };
    }
```

Delete the now-duplicated `transitioned` query that followed, keep the rest of the existing credit path unchanged, and change its final return to carry the flag:

```javascript
    return { ok: true, credit: { amountPennies: credit.amount_pennies }, alreadyCredited: false };
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && npx vitest run`
Expected: PASS. Existing proposal tests that assert `{ ok: true, credit: { amountPennies } }` still pass — the extra `alreadyCredited: false` key does not break a property assertion.

- [ ] **Step 6: Commit**

```bash
ggshield secret scan pre-commit
git add apps/api/src/services/dentally/syncService.js apps/api/src/services/dentally/proposalService.js apps/api/test/dentally.test.js
git commit -m "feat: demote the Dentally poller to a safety net behind the manager path"
```

---

### Task 8: The patients API

**Files:**
- Modify: `apps/api/src/app.js` (two new routes, next to `GET /admin/referrals`)
- Modify: `apps/api/src/middleware/auth.js` (uncomment the two patients entries from Task 5)
- Create: `apps/api/src/services/patientService.js`
- Test: Create `apps/api/test/patients.test.js`

**Interfaces:**
- Consumes: the owning-practice expression from Task 4, `practiceScope(req)`.
- Produces: `listPatients(scope)` → array of row objects. `patientDetail(referralId, scope)` → `{ patient, referrer, practice, appointment, commission, timeline }` or `null` when out of scope or absent. Route `GET /admin/patients` → `{ patients: [...] }`; `GET /admin/patients/:id` → the detail object, or `404 { error: 'not_found' }`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/patients.test.js`:

```javascript
// The patients register: every referred person, who referred them, and what has happened since.
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { bootTestApp } from './helpers/app.js';
import { patientSession } from './helpers/patient.js';
import { adminSession } from './helpers/admin.js';

process.env.PGLITE_MEMORY = '1';

let app;
let db;
let authStub;
let adminToken;
let practices;
let referralId;

const auth = (token) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ({ app, db, stub: authStub } = await bootTestApp());
  adminToken = (await adminSession(app)).token;
  await request(app).put('/admin/reward-amount').set(auth(adminToken)).send({ amountPennies: 10000 });
  practices = (await request(app).get('/practices')).body.practices;

  const ref = await patientSession(app, authStub, { phone: '07700 905001' });
  await request(app).post('/me/profile').set(auth(ref.token))
    .send({ firstName: 'Rita', lastName: 'Referrer', notifyOptIn: false });
  const role = await request(app).post('/me/role').set(auth(ref.token)).send({ role: 'referrer' });

  const friend = await patientSession(app, authStub, { phone: '07700 905002' });
  await request(app).post('/me/profile').set(auth(friend.token))
    .send({ firstName: 'Percy', lastName: 'Patient', notifyOptIn: false });
  await request(app).post('/me/role').set(auth(friend.token)).send({ role: 'referred' });
  const sub = await request(app).post('/referrals').set(auth(friend.token)).send({
    code: role.body.user.referralCode,
    fullName: 'Percy Patient',
    email: 'percy@example.com',
    treatmentInterest: 'implants',
    preferredPracticeId: practices[0].id,
    consent: true,
    consentVersion: 'referred-v1-2026-08',
  });
  referralId = sub.body.referral.id;

  await request(app).patch(`/admin/referrals/${referralId}/status`)
    .set(auth(adminToken)).send({ status: 'contacted' });
});

describe('GET /admin/patients', () => {
  it('lists referred patients with their referrer and stage', async () => {
    const res = await request(app).get('/admin/patients').set(auth(adminToken));
    expect(res.status).toBe(200);
    const percy = res.body.patients.find((p) => p.id === referralId);
    expect(percy).toMatchObject({
      referred_name: 'Percy Patient',
      referred_email: 'percy@example.com',
      status: 'contacted',
      referrer: expect.stringContaining('Rita'),
    });
  });

  it('shows a manager only their own practice', async () => {
    const { token } = await adminSession(app, {
      email: 'patients-scope@gmdental.co.uk', role: 'manager', practiceIds: [practices[1].id],
    });
    const res = await request(app).get('/admin/patients').set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.patients.map((p) => p.id)).not.toContain(referralId);
  });
});

describe('GET /admin/patients/:id', () => {
  it('returns the referrer, the practice, and the stage timeline', async () => {
    const res = await request(app).get(`/admin/patients/${referralId}`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.patient).toMatchObject({ name: 'Percy Patient', email: 'percy@example.com' });
    expect(res.body.referrer).toMatchObject({ name: expect.stringContaining('Rita') });
    expect(res.body.referrer.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(res.body.practice).toMatchObject({ chosen: practices[0].name, booked: null });
    expect(res.body.commission).toMatchObject({ amountPennies: null, creditedAt: null });

    const changes = res.body.timeline.filter((e) => e.action === 'status_changed');
    expect(changes.at(-1)).toMatchObject({ to: 'contacted', actorKind: 'admin' });
  });

  it('404s a manager asking for another practice\'s patient', async () => {
    const { token } = await adminSession(app, {
      email: 'patients-detail-scope@gmdental.co.uk', role: 'manager', practiceIds: [practices[1].id],
    });
    const res = await request(app).get(`/admin/patients/${referralId}`).set(auth(token));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it('404s an unknown id', async () => {
    const res = await request(app)
      .get('/admin/patients/00000000-0000-4000-8000-000000000000').set(auth(adminToken));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run test/patients.test.js`
Expected: FAIL — 404 from Express, the routes do not exist.

- [ ] **Step 3: Write the service**

Create `apps/api/src/services/patientService.js`:

```javascript
// The patients register (2026-09-10): every referred person, who referred them, where they
// booked, and everything that has happened to them since.
//
// A "patient" here is a referred lead — a row in `referrals`. This app deliberately does not
// hold a copy of the wider Dental Os patient list.
//
// The timeline needs no new storage: `events` has recorded every status change with actor and
// timestamp since day one (NFR-03, append-only). It has simply never been displayed.
import { db } from '../db.js';

// The owning practice, defined the same way everywhere: where they actually booked, falling
// back to the practice the referral form chose.
const OWNING = 'coalesce(r.booked_practice_id, r.preferred_practice_id)';

export async function listPatients(scope) {
  const { rows } = await db.query(
    `select r.id, r.referred_name, r.referred_phone, r.referred_email, r.status,
            r.appointment_starts_at, r.created_at::date::text as created_at,
            coalesce(bp.name, pp.name) as practice,
            u.first_name || ' ' || coalesce(u.last_name,'') as referrer,
            wl.amount_pennies as commission_pennies
       from referrals r
       left join practices pp on pp.id = r.preferred_practice_id
       left join practices bp on bp.id = r.booked_practice_id
       join users u on u.id = r.referrer_id
       left join wallet_ledger wl on wl.referral_id = r.id and wl.kind = 'credit'
      ${scope ? `where ${OWNING} = any($1::uuid[])` : ''}
      order by r.created_at desc`,
    scope ? [scope] : [],
  );
  return rows;
}

/** Null when the id is unknown OR outside `scope` — the caller 404s either way, on purpose. */
export async function patientDetail(referralId, scope) {
  const { rows } = await db.query(
    `select r.id, r.referred_name, r.referred_phone, r.referred_email, r.status,
            r.treatment_interest, r.source, r.lost_reason,
            r.appointment_starts_at, r.appointment_dentally_id, r.created_at,
            pp.name as chosen_practice, bp.name as booked_practice,
            u.id as referrer_id, u.first_name || ' ' || coalesce(u.last_name,'') as referrer_name,
            u.phone as referrer_phone, rc.code as referrer_code,
            wl.amount_pennies as commission_pennies, wl.created_at as commission_at
       from referrals r
       left join practices pp on pp.id = r.preferred_practice_id
       left join practices bp on bp.id = r.booked_practice_id
       join users u on u.id = r.referrer_id
       left join lateral (
         select code from referral_codes
         where user_id = r.referrer_id and active
         order by created_at desc limit 1
       ) rc on true
       left join wallet_ledger wl on wl.referral_id = r.id and wl.kind = 'credit'
      where r.id = $1 ${scope ? `and ${OWNING} = any($2::uuid[])` : ''}`,
    scope ? [referralId, scope] : [referralId],
  );
  const row = rows[0];
  if (!row) return null;

  // events.entity_id is text; referral ids are uuids, hence the cast at the write site too.
  const { rows: timeline } = await db.query(
    `select e.action, e.from_value, e.to_value, e.reason, e.actor_kind, e.created_at,
            au.email as actor_email
       from events e
       left join admin_users au on au.id::text = e.actor_id
      where e.entity_type = 'referral' and e.entity_id = $1
      order by e.created_at asc`,
    [String(referralId)],
  );

  return {
    patient: {
      id: row.id,
      name: row.referred_name,
      phone: row.referred_phone,
      email: row.referred_email,
      status: row.status,
      treatmentInterest: row.treatment_interest,
      source: row.source,
      lostReason: row.lost_reason,
      referredAt: row.created_at,
    },
    referrer: {
      id: row.referrer_id,
      name: row.referrer_name,
      phone: row.referrer_phone,
      code: row.referrer_code,
    },
    practice: {
      chosen: row.chosen_practice,
      // Null until Dental Os reports an appointment. When it differs from `chosen`, the
      // patient booked somewhere other than the practice on their referral link.
      booked: row.booked_practice ?? null,
    },
    appointment: {
      startsAt: row.appointment_starts_at,
      dentallyId: row.appointment_dentally_id,
    },
    commission: {
      amountPennies: row.commission_pennies ?? null,
      creditedAt: row.commission_at ?? null,
    },
    timeline: timeline.map((e) => ({
      action: e.action,
      from: e.from_value,
      to: e.to_value,
      reason: e.reason,
      actorKind: e.actor_kind,
      actorEmail: e.actor_email,
      at: e.created_at,
    })),
  };
}
```

- [ ] **Step 4: Add the routes**

In `apps/api/src/app.js`, import the service alongside the other service imports:

```javascript
import { listPatients, patientDetail } from './services/patientService.js';
```

and register both routes immediately after `GET /admin/referrals`:

```javascript
  // The patients register — the same people as /admin/referrals, presented patient-first
  // rather than referral-first, and with a detail view carrying the full stage history.
  app.get('/admin/patients', requireAdmin, wrap(async (req, res) => {
    res.json({ patients: await listPatients(practiceScope(req)) });
  }));

  app.get('/admin/patients/:id', requireAdmin, requireUuidParam('id'), wrap(async (req, res) => {
    const detail = await patientDetail(req.params.id, practiceScope(req));
    // Out of scope and non-existent answer identically: a 403 here would confirm to a manager
    // that another practice has a patient with this id.
    if (!detail) return res.status(404).json({ error: 'not_found' });
    res.json(detail);
  }));
```

- [ ] **Step 5: Restore the allowlist entries**

In `apps/api/src/middleware/auth.js`, replace the commented placeholder from Task 5 with the live entries:

```javascript
  'GET /admin/patients',
  'GET /admin/patients/:id',
```

- [ ] **Step 6: Run the tests**

Run: `cd apps/api && npx vitest run`
Expected: PASS, including `manager-routes.test.js` — the two entries are no longer phantom.

- [ ] **Step 7: Commit**

```bash
ggshield secret scan pre-commit
git add apps/api/src/services/patientService.js apps/api/src/app.js apps/api/src/middleware/auth.js apps/api/test/patients.test.js
git commit -m "feat: patients register API with referrer, practice and stage timeline"
```

---

### Task 9: Role-driven navigation, and `ManagerPage` goes away

**Files:**
- Modify: `apps/admin/src/App.jsx`
- Delete: `apps/admin/src/pages/ManagerPage.jsx`, `apps/admin/test/ManagerPage.test.jsx`
- Create: `apps/admin/src/pages/PipelinePage.jsx`
- Modify: `apps/admin/src/pages/OperationsPage.jsx`
- Test: `apps/admin/test/App.test.jsx`

**Interfaces:**
- Consumes: `GET /admin/me` → `{ id, email, role, practices: [{ id, name }] }`; the scoped endpoints from Tasks 4 and 8.
- Produces: `PAGES` — an array of `{ path, label, roles }`. `loadAll()` fetches only what the signed-in role may reach. `PipelinePage` receives `{ data, loadAll, notify }`.

- [ ] **Step 1: Write the failing test**

Append to `apps/admin/test/App.test.jsx`:

```javascript
describe('role-driven navigation', () => {
  const managerRoutes = [
    { method: 'GET', path: '/admin/me', body: { id: 'm1', email: 'm@x.co', role: 'manager', practices: [{ id: 'p1', name: 'Ashford' }] } },
    { method: 'GET', path: '/admin/stats', body: { stats: { commissionPennies: 10000, liabilityPennies: null, creditedPennies: 5000, referralCounts: {} } } },
    { method: 'GET', path: '/admin/payouts', body: { payouts: [] } },
    { method: 'GET', path: '/admin/referrals', body: { referrals: [] } },
    { method: 'GET', path: '/admin/patients', body: { patients: [] } },
  ];

  it('gives a manager pipeline, patients and payouts — and no setup nav', async () => {
    const calls = stubFetchRoutes(managerRoutes);
    setToken('tok');
    render(<App />);

    expect(await screen.findByRole('link', { name: /pipeline/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /patients/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /payouts/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /reports & setup/i })).not.toBeInTheDocument();

    // A manager must never trigger a request they are not allowed to make.
    const paths = calls.map((c) => c.path);
    expect(paths).not.toContain('/admin/proposals');
    expect(paths).not.toContain('/admin/settings');
    expect(paths).not.toContain('/admin/team');
  });

  it('shows the manager their practice name', async () => {
    stubFetchRoutes(managerRoutes);
    setToken('tok');
    render(<App />);
    expect(await screen.findByText(/ashford/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/admin && npx vitest run test/App.test.jsx -t "role-driven"`
Expected: FAIL — a manager currently renders `ManagerPage`, which has no nav at all.

- [ ] **Step 3: Create the pipeline page**

Create `apps/admin/src/pages/PipelinePage.jsx`:

```jsx
import PipelineBoard from '../components/PipelineBoard.jsx';
import StatsStrip from '../components/StatsStrip.jsx';

// The pipeline is the manager's main screen and one of the owner's, so it is its own page
// rather than a card buried in Operations.
export default function PipelinePage({ data, loadAll, notify }) {
  return (
    <>
      <StatsStrip stats={data.stats} />
      <PipelineBoard referrals={data.referrals} onChanged={loadAll} notify={notify} />
    </>
  );
}
```

Remove `PipelineBoard` and `StatsStrip` from `apps/admin/src/pages/OperationsPage.jsx` so they live in one place — that file keeps the queues and the referral record.

- [ ] **Step 4: Make navigation and loading role-aware**

In `apps/admin/src/App.jsx`, replace the `PAGES` constant:

```jsx
// Managers get a strict subset of the owner's dashboard, scoped by the API to their own
// practice (see MANAGER_ROUTES in the API's middleware/auth.js — these two lists must agree).
const PAGES = [
  { path: '/', label: 'Pipeline', roles: ['admin', 'manager'] },
  { path: '/patients', label: 'Patients', roles: ['admin', 'manager'] },
  { path: '/payouts', label: 'Payouts', roles: ['admin', 'manager'] },
  { path: '/operations', label: 'Operations', roles: ['admin'] },
  { path: '/reports', label: 'Reports & Setup', roles: ['admin'] },
];
```

Replace `loadAll` so a manager never fires a request that would 403:

```jsx
  const loadAll = useCallback(async () => {
    if (!me) return;
    const isManager = me.role === 'manager';
    try {
      // Every manager-reachable endpoint, and for an admin the rest of the dashboard too.
      const shared = await Promise.all([
        api('/admin/stats'),
        api('/admin/payouts'),
        api('/admin/referrals'),
        api('/admin/patients'),
      ]);
      const [stats, payouts, referrals, patients] = shared;
      const base = {
        stats: stats.stats,
        payouts: payouts.payouts,
        referrals: referrals.referrals,
        patients: patients.patients,
      };
      if (isManager) return setData(base);

      const [settings, proposals, aging, dentally, reviews, funnel, top] = await Promise.all([
        api('/admin/settings'),
        api('/admin/proposals'),
        api('/admin/aging'),
        api('/admin/dentally/status'),
        api('/admin/referral-review'),
        api('/admin/reports/funnel'),
        api('/admin/reports/top-referrers'),
      ]);
      setData({
        ...base,
        settings: settings.settings,
        proposals: proposals.proposals,
        aging: aging.aging,
        agingDays: aging.days,
        dentally,
        reviews: reviews.reviews,
        funnel: funnel.funnel,
        topReferrers: top.topReferrers,
      });
    } catch (err) {
      notify(err.code ?? 'load_failed');
    }
  }, [notify, me]);
```

Change the load effect to run for every role:

```jsx
  useEffect(() => {
    if (signedIn && me) loadAll();
  }, [signedIn, me, loadAll]);
```

Delete the `if (me?.role === 'manager') { ... ManagerPage ... }` early return and its import. Filter the nav and resolve the page:

```jsx
  const role = me?.role ?? 'admin';
  const visiblePages = PAGES.filter((p) => p.roles.includes(role));
  const activePath = visiblePages.some((p) => p.path === route) ? route : '/';
  const PAGE_COMPONENTS = {
    '/': PipelinePage,
    '/patients': PatientsPage,
    '/payouts': PayoutsPage,
    '/operations': OperationsPage,
    '/reports': ReportsPage,
  };
  const Page = PAGE_COMPONENTS[activePath];
```

Render `visiblePages` in the `<nav>` instead of `PAGES`, and show the practice name in the header for a scoped user:

```jsx
        <h1>{me?.practices?.length === 1 ? `${me.practices[0].name} · Referrals` : 'Referral Admin'}</h1>
```

Create `apps/admin/src/pages/PayoutsPage.jsx` (Payouts is now its own route for both roles):

```jsx
import PayoutQueue from '../components/PayoutQueue.jsx';

export default function PayoutsPage({ data, loadAll, notify }) {
  return <PayoutQueue payouts={data.payouts} onChanged={loadAll} notify={notify} />;
}
```

Remove `PayoutQueue` from `OperationsPage.jsx`'s "Needs attention" grid so it is not rendered twice.

- [ ] **Step 5: Delete the manager shell**

```bash
git rm apps/admin/src/pages/ManagerPage.jsx apps/admin/test/ManagerPage.test.jsx
```

The 30-second visibility-aware refresh it carried is worth keeping. Add it to `App.jsx` for every role:

```jsx
  // The front desk leaves this open all day; a colleague's change should appear without a
  // manual reload. Only while the tab is actually in front of someone.
  useEffect(() => {
    if (!signedIn || !me) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') loadAll();
    }, 30_000);
    return () => clearInterval(timer);
  }, [signedIn, me, loadAll]);
```

- [ ] **Step 6: Run the tests**

Run: `cd apps/admin && npx vitest run`
Expected: PASS. `PatientsPage` does not exist yet — create a one-line placeholder that renders `null` so `App.jsx` imports resolve, and Task 11 fills it in.

- [ ] **Step 7: Commit**

```bash
ggshield secret scan pre-commit
git add -A apps/admin
git commit -m "feat: role-driven dashboard navigation, replacing the separate manager shell"
```

---

### Task 10: The pipeline board — columns, animation, and a confirm step on the paying stage

**Files:**
- Modify: `apps/admin/src/components/PipelineBoard.jsx`
- Modify: `apps/admin/src/theme.css`
- Test: `apps/admin/test/PipelineBoard.test.jsx`

**Interfaces:**
- Consumes: `REFERRAL_STATUSES` from Task 1 (now includes `treatment_started`), `PATCH /admin/referrals/:id/status`.
- Produces: `PipelineBoard({ referrals, onChanged, notify })` — unchanged props. Every card keeps its `Status for <name>` labelled `<select>`.

Native HTML5 drag events and the Web Animations API are used deliberately: no new dependency, and the `<select>` remains the tested, keyboard-accessible path. Drag is an enhancement on top, not the only way to move a card.

- [ ] **Step 1: Write the failing test**

Replace the contents of `apps/admin/test/PipelineBoard.test.jsx`'s `describe` with the existing two tests plus:

```javascript
  it('asks for confirmation before the stage that credits commission', async () => {
    const calls = stubFetchRoutes([{ method: 'PATCH', path: '/admin/referrals/r3/status' }]);
    const withAgreed = [
      ...referrals,
      { id: 'r3', referred_name: 'Ann Ford', referred_phone: '+447700900111', status: 'treatment_agreed', treatment_interest: 'veneers', practice: 'Ashford', referrer: 'Sarah Lewis' },
    ];
    render(<PipelineBoard referrals={withAgreed} onChanged={vi.fn()} notify={vi.fn()} />);

    await userEvent.selectOptions(screen.getByLabelText(/status for ann ford/i), 'treatment_started');
    expect(calls, 'money must not move on a single click').toHaveLength(0);

    // An inline step, never a browser confirm() — a modal dialog would block the extension.
    await userEvent.click(screen.getByRole('button', { name: /credit .*commission/i }));

    expect(calls).toEqual([
      { method: 'PATCH', path: '/admin/referrals/r3/status', body: { status: 'treatment_started' } },
    ]);
  });

  it('lets the confirmation be cancelled without sending anything', async () => {
    const calls = stubFetchRoutes([{ method: 'PATCH', path: '/admin/referrals/r3/status' }]);
    const withAgreed = [
      ...referrals,
      { id: 'r3', referred_name: 'Ann Ford', referred_phone: '+447700900111', status: 'treatment_agreed', treatment_interest: 'veneers', practice: 'Ashford', referrer: 'Sarah Lewis' },
    ];
    render(<PipelineBoard referrals={withAgreed} onChanged={vi.fn()} notify={vi.fn()} />);

    await userEvent.selectOptions(screen.getByLabelText(/status for ann ford/i), 'treatment_started');
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(calls).toHaveLength(0);
  });

  it('renders a column for the new treatment started stage', async () => {
    const withStarted = [
      ...referrals,
      { id: 'r4', referred_name: 'Bo Barnet', referred_phone: '+447700900222', status: 'treatment_started', treatment_interest: 'implants', practice: 'Barnet', referrer: 'Sarah Lewis' },
    ];
    render(<PipelineBoard referrals={withStarted} onChanged={vi.fn()} notify={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /treatment started/i })).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/admin && npx vitest run test/PipelineBoard.test.jsx`
Expected: FAIL — selecting `treatment_started` fires the PATCH immediately; there is no confirm button.

- [ ] **Step 3: Add the label and the confirm gate**

In `apps/admin/src/components/PipelineBoard.jsx`, add the new stage to `LABELS`:

```javascript
const LABELS = {
  new: 'New',
  contacted: 'Contacted',
  booked: 'Booked',
  attended: 'Attended',
  treatment_agreed: 'Treatment agreed',
  treatment_started: 'Treatment started',
  treatment_completed: 'Completed',
  lost: 'Lost',
};

// Moving a card here credits the referrer. That is a one-way, money-moving action, so it
// takes a second deliberate click — inline, never a browser confirm() dialog.
const CREDITS_COMMISSION = 'treatment_started';
```

Add a second draft state beside `lostDrafts`:

```javascript
  const [creditDrafts, setCreditDrafts] = useState({}); // referralId -> true while confirming
```

Extend `pick` to intercept the paying stage:

```javascript
  const pick = (referral, status) => {
    if (status === referral.status) return;
    if (status === 'lost') {
      setLostDrafts((d) => ({ ...d, [referral.id]: '' }));
      return;
    }
    if (status === CREDITS_COMMISSION) {
      setCreditDrafts((d) => ({ ...d, [referral.id]: true }));
      return;
    }
    setLostDrafts((d) => {
      const { [referral.id]: _dropped, ...rest } = d;
      return rest;
    });
    advance(referral.id, status);
  };
```

Clear the draft inside `advance`, alongside the existing `setLostDrafts` cleanup:

```javascript
      setCreditDrafts((d) => {
        const { [id]: _dropped, ...rest } = d;
        return rest;
      });
```

And render the confirm step inside the `<li>`, after the lost-reason block:

```jsx
                    {creditDrafts[r.id] && (
                      <span className="credit-confirm">
                        <span className="meta">
                          This credits {r.referrer}'s commission and cannot be undone here.
                        </span>
                        <button
                          className="btn-primary"
                          onClick={() => advance(r.id, CREDITS_COMMISSION)}
                        >
                          Credit {r.referrer}'s commission
                        </button>
                        <button
                          className="ghost"
                          onClick={() => setCreditDrafts((d) => {
                            const { [r.id]: _dropped, ...rest } = d;
                            return rest;
                          })}
                        >
                          Cancel
                        </button>
                      </span>
                    )}
```

- [ ] **Step 4: Render every stage as a column, and animate**

Replace the group renderer so empty stages still render (a board with holes in it reads as broken) and headings are real headings:

```jsx
        {REFERRAL_STATUSES.map((status) => {
          const group = referrals.filter((r) => r.status === status);
          return (
            <div className="pipeline-group" key={status} data-stage={status}>
              <h4>
                {LABELS[status]} <span className="count">{group.length}</span>
              </h4>
              {group.length === 0 && <p className="empty">—</p>}
              <ul>
```

Add the movement animation to `apps/admin/src/theme.css`:

```css
/* Cards settle into their new column rather than teleporting. Motion is small and fast:
   this is a work tool that gets used all day, not a showcase. */
.pipeline-group ul li {
  animation: pipeline-card-in 180ms ease-out both;
}

@keyframes pipeline-card-in {
  from { opacity: 0; transform: translateY(-4px) scale(0.98); }
  to   { opacity: 1; transform: none; }
}

.pipeline-groups {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(13rem, 1fr);
  gap: 0.75rem;
  overflow-x: auto;
}

.credit-confirm {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  margin-top: 0.5rem;
}

/* Respect the system setting — vestibular disorders are not an edge case. */
@media (prefers-reduced-motion: reduce) {
  .pipeline-group ul li { animation: none; }
}
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/admin && npx vitest run`
Expected: PASS — including the two original tests, which still drive the `<select>`.

- [ ] **Step 6: Commit**

```bash
ggshield secret scan pre-commit
git add apps/admin/src/components/PipelineBoard.jsx apps/admin/src/theme.css apps/admin/test/PipelineBoard.test.jsx
git commit -m "feat: stage columns, motion, and a confirm step on the crediting stage"
```

---

### Task 11: The patients page

**Files:**
- Create: `apps/admin/src/pages/PatientsPage.jsx` (replacing Task 9's placeholder)
- Create: `apps/admin/src/components/PatientDetail.jsx`
- Modify: `apps/admin/src/theme.css`
- Test: Create `apps/admin/test/PatientsPage.test.jsx`

**Interfaces:**
- Consumes: `GET /admin/patients` (list, preloaded into `data.patients` by Task 9's `loadAll`) and `GET /admin/patients/:id` (detail, fetched on demand).
- Produces: `PatientsPage({ data, notify })`. `PatientDetail({ detail, onClose })` renders the `patientDetail` shape from Task 8.

- [ ] **Step 1: Write the failing test**

Create `apps/admin/test/PatientsPage.test.jsx`:

```jsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PatientsPage from '../src/pages/PatientsPage.jsx';
import { clearToken, setToken } from '../src/api/client.js';
import { stubFetchRoutes } from './helpers.js';

const patients = [
  { id: 'r1', referred_name: 'Percy Patient', referred_phone: '+447700900456', referred_email: 'percy@example.com', status: 'booked', practice: 'Ashford', referrer: 'Rita Referrer', created_at: '2026-09-01', appointment_starts_at: '2026-09-20T10:00:00Z', commission_pennies: null },
  { id: 'r2', referred_name: 'Quinn Quiet', referred_phone: '+447700900789', status: 'treatment_started', practice: 'Barnet', referrer: 'Rita Referrer', created_at: '2026-09-02', commission_pennies: 10000 },
];

const detail = {
  patient: { id: 'r1', name: 'Percy Patient', phone: '+447700900456', email: 'percy@example.com', status: 'booked', referredAt: '2026-09-01T09:00:00Z' },
  referrer: { id: 'u1', name: 'Rita Referrer', phone: '+447700900123', code: 'ABCD2345' },
  practice: { chosen: 'Ashford', booked: 'Barnet' },
  appointment: { startsAt: '2026-09-20T10:00:00Z', dentallyId: 'appointment-9' },
  commission: { amountPennies: null, creditedAt: null },
  timeline: [
    { action: 'created', from: null, to: null, actorKind: 'user', at: '2026-09-01T09:00:00Z' },
    { action: 'status_changed', from: 'new', to: 'booked', actorKind: 'system', at: '2026-09-02T09:00:00Z' },
  ],
};

beforeEach(() => {
  clearToken();
  setToken('tok');
});
afterEach(() => vi.unstubAllGlobals());

describe('PatientsPage', () => {
  it('lists patients with their referrer', () => {
    stubFetchRoutes([]);
    render(<PatientsPage data={{ patients }} notify={vi.fn()} />);
    expect(screen.getByText('Percy Patient')).toBeInTheDocument();
    expect(screen.getAllByText(/rita referrer/i).length).toBeGreaterThan(0);
  });

  it('filters by name, phone or referrer', async () => {
    stubFetchRoutes([]);
    render(<PatientsPage data={{ patients }} notify={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/search patients/i), 'quinn');
    expect(screen.queryByText('Percy Patient')).not.toBeInTheDocument();
    expect(screen.getByText('Quinn Quiet')).toBeInTheDocument();
  });

  it('opens the detail panel and shows referrer, appointment and timeline', async () => {
    stubFetchRoutes([{ method: 'GET', path: '/admin/patients/r1', body: detail }]);
    render(<PatientsPage data={{ patients }} notify={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /percy patient/i }));

    expect(await screen.findByText('ABCD2345')).toBeInTheDocument();
    expect(screen.getByText(/\+447700900123/)).toBeInTheDocument();
    // Chose Ashford, booked Barnet — the mismatch has to be visible, not silently reconciled.
    expect(screen.getByText(/ashford/i)).toBeInTheDocument();
    expect(screen.getByText(/barnet/i)).toBeInTheDocument();
    expect(screen.getByText(/new → booked/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/admin && npx vitest run test/PatientsPage.test.jsx`
Expected: FAIL — `PatientsPage` is Task 9's placeholder and renders nothing.

- [ ] **Step 3: Write the detail panel**

Create `apps/admin/src/components/PatientDetail.jsx`:

```jsx
import { formatPennies } from '@gm-referral/shared/money';

const STATUS_LABELS = {
  new: 'New',
  contacted: 'Contacted',
  booked: 'Booked',
  attended: 'Attended',
  treatment_agreed: 'Treatment agreed',
  treatment_started: 'Treatment started',
  treatment_completed: 'Completed',
  lost: 'Lost',
};

const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

/** "moved to Booked by the Dentally sync" — plain English, not a database row. */
function describe_(entry) {
  const who = entry.actorEmail ?? (entry.actorKind === 'system' ? 'the Dentally sync' : entry.actorKind ?? 'someone');
  if (entry.action === 'status_changed') {
    return `${STATUS_LABELS[entry.from] ?? entry.from ?? 'start'} → ${STATUS_LABELS[entry.to] ?? entry.to} · ${who}`;
  }
  if (entry.action === 'practice_reassigned') return `Moved practice · ${who}`;
  if (entry.action === 'created') return `Referral submitted · ${who}`;
  return `${entry.action} · ${who}`;
}

export default function PatientDetail({ detail, onClose }) {
  const { patient, referrer, practice, appointment, commission, timeline } = detail;
  const bookedElsewhere = practice.booked && practice.booked !== practice.chosen;

  return (
    <aside className="patient-detail" aria-label={`Details for ${patient.name}`}>
      <header>
        <h3>{patient.name}</h3>
        <button className="ghost" onClick={onClose}>Close</button>
      </header>

      <dl>
        <dt>Phone</dt><dd>{patient.phone}</dd>
        <dt>Email</dt><dd>{patient.email ?? '—'}</dd>
        <dt>Stage</dt><dd>{STATUS_LABELS[patient.status] ?? patient.status}</dd>
        <dt>Referred by</dt>
        <dd>
          {referrer.name}
          <p className="meta">{referrer.phone}</p>
          <span className="record-code">{referrer.code ?? '—'}</span>
        </dd>
        <dt>Referred on</dt><dd>{when(patient.referredAt)}</dd>
        <dt>Practice</dt>
        <dd>
          {practice.booked ?? practice.chosen ?? '—'}
          {bookedElsewhere && (
            <p className="meta">chose {practice.chosen} on the referral link</p>
          )}
        </dd>
        <dt>Appointment</dt><dd>{when(appointment.startsAt)}</dd>
        <dt>Commission</dt>
        <dd>
          {commission.amountPennies != null
            ? <>{formatPennies(commission.amountPennies)} <p className="meta">credited {when(commission.creditedAt)}</p></>
            : <span className="meta">not yet credited</span>}
        </dd>
      </dl>

      <h4>History</h4>
      <ol className="timeline">
        {timeline.map((entry, i) => (
          <li key={`${entry.at}-${i}`}>
            <span className="timeline-when">{when(entry.at)}</span>
            <span className="timeline-what">{describe_(entry)}</span>
            {entry.reason && <p className="meta">{entry.reason}</p>}
          </li>
        ))}
      </ol>
    </aside>
  );
}
```

- [ ] **Step 4: Write the page**

Create `apps/admin/src/pages/PatientsPage.jsx`:

```jsx
import { useMemo, useState } from 'react';
import { formatPennies } from '@gm-referral/shared/money';
import { api } from '../api/client.js';
import { Card } from '../components/ui.jsx';
import PatientDetail from '../components/PatientDetail.jsx';

const STATUS_LABELS = {
  new: 'New',
  contacted: 'Contacted',
  booked: 'Booked',
  attended: 'Attended',
  treatment_agreed: 'Treatment agreed',
  treatment_started: 'Treatment started',
  treatment_completed: 'Completed',
  lost: 'Lost',
};

// Every referred person, patient-first. The list arrives with the dashboard's other data;
// only the detail is fetched on demand, so browsing the list costs nothing.
export default function PatientsPage({ data, notify }) {
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState(null);
  const [loadingId, setLoadingId] = useState(null);
  const patients = data.patients ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return patients;
    return patients.filter((p) =>
      [p.referred_name, p.referred_phone, p.referred_email, p.referrer, p.practice]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q)),
    );
  }, [patients, query]);

  const open = async (id) => {
    setLoadingId(id);
    try {
      setDetail(await api(`/admin/patients/${id}`));
    } catch (err) {
      notify(err.code ?? 'load_failed');
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div className="patients-layout">
      <Card title="Patients" count={patients.length} className="patients">
        {patients.length === 0 ? (
          <p className="empty">No patients yet — everyone who books through a referral link appears here.</p>
        ) : (
          <>
            <input
              type="search"
              className="record-search"
              placeholder="Search by name, phone, or referrer…"
              aria-label="Search patients"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="record-scroll">
              <table className="record-table">
                <thead>
                  <tr>
                    <th scope="col">Patient</th>
                    <th scope="col">Referred by</th>
                    <th scope="col">Practice</th>
                    <th scope="col">Stage</th>
                    <th scope="col">Commission</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <button className="linklike" onClick={() => open(p.id)} disabled={loadingId === p.id}>
                          {p.referred_name}
                        </button>
                        <p className="meta">{p.referred_phone}</p>
                      </td>
                      <td>{p.referrer}</td>
                      <td>{p.practice ?? '—'}</td>
                      <td><span className={`chip chip-status-${p.status}`}>{STATUS_LABELS[p.status] ?? p.status}</span></td>
                      <td>
                        {p.commission_pennies != null
                          ? <span className="amount record-credited">{formatPennies(p.commission_pennies)}</span>
                          : <span className="meta">—</span>}
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr><td colSpan={5} className="empty">No matches for “{query}”.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
      {detail && <PatientDetail detail={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
```

- [ ] **Step 5: Style the panel**

Append to `apps/admin/src/theme.css`:

```css
.patients-layout { display: grid; grid-template-columns: 1fr; gap: 1rem; }
@media (min-width: 60rem) {
  .patients-layout:has(.patient-detail) { grid-template-columns: 1fr 22rem; }
}

.patient-detail {
  border-left: 1px solid var(--line, #e5e2dc);
  padding-left: 1rem;
  animation: detail-in 200ms ease-out both;
}
@keyframes detail-in {
  from { opacity: 0; transform: translateX(8px); }
  to   { opacity: 1; transform: none; }
}

.patient-detail header { display: flex; justify-content: space-between; align-items: baseline; }
.patient-detail dl { display: grid; grid-template-columns: auto 1fr; gap: 0.375rem 1rem; }
.patient-detail dt { font-weight: 600; }

.timeline { list-style: none; padding-left: 1rem; border-left: 2px solid var(--line, #e5e2dc); }
.timeline li { position: relative; padding-bottom: 0.75rem; }
.timeline li::before {
  content: ''; position: absolute; left: -1.3rem; top: 0.35rem;
  width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--line, #b9b2a6);
}
.timeline-when { display: block; font-size: 0.8em; opacity: 0.7; }

.linklike {
  background: none; border: 0; padding: 0; font: inherit; font-weight: 600;
  color: inherit; text-decoration: underline; cursor: pointer;
}

@media (prefers-reduced-motion: reduce) { .patient-detail { animation: none; } }
```

- [ ] **Step 6: Run the tests**

Run: `cd apps/admin && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
ggshield secret scan pre-commit
git add apps/admin/src/pages/PatientsPage.jsx apps/admin/src/components/PatientDetail.jsx apps/admin/src/theme.css apps/admin/test/PatientsPage.test.jsx
git commit -m "feat: patients page with referrer, appointment and stage timeline"
```

---

### Task 12: Teach the rest of the system about the new stage

The stage exists but four reports and the mobile app still behave as if the pipeline ends at `treatment_agreed → treatment_completed`. Left alone, the aging report stops seeing patients parked at `treatment_started`, the funnel undercounts, and a referrer's phone shows a blank status the day they get paid.

**Files:**
- Modify: `apps/api/src/app.js` (funnel arithmetic), `apps/api/src/services/dentally/syncService.js:446-468` (`agingReport`)
- Modify: `apps/admin/src/components/ReferralRecord.jsx:4-12` (labels)
- Modify: `apps/mobile/src/components/ui.js:158`, `apps/mobile/src/screens/referred.js:236-246`
- Modify: `apps/api/src/services/templates/index.js:81` — the `friend_completed` copy
- Test: `apps/api/test/admin.test.js` (append), `apps/api/test/dentally.test.js` (append)

**Interfaces:**
- Consumes: everything from Tasks 1–11.
- Produces: no new exports. `funnel.treatmentCompleted` counts `treatment_started` + `treatment_completed`; `agingReport` includes `treatment_started`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/admin.test.js`:

```javascript
describe('reports understand treatment_started', () => {
  it('counts a started treatment in the funnel', async () => {
    const before = (await request(app).get('/admin/reports/funnel').set(auth(adminToken)))
      .body.funnel.treatmentCompleted;

    const { rows: [referral] } = await db.query(
      `select id from referrals where status not in ('lost','treatment_started','treatment_completed') limit 1`,
    );
    await request(app).patch(`/admin/referrals/${referral.id}/status`)
      .set(auth(adminToken)).send({ status: 'treatment_started' });

    const after = (await request(app).get('/admin/reports/funnel').set(auth(adminToken)))
      .body.funnel.treatmentCompleted;
    expect(after, 'a started treatment has converted — the funnel must not drop it').toBe(before + 1);
  });
});
```

Append to `apps/api/test/dentally.test.js`:

```javascript
describe('the aging report watches treatment_started', () => {
  it('surfaces a patient parked at treatment_started', async () => {
    const { rows: [referral] } = await db.query(
      `select id from referrals where status = 'treatment_started' limit 1`,
    );
    // Backdate the last status change so it is past the aging window.
    await db.query(
      `update events set created_at = now() - interval '30 days'
        where entity_type = 'referral' and entity_id = $1`,
      [String(referral.id)],
    );
    await db.query(`update referrals set created_at = now() - interval '30 days' where id = $1`,
      [referral.id]);

    const res = await request(app).get('/admin/aging').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.aging.map((a) => a.id)).toContain(referral.id);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run -t "treatment_started"`
Expected: FAIL — the funnel count is unchanged, and the aging report's `where r.status in ('booked','treatment_agreed')` excludes the row.

- [ ] **Step 3: Fix the funnel**

In `apps/api/src/app.js`, in `GET /admin/reports/funnel`:

```javascript
        consultBooked:
          (byStatus.booked ?? 0) + (byStatus.attended ?? 0) + (byStatus.treatment_agreed ?? 0) +
          (byStatus.treatment_started ?? 0) + (byStatus.treatment_completed ?? 0),
        // Treatment started is the commercial outcome — it is what pays the referrer. A
        // patient mid-course has converted just as much as one who has finished.
        treatmentCompleted: (byStatus.treatment_started ?? 0) + (byStatus.treatment_completed ?? 0),
```

In `GET /admin/reports/top-referrers`, the `completed` count becomes:

```javascript
              count(distinct r.id) filter (where r.status in ('treatment_started','treatment_completed'))::int as completed,
```

- [ ] **Step 4: Fix the aging report**

In `apps/api/src/services/dentally/syncService.js`, `agingReport`:

```javascript
     where r.status in ('booked','treatment_agreed','treatment_started')
```

and update the doc comment above it:

```javascript
/** FR-25 aging report: referrals sitting at booked/treatment_agreed/treatment_started ≥ N days with no proposal. */
```

- [ ] **Step 5: Add the label everywhere it is missing**

`apps/admin/src/components/ReferralRecord.jsx` — add to `STATUS_LABELS`:

```javascript
  treatment_started: 'Treatment started',
```

`apps/mobile/src/components/ui.js` line 158 — add beside `treatment_agreed`:

```javascript
  treatment_started: 'Treatment started',
```

`apps/mobile/src/screens/referred.js` — add the stage to the progress list around line 240:

```javascript
    ['treatment_agreed', 'Treatment planned'],
    ['treatment_started', 'Treatment started'],
```

and include it in the appointment-visible list at line 246, so the appointment card does not vanish the moment treatment begins:

```javascript
  const showAppt = appt && ['booked', 'attended', 'treatment_agreed', 'treatment_started'].includes(status?.status);
```

- [ ] **Step 6: Fix the notification copy**

The copy lives in `apps/api/src/services/templates/index.js:81` — not in `docs/email-templates/`, which holds only the Supabase auth templates (`confirm-signup.html`, `magic-link-or-otp.html`) and needs no change.

The template **key** `friend_completed` stays as it is: queued `notification_outbox` rows already reference it, and renaming it would strand them. Only the wording changes, because the money now arrives when treatment *starts*:

```javascript
        `A friend you referred has started their treatment, so <strong style="color:${GOLD_BRIGHT};">${amount}</strong> is now on your Gold Card.`,
```

Check the subject line rendered alongside it in the same template block and make it agree; if it says "completed", change it to "started" too.

- [ ] **Step 7: Run everything**

Run: `cd apps/api && npx vitest run && cd ../admin && npx vitest run && cd ../shared && npx vitest run`
Expected: PASS across all three suites.

- [ ] **Step 8: Commit**

```bash
ggshield secret scan pre-commit
git add -A
git commit -m "feat: teach reports, mobile and notifications about treatment_started"
```

---

## Deployment

Not a task — do this after all twelve are merged and green.

1. Apply `0016_manager_pipeline.sql` to **staging** first. `db.js` applies migrations on boot, so deploying the API is enough; confirm the log shows `0016` applied and that `referrals_owning_practice` exists.
2. Smoke-test on staging with a real manager account: sign in, see only that practice's pipeline and patients, move a test patient to `treatment_started`, confirm the referrer's balance moves and that a second manager at another practice cannot see the same patient.
3. Then production. Ruhith authorised applying these migrations directly (2026-09-10). All three statements are additive and no existing row changes owner, so the migration is safe to apply ahead of the code — but it does nothing useful until the code that reads `booked_practice_id` ships.
4. After deploying, watch for `practice_reassigned` events. A burst of them means the referral links point at practices people do not actually attend, which is a product signal worth acting on separately.

## Self-review notes

- **Spec coverage:** §1 → Task 1. §2 → Tasks 3, 4, 5. §3 → Tasks 2, 12. §4 → Tasks 6, 7. §5 → Task 8. §6 → Tasks 9, 10, 11. §7 → tests distributed across all twelve.
- **Task 5 ordering:** Tasks 3 and 4 write tests that cannot pass until Task 5 opens their routes. This is deliberate and is called out in each task's expected output — the guard must exist before the door opens, so there is never a commit where a manager can reach an unguarded write.
- **Naming consistency:** `booked_practice_id` (column), `practiceScope` (read scope, a `'{…}'` array literal), `actionScope` (write scope, a JS array), `MANAGER_ROUTES` (the allowlist), `treatment_started` (the stage) are used identically throughout.
