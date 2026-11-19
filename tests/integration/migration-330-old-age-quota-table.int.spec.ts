import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import pg from 'pg';
import Decimal from 'decimal.js';
import {
  legalParameterAt,
  LegalParameterUnavailableError,
} from '../../src/services/jurisdiction/legal-parameters.js';

/**
 * 330 LOADS THE EMPLOYER OLD-AGE QUOTA TABLE, AND THIS SPEC TYPES IT AGAIN
 * (#661 · MNE-001-512).
 *
 * The bench of tests/integration/migracion-070-cuota-obrera.int.spec.ts: a
 * real database migrated up to the migration before this one, and the file
 * run as migrate.ts runs it, with its record in the same transaction.
 *
 * THE SECOND TRANSCRIPTION. The migration types the 64 cells as fractions
 * (0.03676). `PRINTED` below types them again as the percentages the law
 * prints (3.676), read from the image of the transitorio Segundo in the DOF
 * decree of 16-12-2020 (dof.gob.mx, nota 5607729), not copied from the
 * migration. A slipped digit or decimal place in either file fails here.
 *
 * `legal_parameters` is reference data with no tenant and no RLS (080), so
 * this bench needs no second role.
 */

const ADMIN =
  process.env.TEST_ADMIN_DATABASE_URL || process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
const DATABASE = `mnem_330_${randomBytes(4).toString('hex')}`;
const DIR = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');
const NUMBER = 330;
const FILE = '330_the_employer_old_age_quota_is_a_table_by_sbc_band_and_year.sql';
const PREFIX = 'imss.old_age.employer_rate.';
const YEARS = [2023, 2024, 2025, 2026, 2027, 2028, 2029, 2030];

/** Key suffix by band, and the row of the decree's image: 2023 … 2030, in percent. */
const PRINTED: Record<string, string> = {
  sm_1_00: '3.150 3.150 3.150 3.150 3.150 3.150 3.150 3.150',
  uma_1_50: '3.281 3.413 3.544 3.676 3.807 3.939 4.070 4.202',
  uma_2_00: '3.575 4.000 4.426 4.851 5.276 5.701 6.126 6.552',
  uma_2_50: '3.751 4.353 4.954 5.556 6.157 6.759 7.360 7.962',
  uma_3_00: '3.869 4.588 5.307 6.026 6.745 7.464 8.183 8.902',
  uma_3_50: '3.953 4.756 5.559 6.361 7.164 7.967 8.770 9.573',
  uma_4_00: '4.016 4.882 5.747 6.613 7.479 8.345 9.211 10.077',
  uma_above_4_00: '4.241 5.331 6.422 7.513 8.603 9.694 10.784 11.875',
};
const printed = (band: string, year: number): string => PRINTED[band].split(' ')[year - 2023];

const sqlOf = (file: string): string => fs.readFileSync(path.join(DIR, file), 'utf-8');
const urlWithDatabase = (url: string, database: string): string => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};
const migrationsBefore = (n: number): string[] =>
  fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.sql') && Number(f.slice(0, 3)) < n)
    .sort();

let admin: pg.Client;
let db: pg.Client;
let taxParametersBefore: string;

/** The file and its record in ONE transaction, both rolled back on failure (migrate.ts). */
async function run330(record = true): Promise<Error | undefined> {
  await db.query('BEGIN');
  try {
    await db.query(sqlOf(FILE));
    if (record) await db.query('INSERT INTO public.migrations (filename) VALUES ($1)', [FILE]);
    await db.query('COMMIT');
    return undefined;
  } catch (e) {
    await db.query('ROLLBACK');
    return e as Error;
  }
}

interface Row {
  key: string;
  from: string;
  value: string;
  unit: string;
  jurisdiction: string;
  url: string;
  note: string;
  xmin: string;
}

async function rows(): Promise<Row[]> {
  const r = await db.query<Row>(
    `SELECT key, to_char(effective_from, 'YYYY-MM-DD') AS "from", value, unit, jurisdiction,
            source_url AS url, source_note AS note, xmin::text AS xmin
       FROM legal_parameters WHERE key LIKE $1 ORDER BY key, effective_from`,
    [`${PREFIX}%`]
  );
  return r.rows;
}

async function recorded(): Promise<number> {
  const r = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.migrations WHERE filename = $1', [
    FILE,
  ]);
  return Number(r.rows[0].n);
}

/** Every Mexican row of `tax_parameters`, as text: what the calculator reads today. */
async function mexicanTaxParameters(): Promise<string> {
  const r = await db.query<{ t: string }>(
    `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id)::text, '') AS t
       FROM tax_parameters t WHERE jurisdiction = 'MX'`
  );
  return r.rows[0].t;
}

const rateAt = async (band: string, onDate: string): Promise<string> =>
  (await legalParameterAt('MX', `${PREFIX}${band}`, onDate, db as unknown as pg.PoolClient)).value;

