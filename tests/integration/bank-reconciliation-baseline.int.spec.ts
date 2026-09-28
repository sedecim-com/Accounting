import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import {
  abrirSesion,
  clasificarPartidasDeSesion,
  estadoDeSesion,
} from '../../src/services/banking/reconciliation-service.js';

/**
 * MNE-001-038 (#324) · THE FIRST RECONCILIATION STARTS FROM A BASELINE.
 *
 * The world: an entity whose bank account carries history before the first
 * reconciled month (a migrated opening of 260 000 on June 30 and a 5 000
 * deposit on July 15), then August, the first month with a statement.
 *
 *   books at 2026-07-31          265 000   (the baseline)
 *   August in the books          +1 000 deposit, −400 check      → 265 600
 *   August at the bank           opens 265 000, +1 000           → 266 000
 *
 * Without a baseline, item discovery is cumulative and lifts the opening and
 * the July deposit as "deposits in transit": 265 000 of variance that is not
 * transit. With the baseline, only August is left to explain.
 */

let f: Fixture;
let account: string;
let glBank: string;
const scope = (): ReturnType<typeof entityScope> => entityScope(f.tenantId, f.entityId);

async function bookLine(date: string, amount: string, side: 'debit' | 'credit'): Promise<void> {
  const other = f.roles.cxc ?? Object.values(f.cuentas)[0];
  const bank = { account_id: glBank, description: 'bank' };
  const counter = { account_id: other, description: 'counter' };
  await withTransaction((client) =>
    createJournalEntry(
      f.entityId,
      new Date(`${date}T00:00:00Z`),
      JournalEntryType.STANDARD,
      `movement ${amount}`,
      side === 'debit'
        ? [
            { ...bank, debit_amount: amount, credit_amount: null },
            { ...counter, debit_amount: null, credit_amount: amount },
          ]
        : [
            { ...bank, debit_amount: null, credit_amount: amount },
            { ...counter, debit_amount: amount, credit_amount: null },
          ],
      f.userId,
      { autoPost: true, client }
    )
  );
}

async function statement(start: string, end: string, opening: string, closing: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO bank_statements (id, entity_id, bank_account_id, period_start, period_end,
       opening_balance, closing_balance, currency_code, source_format, file_sha256, imported_by)
     VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,'MXN','csv',$8,$9)`,
    [id, f.entityId, account, start, end, opening, closing, id.replace(/-/g, '').padEnd(64, '0'), f.userId]
  );
  return id;
}

async function sessionCount(): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM reconciliation_sessions WHERE bank_account_id = $1`,
    [account]
  );
  return Number(r.rows[0].n);
}

