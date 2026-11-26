import type pg from 'pg';

// ============================================================
// MNE-001-753 (#311) · A TEST DATABASE THAT SORTS TEXT AS CI'S DOES
//
// CI runs the `postgres:15` image. That image sets `LANG en_US.utf8` and
// ci.yml passes no POSTGRES_INITDB_ARGS, so every database of CI sorts text
// with glibc's en_US.utf8: lower case before upper, punctuation ignored at
// first. A cluster born elsewhere may sort by byte (C.UTF-8, the default of
// Ubuntu's own package), and then an ORDER BY on text passes here and fails
// there. It happened twice on 24 November (commits 72bfa0c9 and e47c34af).
//
// A database made here sorts as CI's in every case this machine allows:
//   1. the cluster's default already is en_US.utf8 (CI, the devcontainer,
//      Docker): the plain CREATE DATABASE of always;
//   2. the machine has the locale but the cluster was born with another: the
//      collation is named;
//   3. the machine lacks the locale: the stand-in below, which every Postgres
//      built with ICU carries;
//   4. none of them: the cluster's default, and whoever asked is told.
//
// THE STAND-IN IS MEASURED, NOT ASSUMED, against a Postgres 16 database whose
// collation is glibc 2.39's en_US.utf8. Letters, digits, case and accents:
// 1,200 random strings, none at another place. With punctuation and symbols,
// which both ignore in the first pass: 826 of 539,100 pairs come out the other
// way round, every one between two strings with the SAME letters and digits
// («a_b» and «a-b», «1+B» and «1b»). That is an order a test must not assert
// without saying its collation. Plain `en-x-icu` is not a stand-in: it does
// not ignore punctuation, and puts «infonavit ER» before «infonavit_credit EE».
//
// scripts/setup.sh creates the development database by the same rule, in
// bash; tests/scripts/setup-script.spec.ts keeps the two names equal.
// ============================================================

/** What `datcollate` says in CI's `postgres` image. */
export const CI_COLLATION = 'en_US.utf8';
/** ICU: English, punctuation and symbols ignored at the first levels. */
export const CI_COLLATION_STAND_IN = 'en-US-u-ka-shifted-kv-symbol';

export interface DatabaseCollation {
  /** `ci`: en_US.utf8 itself. `stand-in`: the ICU locale above. `other`: neither. */
  order: 'ci' | 'stand-in' | 'other';
  /** The libc collation, or `icu:<locale>`. */
  name: string;
}

interface CollationRow {
  libc: string;
  provider: string | null;
  locale: string | null;
}

/** How a database of this cluster sorts text by default. */
export async function collationOf(client: pg.ClientBase, database: string): Promise<DatabaseCollation> {
  // NOTE: read through to_jsonb because the columns differ by major: 14 has no
  // provider, 15 and 16 call the ICU locale `daticulocale`, 17 `datlocale`.
  const { rows } = await client.query<CollationRow>(
    `SELECT d.datcollate AS libc, to_jsonb(d)->>'datlocprovider' AS provider,
            coalesce(to_jsonb(d)->>'daticulocale', to_jsonb(d)->>'datlocale') AS locale
       FROM pg_database d WHERE d.datname = $1`,
    [database]
  );
  const row = rows[0];
  if (!row) throw new Error(`no database named ${database}`);
  if (row.provider === 'i') {
    return { order: row.locale === CI_COLLATION_STAND_IN ? 'stand-in' : 'other', name: `icu:${row.locale}` };
  }
  return { order: /^en_US\.utf-?8$/i.test(row.libc) && row.provider !== 'b' ? 'ci' : 'other', name: row.libc };
}

/**
 * Runs the caller's `CREATE DATABASE <name> …` with CI's text order, or the
 * closest this server has. The statement stays at the call site, with its own
 * options (OWNER); here it only gains its collation. Both are text the caller
 * wrote, never input.
 */
export async function createDatabaseSortingAsCi(
  admin: pg.ClientBase,
  name: string,
  statement: string
): Promise<DatabaseCollation> {
  if ((await collationOf(admin, 'template1')).order !== 'ci') {
    // template0, because a copy of template1 must keep template1's collation.
    for (const collation of [
      `LOCALE_PROVIDER libc LOCALE '${CI_COLLATION}'`,
      `LOCALE_PROVIDER icu ICU_LOCALE '${CI_COLLATION_STAND_IN}'`,
    ]) {
      try {
        await admin.query(`${statement} TEMPLATE template0 ${collation}`);
      } catch {
        // This server lacks that locale, or ICU: the next one. An error of
        // another kind comes back from the plain statement below.
        continue;
      }
      return collationOf(admin, name);
    }
  }
  await admin.query(statement);
  return collationOf(admin, name);
}

/** One line for whoever runs the suite on a database that is not CI's own; null when it is. */
export function collationNotice(collation: DatabaseCollation): string | null {
  if (collation.order === 'ci') return null;
  if (collation.order === 'stand-in') {
    return (
      `This Postgres has no ${CI_COLLATION} locale, so the test database sorts with its ICU stand-in ` +
      `(${CI_COLLATION_STAND_IN}): CI's order, except between strings with the same letters and digits.`
    );
  }
  return (
    `The test database sorts text as ${collation.name} and CI as ${CI_COLLATION}: an ORDER BY on text can pass ` +
    `here and fail there. Use the devcontainer, or a Postgres built with ICU, or install the en_US.UTF-8 locale ` +
    `and restart Postgres.`
  );
}