beforeAll(async () => {
  if (!ADMIN) throw new Error('TEST_ADMIN_DATABASE_URL / MIGRATION_DATABASE_URL / DATABASE_URL is missing');
  admin = new pg.Client({ connectionString: urlWithDatabase(ADMIN, 'postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DATABASE}`);

  db = new pg.Client({ connectionString: urlWithDatabase(ADMIN, DATABASE) });
  await db.connect();
  await db.query('SET row_security = off');
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  for (const file of migrationsBefore(NUMBER)) {
    await db.query('BEGIN');
    await db.query(sqlOf(file));
    await db.query('INSERT INTO public.migrations (filename) VALUES ($1)', [file]);
    await db.query('COMMIT');
  }
  taxParametersBefore = await mexicanTaxParameters();
}, 600_000);

afterAll(async () => {
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
  await admin?.end();
});

describe('330 on an install that only knows the flat 3.150 %', () => {
  it('T1 · before it, no row of the table exists and the migration is not recorded', async () => {
    const applied = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.migrations');
    expect(Number(applied.rows[0].n), 'the bench is migrated up to the one before').toBe(
      migrationsBefore(NUMBER).length
    );
    expect(await rows()).toEqual([]);
    expect(await recorded()).toBe(0);
    expect(taxParametersBefore, 'the flat rate the calculator reads is there').toMatch(/"cesantia_vejez": 0\.03150/);
  });

  it('T6 · a cell already loaded at a wrong value stops it: the guard raises and nothing is recorded', async () => {
    // What DO NOTHING would keep in silence: an earlier manual load with one
    // digit off (6.316 for 6.361).
    await db.query(
      `INSERT INTO legal_parameters (jurisdiction, key, effective_from, value, unit, source_url)
       VALUES ('MX', $1, '2026-01-01', '0.06316', 'rate', 'https://example.invalid/manual-load')`,
      [`${PREFIX}uma_3_50`]
    );
    try {
      const failure = await run330();
      expect(failure, 'a wrong row must stop the migration').toBeDefined();
      expect((failure as unknown as { code?: string }).code).toBe('P0001');
      expect(failure!.message).toMatch(/migration 330/);
      expect(failure!.message, 'it names the year whose column is off').toMatch(/2026/);
      expect(await recorded(), 'not recorded: the next run tries again').toBe(0);
      expect(await rows(), 'and not half applied').toHaveLength(1);
    } finally {
      await db.query('DELETE FROM legal_parameters WHERE key LIKE $1', [`${PREFIX}%`]);
    }
  });

  it('T2 · it leaves exactly 64 rows: 8 bands by 8 first days of January, each with its source', async () => {
    expect(await run330()).toBeUndefined();
    expect(await recorded()).toBe(1);

    const loaded = await rows();
    expect(loaded).toHaveLength(64);
    const expected = Object.keys(PRINTED)
      .flatMap((band) => YEARS.map((year) => `${PREFIX}${band}@${year}-01-01`))
      .sort();
    expect(loaded.map((r) => `${r.key}@${r.from}`).sort()).toEqual(expected);

    for (const r of loaded) {
      const year = r.from.slice(0, 4);
      expect(r.jurisdiction).toBe('MX');
      expect(r.unit).toBe('rate');
      expect(r.url, 'the decree, which no later reform rewrites').toBe(
        'https://dof.gob.mx/nota_detalle.php?codigo=5607729&fecha=16/12/2020'
      );
      expect(r.note, `${r.key} ${year}`).toMatch(/art\. 168/);
      expect(r.note, `${r.key} ${year}`).toContain(year);
      expect(r.note, 'every year but 2030 is the transitorio').toMatch(
        year === '2030' ? /table of art\. 168 itself/ : /transitorio Segundo/
      );
    }
  });

  it('T3 · each value times 100 is the cell the law prints, the 14 off the straight line included', async () => {
    const loaded = await rows();
    let offTheLine = 0;
    for (const r of loaded) {
      const band = r.key.slice(PREFIX.length);
      const year = Number(r.from.slice(0, 4));
      expect(r.value, `${band} ${year} is stored as a five-decimal fraction`).toMatch(/^0\.\d{5}$/);
      expect(new Decimal(r.value).times(100).toFixed(3), `${band} ${year}`).toBe(printed(band, year));

      // The half-up straight line from the 3.150 % of 2022 to the 2030 figure:
      // the table the law prints is NOT that line in 14 cells, which is why it
      // is loaded cell by cell and never computed.
      const end = new Decimal(printed(band, 2030));
      const line = new Decimal('3.150')
        .plus(end.minus('3.150').times(year - 2022).div(8))
        .toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
      if (!line.eq(printed(band, year))) offTheLine += 1;
    }
    expect(offTheLine).toBe(14);
  });

  it('T4 · read by the date of the act: the year turns on 1 January, 2030 has no end, 2022 is not in force', async () => {
    expect(await rateAt('uma_3_50', '2026-03-15')).toBe('0.06361');
    expect(await rateAt('uma_3_50', '2026-12-31')).toBe('0.06361');
    expect(await rateAt('uma_3_50', '2027-01-01')).toBe('0.07164');
    expect(await rateAt('uma_above_4_00', '2030-01-01')).toBe('0.11875');
    expect(await rateAt('uma_above_4_00', '2035-06-30')).toBe('0.11875');
    for (const onDate of ['2023-01-01', '2026-07-01', '2031-02-28']) {
      expect(await rateAt('sm_1_00', onDate), onDate).toBe('0.03150');
    }

    const before = await rateAt('uma_3_50', '2022-12-31').catch((e: unknown) => e);
    expect(before).toBeInstanceOf(LegalParameterUnavailableError);
    expect((before as LegalParameterUnavailableError).gap).toBe('not_yet_in_force');
  });

  it('T5 · running it again writes nothing and still passes its guard', async () => {
    const before = await rows();
    expect(await run330(false)).toBeUndefined();
    const after = await rows();
    expect(after).toHaveLength(64);
    expect(after, 'no row rewritten: xmin is the transaction that wrote it').toEqual(before);
  });

  it('T7 · the Mexican tax_parameters are what they were: this part moves no calculation', async () => {
    const now = await mexicanTaxParameters();
    expect(now).toBe(taxParametersBefore);
    expect(now).toMatch(/"cesantia_vejez": 0\.03150/);
    expect(now, 'the employee quota too').toMatch(/"cesantia_vejez": 0\.01125/);
  });
});
