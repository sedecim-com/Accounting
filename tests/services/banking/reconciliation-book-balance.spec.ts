import { describe, it, expect, vi } from 'vitest';

// ============================================================
// MNE-001-621 (#101) · THE RECONCILIATION'S BOOK BALANCE READS REPORT-SERVICE
//
// `saldoDeLibros` (reconciliation-service.ts) reads the posted lines on the
// bank account's GL account up to a date through report-service's
// `queryBankBookBalanceAsOf`. The real reader runs (its SQL reaches the fake
// client or pool below), wrapped in a spy so a test can say which layer was
// asked, with what, and on which connection: the transaction client of
// `open`, the pool of `status`. The bank account lookup, the audit writer, the
// panel and the item and adjustment lists are faked: what is tested is what
// the books read. The figures are checked by hand. Synthetic data only.
// ============================================================

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  currentTenant: vi.fn(() => 'ten-1'),
}));
vi.mock('../../../src/services/reporting/report-service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/services/reporting/report-service.js')>();
  return { ...real, queryBankBookBalanceAsOf: vi.fn(real.queryBankBookBalanceAsOf) };
});
vi.mock('../../../src/services/policy/policy-service.js', () => ({
  getPolicy: vi.fn(async (_scope: unknown, key: string) =>
    key === 'conciliacion_tolerancia' ? { value: 'cero_exacto', defined: false } : { value: 'bloquear_cierre', defined: false }
  ),
}));
vi.mock('../../../src/services/audit/audit-log.js', () => ({
  registrarAuditoria: vi.fn(async () => undefined),
  tenantDe: vi.fn(async () => 'ten-1'),
}));
vi.mock('../../../src/services/banking/bank-statement-service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/services/banking/bank-statement-service.js')>();
  return { ...real, resolverCuentaBancaria: vi.fn(async () => ({ id: BANK, account_name: 'Cuenta de cheques' })) };
});
vi.mock('../../../src/services/banking/reconciling-items.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/services/banking/reconciling-items.js')>();
  return { ...real, listarPartidas: vi.fn(async () => []) };
});
vi.mock('../../../src/services/banking/reconciliation-adjustments.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/services/banking/reconciliation-adjustments.js')>();
  return { ...real, listarAjustes: vi.fn(async () => []) };
});

import type pg from 'pg';
import { abrirSesion, estadoDeSesion } from '../../../src/services/banking/reconciliation-service.js';
import { query, withTransaction } from '../../../src/database/connection.js';
import { entityScope } from '../../../src/database/scope.js';
import { queryBankBookBalanceAsOf } from '../../../src/services/reporting/report-service.js';
import { ValidationError } from '../../../src/utils/errors.js';

const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BANK = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SESSION = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const STATEMENT = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const scope = entityScope('ten-1', ENTITY);
const booksRead = vi.mocked(queryBankBookBalanceAsOf);
const pool = vi.mocked(query);

/** The bank account as the reconciliation reads it; `gl` null when its GL account is another entity's. */
const accountRow = (gl: string | null) => ({
  id: BANK, account_name: 'Cuenta de cheques', account_type: 'checking', currency_code: 'MXN',
  gl_account_id: 'acc-1111', is_active: true, gl_de_la_entidad: gl,
});

/** One statement, money as strings, as Postgres hands it back. */
const statementRow = (from: string, to: string, opening: string, closing: string) => ({
  id: STATEMENT, period_start: from, period_end: to, opening_balance: opening, closing_balance: closing,
  currency_code: 'MXN', statement_number: null,
});

