import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { collationOf, CI_COLLATION, type DatabaseCollation } from './helpers/ci-collation.js';

// ============================================================
// MNE-001-753 (#311) · THE TEST DATABASE SORTS TEXT AS CI'S DOES
//
// Two pull requests of 24 November were green here and red in CI for one
// reason: the local database sorted text by byte (C.UTF-8) and CI's with
// glibc's en_US.utf8. Why, and what a database is born with on each machine,
// is in helpers/ci-collation.ts.
//
// THE ORDERS BELOW ARE WRITTEN BY HAND FROM THE RULES, not copied from a run.
//
//   en_US.utf8 compares letters and digits first, blind to case and to
//   punctuation, and only then puts lower case before upper:
//     «a1b2» «A1B2»          the same letters; lower case first
//     «alfa» «Alfa»          after them: the digit 1 sorts before the letter l
//     «infonavit_credit EE»  read as «infonavitcreditee»: c before e, so it
//     «infonavit ER»         goes before «infonaviter»
//     «Zeta»                 z is the last letter, whatever its case
//
//   Byte order (COLLATE "C") compares code points: digits (0x30–0x39), then
//   upper case (0x41–0x5A), then lower (0x61–0x7A); a space (0x20) sorts
//   before an underscore (0x5F):
//     «A1B2» «Alfa» «Zeta»   the three that begin in upper case; 1 before l
//     «a1b2» «alfa»
//     «infonavit ER»         space before underscore
//     «infonavit_credit EE»
//
// The two real cases are in the table: the two spellings of a UUID's letters
// (MNE-001-680) and the two tax rows of a paycheck (MNE-001-658).
// ============================================================

const WORDS = ['Zeta', 'infonavit ER', 'A1B2', 'alfa', 'infonavit_credit EE', 'a1b2', 'Alfa'];
const AS_CI = ['a1b2', 'A1B2', 'alfa', 'Alfa', 'infonavit_credit EE', 'infonavit ER', 'Zeta'];
const BY_BYTE = ['A1B2', 'Alfa', 'Zeta', 'a1b2', 'alfa', 'infonavit ER', 'infonavit_credit EE'];

const hasPsql = spawnSync('psql', ['--version']).status === 0;
const withDatabase = (url: string, database: string): string => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};

describe('MNE-001-753 — the test database sorts text as CI does', () => {
  const suiteUrl = process.env.DATABASE_URL!;
  const suiteDatabase = new URL(suiteUrl).pathname.slice(1);
  const adminUrl = withDatabase(process.env.__IT_ADMIN_URL__!, 'postgres');
  let db: pg.Client;
  let admin: pg.Client;
  let born: DatabaseCollation;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: suiteUrl });
    admin = new pg.Client({ connectionString: adminUrl });
    await Promise.all([db.connect(), admin.connect()]);
    born = await collationOf(db, suiteDatabase);
  });
  afterAll(async () => {
    await Promise.all([db.end(), admin.end()]);
  });

  const ordered = async (collate = ''): Promise<string[]> =>
    (await db.query<{ w: string }>(`SELECT w FROM unnest($1::text[]) AS w ORDER BY w ${collate}`, [WORDS])).rows.map(
      (r) => r.w
    );

  it('is born with CI\'s collation, or with its stand-in where the machine lacks that locale', () => {
    expect(['ci', 'stand-in'], `the test database sorts as ${born.name}`).toContain(born.order);
  });

  // The plan read the collation of CI from the image's Dockerfile and from
  // ci.yml, without a run of CI at hand. This case is that reading, checked by
  // CI itself on every run.
  it.runIf(process.env.GITHUB_ACTIONS === 'true')('in CI the collation is en_US.utf8 itself', () => {
    expect(born.order, `CI's database sorts as ${born.name}, and the plan read ${CI_COLLATION}`).toBe('ci');
  });

  it('an ORDER BY on text lists lower case before upper, and is blind to an underscore', async () => {
    expect(await ordered()).toEqual(AS_CI);
  });

  it('COLLATE "C" lists the same words by byte, whatever the database', async () => {
    expect(await ordered('COLLATE "C"')).toEqual(BY_BYTE);
  });

  // The step creates the cluster roles too when they are missing; CI and a
  // machine this script already set up have them, and then it only creates.
  // Skipped without psql, which the script itself needs.
  it.skipIf(!hasPsql)('scripts/setup.sh creates its database with the collation the suite has', async () => {
    const database = `mnemosine_it_setup_${crypto.randomBytes(4).toString('hex')}`;
    try {
      const r = spawnSync('bash', ['scripts/setup.sh', '--only', 'database'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          TEST_ADMIN_DATABASE_URL: adminUrl,
          MIGRATION_DATABASE_URL: withDatabase(adminUrl, database),
        },
      });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain(`created ${database}`);
      expect(await collationOf(admin, database)).toEqual(born);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    }
  });
});