beforeAll(async () => {
  f = await crearInquilino('Baseline 038');
  glBank = f.roles.banco;
  account = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
     VALUES ($1,$2,'Operativa Baseline','Banco',$3,'MXN','checking')`,
    [account, f.entityId, glBank]
  );

  // The history before the baseline: the migrated opening and one July deposit.
  await bookLine('2026-06-30', '260000.0000', 'debit');
  await bookLine('2026-07-15', '5000.0000', 'debit');
  // August, the period: a deposit the bank also shows, and a check it does not.
  await bookLine('2026-08-10', '1000.0000', 'debit');
  await bookLine('2026-08-20', '400.0000', 'credit');

  const august = await statement('2026-08-01', '2026-08-31', '265000', '266000');
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type,
       description, is_matched, statement_id)
     VALUES ($1,$2,'2026-08-10',1000,'credit','deposit',false,$3)`,
    [uuidv4(), account, august]
  );
  // A July movement at the bank, reconciled before the baseline like the books'.
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type,
       description, is_matched)
     VALUES ($1,$2,'2026-07-15',5000,'credit','july deposit',false)`,
    [uuidv4(), account]
  );
  await statement('2026-09-01', '2026-09-30', '266000', '266000');
}, 180_000);

afterAll(async () => {
  await closeDatabase();
});

describe('bank reconciliation open --baseline', () => {
  it('refuses a baseline that disagrees with the books at its date, and states the difference', async () => {
    await expect(
      abrirSesion(
        scope(),
        { cuenta: account, periodo: '2026-08', baseline: { balance: '260000' } },
        { userId: f.userId }
      )
    ).rejects.toThrow(/265000\.00[\s\S]*difieren en 5000\.00/);
    expect(await sessionCount()).toBe(0);
  });

  it('refuses a baseline dated inside or after the period', async () => {
    await expect(
      abrirSesion(
        scope(),
        { cuenta: account, periodo: '2026-08', baseline: { balance: '265000', date: '2026-08-01' } },
        { userId: f.userId }
      )
    ).rejects.toThrow(/antes del periodo/);
    expect(await sessionCount()).toBe(0);
  });

  it('a dry run checks the baseline and writes nothing', async () => {
    const r = await abrirSesion(
      scope(),
      { cuenta: account, periodo: '2026-08', baseline: { balance: '265000' } },
      { userId: f.userId, dryRun: true }
    );
    expect(r.ensayo).toBe(true);
    expect(r.baseline).toEqual({ date: '2026-07-31', balance: '265000.00' });
    expect(await sessionCount()).toBe(0);
  });

  it('the first session only has the period to explain', async () => {
    const opened = await abrirSesion(
      scope(),
      { cuenta: account, periodo: '2026-08', baseline: { balance: '265000' } },
      { userId: f.userId }
    );
    const row = await query<{ baseline_date: string; baseline_balance: string }>(
      `SELECT baseline_date::text AS baseline_date, baseline_balance::text AS baseline_balance
         FROM reconciliation_sessions WHERE id = $1`,
      [opened.sesionId]
    );
    expect(row.rows[0]).toEqual({ baseline_date: '2026-07-31', baseline_balance: '265000.0000' });

    // Before any item: bank minus books, which with the baseline agreed is the
    // period's own difference (+1 000 at the bank, +600 in the books).
    const before = await estadoDeSesion(scope(), { sesionId: opened.sesionId });
    expect(before.aritmetica.variacion).toBe('400.00');

    const c = await clasificarPartidasDeSesion(scope(), opened.sesionId, { userId: f.userId });
    expect(
      c.levantadas.filter((p) => p.fecha <= '2026-07-31'),
      'nothing dated on or before the baseline is lifted as an item'
    ).toEqual([]);
    expect(c.levantadas.map((p) => [p.lado, p.importe]).sort()).toEqual([
      ['banco', '-400.00'],
      ['banco', '1000.00'],
      ['libros', '1000.00'],
    ]);

    const after = await estadoDeSesion(scope(), { sesionId: opened.sesionId });
    expect(after.aritmetica.variacion).toBe('0.00');
    expect(after.movimientosSinExplicar.cuantos, 'the July bank movement is not unexplained').toBe(0);
  });

  it('a later session does not bring the history back, and cannot declare its own baseline', async () => {
    await expect(
      abrirSesion(
        scope(),
        { cuenta: account, periodo: '2026-09', baseline: { balance: '265600' } },
        { userId: f.userId }
      )
    ).rejects.toThrow(/sólo la primera sesión/);

    const september = await abrirSesion(
      scope(),
      { cuenta: account, periodo: '2026-09' },
      { userId: f.userId }
    );
    const c = await clasificarPartidasDeSesion(scope(), september.sesionId, { userId: f.userId });
    expect(c.levantadas.filter((p) => p.fecha <= '2026-07-31')).toEqual([]);
    const e = await estadoDeSesion(scope(), { sesionId: september.sesionId });
    expect(e.movimientosSinExplicar.cuantos).toBe(0);
  });

  it('the schema keeps the two facts together and before the period', async () => {
    await expect(
      query(
        `INSERT INTO reconciliation_sessions
           (bank_account_id, entity_id, start_date, end_date, beginning_balance,
            ending_balance_per_bank, baseline_date)
         VALUES ($1,$2,'2026-11-01','2026-11-30',0,0,'2026-10-31')`,
        [account, f.entityId]
      )
    ).rejects.toThrow(/session_baseline_complete_and_before_period/);
    await expect(
      query(
        `INSERT INTO reconciliation_sessions
           (bank_account_id, entity_id, start_date, end_date, beginning_balance,
            ending_balance_per_bank, baseline_date, baseline_balance)
         VALUES ($1,$2,'2026-11-01','2026-11-30',0,0,'2026-11-01',0)`,
        [account, f.entityId]
      )
    ).rejects.toThrow(/session_baseline_complete_and_before_period/);
  });
});
