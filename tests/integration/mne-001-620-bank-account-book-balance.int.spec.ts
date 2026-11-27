import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry, drainAttestations, postJournalEntry } from '../../src/services/accounting/posting.js';
import { getBankAccount, listBankAccounts, setBankGlMapping } from '../../src/services/banking/bank-account-service.js';
import { ConflictError } from '../../src/utils/errors.js';

// ============================================================
// MNE-001-620 (#101) · A BANK ACCOUNT'S BOOK BALANCE AND THE REMAP GUARD,
// AGAINST POSTGRES.
//
// `bank account show` and `list` read the book balance of the mapped GL
// account, and `bank account set` counts its posted lines before a remap; both
// sums now live in report-service. The figures are the plan's, by hand:
// 1111 has two posted entries, Dr 1 000.00 and Cr 250.00, so the books say
// 1 000.00 − 250.00 = 750.00; a draft of 99.00 does not count. The bank said
// 700.00, so the difference is 750.00 − 700.00 = 50.00. Synthetic data only.
// ============================================================

let f: Fixture;
let bank: string;

const scope = () => entityScope(f.tenantId, f.entityId);

/** A balanced entry between 1111 and 6100 on 15 Mar 2026: debit 1111 when `debitBank`. */
async function entry(amount: string, debitBank: boolean, post: boolean): Promise<void> {
  const bankSide = { account_id: f.cuentas['1111'], debit_amount: debitBank ? amount : null, credit_amount: debitBank ? null : amount, description: 'banco' };
  const other = { account_id: f.cuentas['6100'], debit_amount: debitBank ? null : amount, credit_amount: debitBank ? amount : null, description: 'contra' };
  const je = await createJournalEntry(f.entityId, new Date('2026-03-15'), 'standard' as never, `Movimiento ${amount}`,
    [bankSide, other] as never, f.userId);
  if (post) await postJournalEntry(je.id, f.userId);
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-620 bank account book balance');
  bank = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, current_balance, is_active)
     VALUES ($1, $2, 'Cuenta de cheques', 'Banco de Prueba', $3, 'MXN', '700.00', true)`,
    [bank, f.entityId, f.cuentas['1111']]
  );
  await entry('1000.00', true, true);
  await entry('250.00', false, true);
  await entry('99.00', true, false);
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('MNE-001-620 · the book balance of show and list, and the posted lines of set', () => {
  it('show reads 1 000.00 − 250.00 = 750.00 from the books and 750.00 − 700.00 = 50.00 against the bank; the draft does not count', async () => {
    const shown = await getBankAccount(scope(), bank);
    expect(shown.saldoLibro).toBe('750.00');
    expect(shown.saldoBanco).toBe('700.00');
    expect(shown.diferencia).toBe('50.00');
  });

  it('list reads the same 750.00', async () => {
    const listed = await listBankAccounts(scope());
    expect(listed.map((r) => [r.id, r.saldoLibro])).toEqual([[bank, '750.00']]);
  });

  it('set to 1112 is refused naming 1111\'s 2 posted lines and their 750.00', async () => {
    const e = await setBankGlMapping(scope(), bank, '1112', { userId: f.userId }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ConflictError);
    expect((e as Error).message).toContain('1111 already has 2 posted lines (balance 750.00)');
  });

  it('forced as a dry run, set reports the 2 lines and 750.00, and the mapping stays on 1111', async () => {
    const r = await setBankGlMapping(scope(), bank, '1112', { userId: f.userId, force: true, reason: 'Prueba del remapeo', dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.movimientosPosteados).toBe(2);
    expect(r.advertencias).toEqual([
      { key: 'bank.account.warning.remapped_over_history', params: { code: '1111', lines: 2, balance: '750.00' } },
    ]);
    // Inside the rolled-back transaction the account already points at 1112, which no entry moves.
    expect(r.cuenta.saldoLibro).toBe('0.00');
    expect((await getBankAccount(scope(), bank)).glAccount?.code).toBe('1111');
  });
});
