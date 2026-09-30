import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { apartarCatalogos } from './helpers/catalogos-globales.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { recordIncomeTaxInput } from '../../src/services/fiscal/provisional-income-tax-inputs.js';
import {
  buildProvisionalIncomeTaxWorkpaper,
  type ProvisionalIncomeTaxWorkpaper,
} from '../../src/services/fiscal/provisional-income-tax.js';

// ============================================================
// MNE-001-059 · THE PROVISIONAL ISR OF AUGUST 2026, BY HAND (LISR art. 14)
//
// Posted through the real services:
//   4100 sales   Feb 1 000 000.00, Jul 234 567.89, Sep 50 000.00 (outside)
//   4400 return  Mar 10 000.00 (debit)
//   4310 interest Aug 1 234.56, of which the bank withheld 123.45 of ISR
//   a CLOSING entry on 31 Aug that sweeps 4100: a tax figure never reads it
//
//   nominal income   1 000 000 + 234 567.89 − 10 000 + 1 234.56 = 1 225 802.45
//   coefficient      0.0875, from the 2025 return filed 2026-03-20
//   PTU paid         24 000 → (8 − 4) / 8 = 12 000
//   losses           30 000 updated through 2025-12, to 2026-06 by INPC
//                    142.8 / 140 = 1.0200 → 30 600
//   rate             0.3000 (legal_parameters, LISR art. 9)
//   prior payments   15 000.40
//
//   cents: profit 107 257.71 − 12 000 − 30 600 = 64 657.71 × 30 % = 19 397.31
//          − 15 000.40 − 123.45 = 4 273.46
//   whole (cada_renglon, default): 1 225 802 × 0.0875 = 107 257.675 → 107 258
//          − 12 000 − 30 600 = 64 658 × 30 % = 19 397.4 → 19 397
//          − 15 000 − 123 = 4 274
// ============================================================

apartarCatalogos('inpc_serie');

const BASE = 'MNE-001-059 sintética';

let f: Fixture;
let august: ProvisionalIncomeTaxWorkpaper;

async function post(date: string, type: JournalEntryType, lines: Array<[string, string | null, string | null]>) {
  const [y, m, d] = date.split('-').map(Number);
  await createJournalEntry(
    f.entityId, new Date(Date.UTC(y, m - 1, d)), type, 'MNE-001-059',
    lines.map(([account_id, debit_amount, credit_amount]) => ({ account_id, debit_amount, credit_amount, description: 'x' })),
    f.userId,
    { autoPost: true }
  );
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-059 ISR provisional');
  await seedPolicies({ tenantId: f.tenantId });
  const sales = f.cuentas['4100'];
  const receivables = f.roles['cxc'];
  const bank = f.roles['banco'];

  await post('2026-02-10', JournalEntryType.STANDARD, [[receivables, '1000000.00', null], [sales, null, '1000000.00']]);
  await post('2026-03-10', JournalEntryType.STANDARD, [[f.cuentas['4400'], '10000.00', null], [receivables, null, '10000.00']]);
  await post('2026-07-10', JournalEntryType.STANDARD, [[receivables, '234567.89', null], [sales, null, '234567.89']]);
  await post('2026-08-31', JournalEntryType.STANDARD, [
    [bank, '1111.11', null], [f.roles['isr_retenido_a_favor'], '123.45', null], [f.cuentas['4310'], null, '1234.56'],
  ]);
  await post('2026-08-31', JournalEntryType.CLOSING, [[sales, '1234567.89', null], [f.cuentas['3200'] ?? receivables, null, '1234567.89']]);
  await post('2026-09-10', JournalEntryType.STANDARD, [[receivables, '50000.00', null], [sales, null, '50000.00']]);

  const scope = entityScope(f.tenantId, f.entityId);
  await recordIncomeTaxInput(scope, {
    kind: 'profit_coefficient', value: '0.0875', sourceFiscalYear: 2025, sourceFiledOn: '2026-03-20',
    sourceDocument: 'Declaración anual 2025, operación 000123',
  });
  await recordIncomeTaxInput(scope, {
    kind: 'pending_tax_losses', value: '30000.00', sourceFiscalYear: 2025, sourceFiledOn: '2026-03-20',
    sourceDocument: 'Declaración anual 2025, operación 000123', updatedThrough: '2025-12',
  });
  await query(
    `INSERT INTO inpc_serie (anio, mes, valor, base, fuente) VALUES (2025, 12, 140, $1, 'manual'), (2026, 6, 142.8, $1, 'manual')`,
    [BASE]
  );

  august = await buildProvisionalIncomeTaxWorkpaper({
    tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 8,
    ptuPaidInYear: '24000', priorProvisionalPayments: '15000.40',
  });
}, 180_000);

