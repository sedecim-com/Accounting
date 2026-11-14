import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { apartarCatalogos } from './helpers/catalogos-globales.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry, reverseJournalEntry } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import { reopenPolicy, resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
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
//   4400 return  Mar 10 000.00 (debit): a deduction of the annual return by
//                default (LISR art. 25 fr. I), not in the nominal income
//   4310 interest Aug 1 234.56, of which the bank withheld 123.45 of ISR
//   a CLOSING entry on 31 Aug that sweeps 4100: a tax figure never reads it
//   1145 also carries what must NOT count as withheld this year: the
//        opening balance of 500 (last year's, credited in last year's
//        return) and a May withholding of 100 reversed in June
//   2150 a customer advance of 5 000 in Aug: warned about, not added
//
//   nominal income   1 000 000 + 234 567.89 + 1 234.56 = 1 235 802.45
//   coefficient      0.0875, from the 2025 return filed 2026-03-20
//   PTU paid         24 000 → (8 − 4) / 8 = 12 000
//   losses           30 000 updated through 2025-12, to 2026-06 by INPC
//                    142.8 / 140 = 1.0200 → 30 600
//   rate             0.3000 (legal_parameters, LISR art. 9)
//   prior payments   15 000.40
//
//   cents: profit 108 132.71 − 12 000 − 30 600 = 65 532.71 × 30 % = 19 659.81
//          − 15 000.40 − 123.45 = 4 535.96
//   whole (cada_renglon, default): 1 235 802 × 0.0875 = 108 132.675 → 108 133
//          − 12 000 − 30 600 = 65 533 × 30 % = 19 659.9 → 19 660
//          − 15 000 − 123 = 4 537
//   with the returns netted (the panel's other option) the income is
//   1 225 802.45 and the payment 4 273.46, 4 274 in pesos
// ============================================================

apartarCatalogos('inpc_serie');

const BASE = 'MNE-001-059 sintética';

let f: Fixture;
let august: ProvisionalIncomeTaxWorkpaper;

const utc = (date: string): Date => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

async function post(
  date: string, type: JournalEntryType, lines: Array<[string, string | null, string | null]>, sourceType?: string
) {
  return createJournalEntry(
    f.entityId, utc(date), type, 'MNE-001-059',
    lines.map(([account_id, debit_amount, credit_amount]) => ({ account_id, debit_amount, credit_amount, description: 'x' })),
    f.userId,
    { autoPost: true, ...(sourceType ? { sourceType } : {}) }
  );
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-059 ISR provisional');
  await seedPolicies({ tenantId: f.tenantId });
  const sales = f.cuentas['4100'];
  const receivables = f.roles['cxc'];
  const bank = f.roles['banco'];
  const withheld = f.roles['isr_retenido_a_favor'];

  await post('2026-01-01', JournalEntryType.ADJUSTING, [[withheld, '500.00', null], [bank, null, '500.00']], 'opening_balance');
  const may = await post('2026-05-10', JournalEntryType.STANDARD, [[withheld, '100.00', null], [bank, null, '100.00']]);
  await reverseJournalEntry(may.id, f.userId, { reason: 'posted twice', reversalDate: utc('2026-06-10') });
  await post('2026-08-20', JournalEntryType.STANDARD, [[bank, '5000.00', null], [f.roles['anticipo_clientes'], null, '5000.00']]);

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
    expect(august.findings.map((h) => h.codigo)).toEqual(['ISR-WP-REGIME-UNDECLARED', 'ISR-WP-ADVANCES']);
    expect(august.advancesCollected).toEqual([{ code: '2150', amount: '5000.0000' }]);
    expect(august.figures).toEqual({
      nominalIncome: '1235802.4500',
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

  it('traces the nominal income to its revenue accounts, without the close, September or the returns', () => {
    expect(Object.fromEntries(august.incomeAccounts.map((a) => [a.code, a.amount]))).toEqual({
      '4100': '1234567.8900',
      '4310': '1234.5600',
    });
    expect(august.salesReturns).toMatchObject({ treatment: 'deduction', accounts: [{ code: '4400', amount: '-10000.0000' }] });
  });

  it('counts as withheld neither the opening balance nor a withholding reversed within the year', () => {
    expect(august.withholdingAccounts).toEqual([{ code: '1145', amount: '123.4500' }]);
  });

  it('adjusts every line to pesos by default (cada_renglon) and keeps the cents', () => {
    expect(august.rounding).toMatchObject({ key: 'declaracion_redondeo_a_pesos', value: 'cada_renglon' });
    expect(line('estimated_profit')).toMatchObject({ cents: '108132.71', whole: '108133' });
    expect(line('taxable_base')).toMatchObject({ cents: '65532.71', whole: '65533' });
    expect(line('tax_caused')).toMatchObject({ cents: '19659.81', whole: '19660' });
    expect(august.settlement?.resultCents).toBe('4535.96');
    expect(august.settlement?.resultWhole).toBe('4537');
  });

  it('nets the returns from the nominal income when the panel says so', async () => {
    const ctx = { tenantId: f.tenantId };
    await resolvePolicy(ctx, 'provisional_isr_sales_returns', 'net_of_income', 'MNE-001-059');
    try {
      const net = await buildProvisionalIncomeTaxWorkpaper({
        tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 8,
        ptuPaidInYear: '24000', priorProvisionalPayments: '15000.40',
      });
      expect(net.figures.nominalIncome).toBe('1225802.4500');
      expect(net.incomeAccounts.map((a) => a.code)).toContain('4400');
      expect(net.settlement).toMatchObject({ resultCents: '4273.46', resultWhole: '4274' });
    } finally {
      await reopenPolicy(ctx, 'provisional_isr_sales_returns');
    }
  });
});

describe('what the workpaper cannot vouch for, it does not settle', () => {
  it('January reads the 2024 return, which was never captured: no coefficient, no settlement', async () => {
    const jan = await buildProvisionalIncomeTaxWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 1 });
    expect(jan.blockedBy).toEqual(['ISR-WP-NO-COEFFICIENT']);
    expect(jan.settlement).toBeNull();
  });

  it('January does not apply the losses of the return before last: they still hold what last year amortized', async () => {
    const g = await crearInquilino('MNE-001-059 pérdidas viejas');
    await seedPolicies({ tenantId: g.tenantId });
    const scope = entityScope(g.tenantId, g.entityId);
    for (const kind of ['profit_coefficient', 'pending_tax_losses'] as const) {
      await recordIncomeTaxInput(scope, {
        kind, value: kind === 'profit_coefficient' ? '0.0875' : '30000.00', sourceFiscalYear: 2024,
        sourceFiledOn: '2025-03-20', sourceDocument: 'Declaración anual 2024, operación 000045',
        ...(kind === 'pending_tax_losses' ? { updatedThrough: '2025-12' } : {}),
      });
    }
    const jan = await buildProvisionalIncomeTaxWorkpaper({ tenantId: g.tenantId, entityId: g.entityId, year: 2026, month: 1 });
    expect(jan.coefficient?.sourceFiscalYear).toBe(2024);
    expect(jan.blockedBy).toEqual(['ISR-WP-LOSSES-STALE']);
    expect(jan.losses).toBeNull();
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
