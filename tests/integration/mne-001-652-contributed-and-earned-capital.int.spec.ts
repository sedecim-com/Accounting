import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { closeDatabase, enterTenant } from '../../src/database/connection.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { getBalanceSheet } from '../../src/services/reporting/report-service.js';
import { JournalEntryType } from '../../src/types/index.js';

// ============================================================
// MNE-001-652 (#597) · THE BALANCE SHEET PRESENTS CONTRIBUTED CAPITAL, THEN
// EARNED CAPITAL
//
// NIF B-6 presents capital contable as contributed plus earned capital; NIF
// C-11 (migration 346's header) puts the reserves, the accumulated results
// and the ORI in earned capital, and the result of the period is an
// accumulated result not yet swept.
//
// A seeded MX entity, hand figures: bank 3,800.00 = share capital (3100)
// 2,500.00 + legal reserve (3150) 100.00 + prior years' results (3200)
// 400.00 + ORI (3600) 500.00 + the result of the period 300.00 (sales 4100
// 500.00 − administrative expense 6100 200.00). Earned capital 1,300.00.
// All data synthetic.
// ============================================================

describe('a seeded entity with capital, reserves, results, ORI and an unswept result', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await crearInquilino('MNE-001-652 contributed and earned capital');
    enterTenant(f.tenantId);
    const post = (memo: string, lines: [string, string | null, string | null][]) =>
      createJournalEntry(
        f.entityId,
        fechaEnPeriodo(3, 10),
        JournalEntryType.STANDARD,
        memo,
        lines.map(([code, debit, credit]) => ({
          account_id: f.cuentas[code], debit_amount: debit, credit_amount: credit, description: memo,
        })),
        f.userId,
        { autoPost: true }
      );
    await post('Opening equity (synthetic)', [
      ['1111', '3500.0000', null],
      ['3100', null, '2500.0000'],
      ['3150', null, '100.0000'],
      ['3200', null, '400.0000'],
      ['3600', null, '500.0000'],
    ]);
    await post('Sale (synthetic)', [['1111', '500.0000', null], ['4100', null, '500.0000']]);
    await post('Expense (synthetic)', [['6100', '200.0000', null], ['1111', null, '200.0000']]);
  });

  afterAll(async () => {
    await drainAttestations(3000);
    await closeDatabase();
  });

  it('presents contributed capital first, then reserves and results, the result of the period and ORI', async () => {
    const bs = await getBalanceSheet(f.entityId, { asOfDate: '2026-12-31' });
    expect(bs.equity.subsections.map((s) => [s.key, s.accounts.map((a) => a.code), s.total])).toEqual([
      ['equity', ['3100'], '2500.0000'],
      ['earned_capital', ['3150', '3200'], '500.0000'],
      ['result_of_the_period', [], '300.0000'],
      ['ori', ['3600'], '500.0000'],
    ]);
  });

  it('totals earned capital at 1,300.00, and contributed plus earned is equity', async () => {
    const bs = await getBalanceSheet(f.entityId, { asOfDate: '2026-12-31' });
    expect(bs.earned_capital).toEqual({
      key: 'earned_capital',
      total: '1300.0000',
      subsections: ['earned_capital', 'result_of_the_period', 'ori'],
    });
    expect(bs.equity.total).toBe('3800.0000');
    expect(bs.assets.total).toBe('3800.0000');
    expect(bs.is_balanced).toBe(true);
  });
});