/** Answers each statement by its text, and refuses any other. */
function router(answers: { gl: string | null; books: string; statement: ReturnType<typeof statementRow>; session?: object }) {
  return vi.fn(async (text: string) => {
    const s = String(text);
    if (s.includes('LEFT JOIN accounts a ON a.id = b.gl_account_id')) return { rows: [accountRow(answers.gl)], rowCount: 1 };
    if (s.includes('AS balance')) return { rows: [{ balance: answers.books }], rowCount: 1 };
    // Before the sessions: its baseline floor reads reconciliation_sessions too.
    if (s.includes('FROM bank_transactions bt')) return { rows: [{ cuantos: '0', importe: '0' }], rowCount: 1 };
    if (s.includes('FROM bank_statements s')) return { rows: [answers.statement], rowCount: 1 };
    if (s.includes('FROM reconciliation_sessions s')) return { rows: answers.session ? [answers.session] : [], rowCount: 1 };
    if (s.includes('FROM reconciliation_sessions')) return { rows: [], rowCount: 0 };
    if (s.startsWith('INSERT INTO reconciliation_sessions')) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected statement: ${s.slice(0, 80)}`);
  });
}

describe('the reconciliation reads its book balance through report-service (MNE-001-621)', () => {
  // The books of the bank account at 31 Jul 2026, the day before August opens: 265 000.00.
  const AUGUST = statementRow('2026-08-01', '2026-08-31', '265000.0000', '265600.0000');

  function open(baseline: string, gl: string | null = 'acc-1111') {
    booksRead.mockClear();
    pool.mockReset();
    const q = router({ gl, books: '265000.0000', statement: AUGUST });
    const c = { query: q } as unknown as pg.PoolClient;
    vi.mocked(withTransaction).mockImplementation(async (fn) => fn(c) as never);
    const done = abrirSesion(scope, { cuenta: BANK, periodo: '2026-08', baseline: { balance: baseline } }, { userId: 'user-1', dryRun: true });
    return { c, q, done };
  }

  it('open refuses a baseline of 264 500.00 against 265 000.00 in the books, by 500.00, read once on the transaction client', async () => {
    const { c, q, done } = open('264500.00');
    const e = await done.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as Error).message).toContain('La línea base afirma 264500.00 al 2026-07-31 y los libros dicen 265000.00: difieren en 500.00');
    expect(booksRead.mock.calls).toEqual([[ENTITY, BANK, '2026-07-31', c]]);
    expect(q.mock.calls.filter(([s]) => String(s).includes('AS balance'))).toHaveLength(1);
    expect(pool).not.toHaveBeenCalled();
  });

  it('open, as a dry run, takes a baseline of 265 000.00 that agrees with the books', async () => {
    const { c, done } = open('265000.00');
    const r = await done;
    expect(r.ensayo).toBe(true);
    expect(r.baseline).toEqual({ date: '2026-07-31', balance: '265000.00' });
    expect(booksRead.mock.calls).toEqual([[ENTITY, BANK, '2026-07-31', c]]);
    expect(pool).not.toHaveBeenCalled();
  });

  it('open does not read the books of a GL account that is another entity\'s: there is nothing to assert the baseline against', async () => {
    const { done } = open('265000.00', null);
    const e = await done.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as Error).message).toContain('no pertenece al catálogo de esta entidad');
    expect(booksRead).not.toHaveBeenCalled();
  });

  it('status reads 10 000.00 − 100.00 = 9 900.00 from the books through the pool, against a statement closing at 9 900.00: variance 0.00', async () => {
    booksRead.mockClear();
    pool.mockReset();
    const session = {
      id: SESSION, bank_account_id: BANK, entity_id: ENTITY, start_date: '2026-08-01', end_date: '2026-08-31',
      beginning_balance: '0.0000', ending_balance_per_bank: '9900.0000', ending_balance_per_books: '0.0000',
      outstanding_checks: '0.0000', deposits_in_transit: '0.0000', bank_charges: '0.0000', bank_interest: '0.0000',
      other_adjustments: '0.0000', variance: '0.0000', status: 'in_progress', statement_id: STATEMENT,
      arithmetic_computed_at: null, closed_at: null, closed_by: null, approved_by: null, approved_at: null,
      approval_reason: null, approval_hash: null, posted_at: null, posted_by: null, notes: null,
      created_at: '2026-09-01', account_name: 'Cuenta de cheques', account_type: 'checking', currency_code: 'MXN',
    };
    pool.mockImplementation(router({
      gl: 'acc-1111', books: '9900.0000', statement: statementRow('2026-08-01', '2026-08-31', '0.0000', '9900.0000'), session,
    }) as never);
    const r = await estadoDeSesion(scope, { sesionId: SESSION });
    expect(booksRead.mock.calls).toEqual([[ENTITY, BANK, '2026-08-31', undefined]]);
    expect(pool.mock.calls.filter(([s]) => String(s).includes('AS balance'))).toHaveLength(1);
    expect([r.aritmetica.libros.saldo, r.aritmetica.banco.saldo, r.aritmetica.variacion]).toEqual(['9900.00', '9900.00', '0.00']);
    expect(r.aritmetica.cuadra).toBe(true);
  });
});
