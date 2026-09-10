// Migration statements that need proving on their own, away from a freshly-migrated database
// (every other suite already proves the files apply cleanly to an empty one via initDb).
//
// 0011's email-lowercasing is the case in point (controller ruling C2, final review):
// admin_users.email is UNIQUE, so lowering 'Sam@gmdental.co.uk' while 'sam@gmdental.co.uk'
// already exists aborts the whole migration — and a deploy that can't apply 0011 has no
// working dashboard account at all. The statement is read out of the real .sql file and run
// against a scratch PGlite here, so this can never drift from what actually ships.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../supabase/migrations');

/** The one statement in `file` matching `match`, with its leading comment lines intact. */
function statementFrom(file, match) {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  const statement = sql.split(';').map((s) => s.trim()).find((s) => match.test(s));
  if (!statement) throw new Error(`no statement matching ${match} in ${file}`);
  return statement;
}

describe('0011_admin_accounts.sql email lowercasing', () => {
  let statement;
  let PGlite;

  beforeAll(async () => {
    statement = statementFrom('0011_admin_accounts.sql', /set\s+email\s*=\s*lower\s*\(/i);
    ({ PGlite } = await import('@electric-sql/pglite'));
  });

  async function scratchTable(emails) {
    const lite = new PGlite();
    await lite.exec(`create table admin_users (
      id uuid primary key default gen_random_uuid(),
      email text not null unique,
      active boolean not null default true
    )`);
    for (const email of emails) {
      await lite.query(`insert into admin_users (email) values ($1)`, [email]);
    }
    return lite;
  }

  it('trims + lowercases a row whose lowered form is still free', async () => {
    const lite = await scratchTable(['  Mixed@GMDental.co.uk  ', 'already@gmdental.co.uk']);
    try {
      await lite.exec(statement);
      const { rows } = await lite.query(`select email from admin_users order by email`);
      expect(rows.map((r) => r.email)).toEqual(['already@gmdental.co.uk', 'mixed@gmdental.co.uk']);
    } finally {
      await lite.close();
    }
  });

  it('leaves a colliding row exactly as it was instead of failing the migration', async () => {
    const lite = await scratchTable(['Dupe@gmdental.co.uk', 'dupe@gmdental.co.uk', 'Other@gmdental.co.uk']);
    try {
      await lite.exec(statement); // must not throw: a unique violation here aborts all of 0011
      const { rows } = await lite.query(`select email from admin_users order by email`);
      expect(rows.map((r) => r.email).sort()).toEqual([
        'Dupe@gmdental.co.uk', // untouched — 'dupe@…' is already taken by another row (fix by hand)
        'dupe@gmdental.co.uk',
        'other@gmdental.co.uk', // an unrelated row still gets lowered
      ].sort());
    } finally {
      await lite.close();
    }
  });
});

describe('RLS covers every table (Supabase anon-key exposure)', () => {
  let db;

  beforeAll(async () => {
    // This describe needs the REAL migrated schema, not the scratch tables above.
    // Set/restore rather than assigning at module scope: vitest reuses worker processes
    // between files, so a stray env var leaks into whichever suite runs next.
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

  // Why this test exists: the mobile app ships the Supabase ANON KEY, and anyone can extract
  // it from the APK. That is fine by design — the anon key is public — but it is only fine
  // because Supabase's auto-generated REST/GraphQL surface can read nothing. What makes that
  // true is RLS being ON with no policy granting `anon` anything.
  //
  // Nothing enforces it though. Migration 0004 lists tables by hand; admin_users and
  // dentally_oauth only have RLS because someone remembered to add it in 0007 and 0005. A
  // future migration that creates a table and forgets opens the whole table to the internet,
  // silently, until somebody thinks to look. This is that somebody.
  it('every public table has row level security enabled', async () => {
    const { rows } = await db.query(
      `select c.relname as table_name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false
        order by c.relname`,
    );
    const unprotected = rows.map((r) => r.table_name);
    expect(unprotected, `Tables without RLS — these are readable with the public anon key. `
      + `Add "alter table <name> enable row level security;" to the migration that creates them.`)
      .toEqual([]);
  });

  it('no policy grants the anon or authenticated roles anything', async () => {
    // A policy is how you would deliberately open a table back up. The only one in this schema
    // is scoped to gm_referral_api (the API's own role). If a policy ever names anon or
    // authenticated, that is a decision that deserves to be made on purpose, not noticed later.
    const { rows } = await db.query(
      `select polname, c.relname as table_name
         from pg_policy p
         join pg_class c on c.oid = p.polrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and exists (
            select 1 from pg_roles r
             where r.oid = any(p.polroles) and r.rolname in ('anon', 'authenticated')
          )`,
    );
    expect(rows.map((r) => `${r.table_name}.${r.polname}`)).toEqual([]);
  });
});

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
