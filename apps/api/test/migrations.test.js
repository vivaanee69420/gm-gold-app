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