afterAll(async () => {
  await closeDatabase();
});

const line = (key: string) => august.settlement?.lines.find((l) => l.key === key);

describe('the provisional ISR of August equals the hand calculation', () => {
  it('reads the inputs from the ledger, the captured return and the law', () => {
    expect(august.blockedBy).toEqual([]);
    expect(august.findings.map((h) => h.codigo)).toEqual(['ISR-WP-REGIME-UNDECLARED']);
    expect(august.figures).toEqual({
      nominalIncome: '1225802.4500',
      profitCoefficient: '0.0875',
      ptuDeductible: '12000.0000',
      pendingLosses: '30600.0000',
      rate: '0.3000',
      priorProvisionalPayments: '15000.4000',
      withheldIncomeTax: '123.4500',
    });
    expect(august.coefficient?.sourceDocument).toBe('Declaración anual 2025, operación 000123');
    expect(august.losses).toMatchObject({ updatedThrough: '2025-12', updatedTo: '2026-06', factor: '1.0200' });
    expect(august.rate).toMatchObject({ value: '0.3000', effectiveFrom: '2014-01-01' });
  });

  it('traces the nominal income to its revenue accounts, without the close or September', () => {
    expect(Object.fromEntries(august.incomeAccounts.map((a) => [a.code, a.amount]))).toEqual({
      '4100': '1234567.8900',
      '4310': '1234.5600',
      '4400': '-10000.0000',
    });
    expect(august.withholdingAccounts.map((a) => a.amount)).toEqual(['123.4500']);
  });

  it('adjusts every line to pesos by default (cada_renglon) and keeps the cents', () => {
    expect(august.rounding).toMatchObject({ key: 'declaracion_redondeo_a_pesos', value: 'cada_renglon' });
    expect(line('estimated_profit')).toMatchObject({ cents: '107257.71', whole: '107258' });
    expect(line('taxable_base')).toMatchObject({ cents: '64657.71', whole: '64658' });
    expect(line('tax_caused')).toMatchObject({ cents: '19397.31', whole: '19397' });
    expect(august.settlement?.resultCents).toBe('4273.46');
    expect(august.settlement?.resultWhole).toBe('4274');
  });
});

describe('what the workpaper cannot vouch for, it does not settle', () => {
  it('January reads the 2024 return, which was never captured: no coefficient, no settlement', async () => {
    const jan = await buildProvisionalIncomeTaxWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 1 });
    expect(jan.blockedBy).toEqual(['ISR-WP-NO-COEFFICIENT']);
    expect(jan.settlement).toBeNull();
  });

  it('a RESICO entity (626) is not settled by art. 14', async () => {
    await query(`UPDATE legal_entities SET tax_regime = '626' WHERE id = $1`, [f.entityId]);
    try {
      const resico = await buildProvisionalIncomeTaxWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 8 });
      expect(resico.blockedBy).toEqual(['ISR-WP-REGIME']);
      expect(resico.settlement).toBeNull();
    } finally {
      await query(`UPDATE legal_entities SET tax_regime = NULL WHERE id = $1`, [f.entityId]);
    }
  });

  it('a foreign tenant answers 404', async () => {
    const other = await crearInquilino('MNE-001-059 otro');
    await expect(
      buildProvisionalIncomeTaxWorkpaper({ tenantId: other.tenantId, entityId: f.entityId, year: 2026, month: 8 })
    ).rejects.toMatchObject({ name: 'NotFoundError' });
  });
});
