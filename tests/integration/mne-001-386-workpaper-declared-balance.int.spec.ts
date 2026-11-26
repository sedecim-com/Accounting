import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { entityScope, type EntityScope } from '../../src/database/scope.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { balancesInFavorBefore, recordFiledReturn, type FiledReturnFiling } from '../../src/services/fiscal/filed-returns.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';
import { generateFilingWorkpaper } from '../../src/services/fiscal/filing-workpaper.js';
import { workpaperRows } from '../../src/cli/filing-workpaper-command.js';
import { NotFoundError, ValidationError, type AppError, textIn } from '../../src/utils/errors.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';

// ============================================================
// MNE-001-386 · #308 — SEPTEMBER 2026 TAKES ITS PRIOR BALANCE FROM WHAT WAS
// DECLARED, AGAINST POSTGRES. All data synthetic; every figure by hand.
//
// Tenant A sells 10,000 at 16 % (PUE) in September: 1,600 IVA payable, the cap.
//   April  OP-SYN-0401  300 in favour, refund requested        → 0 (LIVA art. 6)
//   May    OP-SYN-0501  500 in favour, 200 compensated, 100 credited by
//                       October's OP-SYN-1001                   → 200
//   June   OP-SYN-0601  900 in favour, amended by OP-SYN-0602 to 800; August's
//                       original OP-SYN-0801 credited 400 of it, August's
//                       amendment OP-SYN-0802 restates 250      → 800 − 250 = 550
//   July   OP-SYN-0701  2,000 in favour; September's own OP-SYN-0901 credited
//                       1,000, which is the month being prepared → 2,000
//   available 0 + 200 + 550 + 2,000 = 2,750 > 1,600 payable (the mutant)
//   credited, oldest first: May 200 + June 550 + July 850 = 1,600; July keeps 1,150
//   result 1,600 − 1,600 = 0
//
// Tenant B: July 1,000 in favour and no sale in September: nothing to credit.
// ============================================================

let a: Fixture;
let b: Fixture;
let sa: EntityScope;
let september: IvaWorkpaper;

const iva = (x: Omit<FiledReturnFiling, 'obligation'>): FiledReturnFiling => ({ obligation: 'iva_monthly', ...x });
const credit = (sourceAcknowledgement: string, amount: string) => ({ sourceAcknowledgement, amount });
const paper = (f: Fixture, more: { priorBalanceInFavor?: string; priorBalanceReason?: string } = {}) =>
  buildIvaWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 9, ...more });

async function use(f: Fixture, kind: 'refund_request' | 'compensation', ack: string, amount: string, offset: string | null) {
  await query(
    `INSERT INTO tax_balance_uses (entity_id, obligation, kind, source_return_id, source_period, used_on, amount, reference, offset_period)
     SELECT entity_id, obligation, $2, id, period, '2026-07-17', $3, $4, $5::date
       FROM filed_tax_returns WHERE entity_id = $1 AND acknowledgement_number = $6`,
    [f.entityId, kind, amount, `REF-SYN-${ack}`, offset, ack]
  );
}

beforeAll(async () => {
  a = await crearInquilino('MNE-001-386 A');
  b = await crearInquilino('MNE-001-386 B');
  sa = entityScope(a.tenantId, a.entityId);
  await seedPolicies({ tenantId: a.tenantId });
  await seedPolicies({ tenantId: b.tenantId });

  const customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, 'C-386', 'Cliente Sintético SA', 'MXN', $3)`,
    [customerId, a.entityId, a.userId]
  );
  const draft = await createInvoice({
    entity_id: a.entityId, customer_id: customerId, invoice_date: '2026-09-05', due_date: '2026-09-05',
    currency_code: 'MXN', terms: 'PUE', created_by: a.userId,
    lines: [{ revenue_account_id: a.cuentas['4100'], description: 'Servicio', quantity: '1', unit_price: '10000', tax_rate: '16' }],
  });
  await issueInvoice(draft.id, a.userId, { entityId: a.entityId });

  for (const filing of [
    iva({ period: '2026-04', filedOn: '2026-05-14', acknowledgementNumber: 'OP-SYN-0401', balanceInFavor: '300.00' }),
    iva({ period: '2026-05', filedOn: '2026-06-14', acknowledgementNumber: 'OP-SYN-0501', balanceInFavor: '500.00' }),
    iva({ period: '2026-06', filedOn: '2026-07-14', acknowledgementNumber: 'OP-SYN-0601', balanceInFavor: '900.00' }),
    iva({ period: '2026-07', filedOn: '2026-08-14', acknowledgementNumber: 'OP-SYN-0701', balanceInFavor: '2000.00' }),
    iva({ period: '2026-08', filedOn: '2026-09-15', acknowledgementNumber: 'OP-SYN-0801', amountPayable: '600.00',
          credits: [credit('OP-SYN-0601', '400.00')] }),
    iva({ period: '2026-06', filedOn: '2026-09-20', acknowledgementNumber: 'OP-SYN-0602', balanceInFavor: '800.00',
          replacesAcknowledgement: 'OP-SYN-0601' }),
    // The credit names June's original: it still draws on June's chain, now 0602.
    iva({ period: '2026-08', filedOn: '2026-10-02', acknowledgementNumber: 'OP-SYN-0802', amountPayable: '750.00',
          replacesAcknowledgement: 'OP-SYN-0801', credits: [credit('OP-SYN-0601', '250.00')] }),
    iva({ period: '2026-09', filedOn: '2026-10-14', acknowledgementNumber: 'OP-SYN-0901', amountPayable: '600.00',
          credits: [credit('OP-SYN-0701', '1000.00')] }),
    iva({ period: '2026-10', filedOn: '2026-11-10', acknowledgementNumber: 'OP-SYN-1001', amountPayable: '50.00',
          credits: [credit('OP-SYN-0501', '100.00')] }),
  ]) {
    await recordFiledReturn(sa, filing);
  }
  await use(a, 'refund_request', 'OP-SYN-0401', '300.00', null);
  await use(a, 'compensation', 'OP-SYN-0501', '200.00', '2026-03-01');

  await recordFiledReturn(entityScope(b.tenantId, b.entityId),
    iva({ period: '2026-07', filedOn: '2026-08-14', acknowledgementNumber: 'OP-SYN-B-0701', balanceInFavor: '1000.00' }));

  september = await paper(a);
}, 240_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('the record says what each earlier balance still holds', () => {
  it('reads the chain in force, the credits of the returns in force but September\'s own, and the uses', async () => {
    const rows = await balancesInFavorBefore(sa, 'iva_monthly', '2026-09');
    expect(rows.map((r) => [r.acknowledgementNumber, r.balanceInFavor, r.credited, r.compensated, r.refundRequested]))
      .toEqual([
        ['OP-SYN-0401', '300.00', '0.00', '0.00', '300.00'],
        ['OP-SYN-0501', '500.00', '100.00', '200.00', '0.00'],
        ['OP-SYN-0602', '800.00', '250.00', '0.00', '0.00'],
        ['OP-SYN-0701', '2000.00', '0.00', '0.00', '0.00'],
      ]);
  });

  it('a foreign entity answers 404, never an empty list', async () => {
    await expect(balancesInFavorBefore(entityScope(b.tenantId, a.entityId), 'iva_monthly', '2026-09'))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('September credits up to its tax payable, oldest first (LIVA art. 6)', () => {
  it('2,750 available, 1,600 credited: May 200, June 550, July 850, and July keeps 1,150', () => {
    expect(september.priorBalance).toMatchObject({
      origin: 'filed_returns', reason: null, cap: '1600.00', available: '2750.00', proposed: '1600.00', credited: '1600.00',
    });
    expect(september.priorBalance.balances.map((x) => [x.acknowledgementNumber, x.available, x.creditedHere, x.remnant]))
      .toEqual([
        ['OP-SYN-0401', '0.00', '0.00', '0.00'],
        ['OP-SYN-0501', '200.00', '200.00', '0.00'],
        ['OP-SYN-0602', '550.00', '550.00', '0.00'],
        ['OP-SYN-0701', '2000.00', '850.00', '1150.00'],
      ]);
  });

  it('settles at 0 and never below: 1,600 − 1,600', () => {
    expect(september.blockedBy).toEqual([]);
    const line = september.settlement?.lines.find((l) => l.key === 'prior_balance_in_favor');
    expect(line).toMatchObject({ cents: '1600.00', whole: '1600' });
    expect(september.settlement).toMatchObject({ resultCents: '0.00', resultWhole: '0' });
  });

  it('warns once, for July, the balance credited for the first time (23/IVA/N)', () => {
    const first = september.findings.filter((h) => h.codigo === 'IVA-WP-PRIOR-BALANCE-FIRST-CREDIT');
    expect(first.map((h) => textIn(h.mensaje, 'es').match(/OP-SYN-\d+/)?.[0])).toEqual(['OP-SYN-0701']);
  });

  it('the paper traces the line to the returns it credits', async () => {
    const wp = await generateFilingWorkpaper({ tenantId: a.tenantId, entityId: a.entityId, year: 2026, month: 9, forms: ['iva'] });
    const line = wp.sections[0].lines.find((l) => l.key === 'prior_balance_in_favor')!;
    expect(line.source).toMatchObject({
      kind: 'filed_returns',
      returns: [
        { acknowledgementNumber: 'OP-SYN-0501', period: '2026-05', amount: '200.00' },
        { acknowledgementNumber: 'OP-SYN-0602', period: '2026-06', amount: '550.00' },
        { acknowledgementNumber: 'OP-SYN-0701', period: '2026-07', amount: '850.00' },
      ],
    });
    expect(wp.sections[0].inputs.prior_balance_in_favor).toMatchObject({ origin: 'filed_returns', value: '1600.0000' });
    expect(workpaperRows(wp).find((r) => r.line === 'iva.prior_balance_in_favor')?.source)
      .toBe('filed_returns(OP-SYN-0501 OP-SYN-0602 OP-SYN-0701)');
  });
});

describe('a person overrides the figure, with a reason', () => {
  it('1,000 instead of 1,600: captured, named, and 600 payable', async () => {
    const wp = await generateFilingWorkpaper({
      tenantId: a.tenantId, entityId: a.entityId, year: 2026, month: 9, forms: ['iva'],
      priorBalanceInFavor: '1000', priorBalanceReason: 'Se reserva el saldo de julio para devolución',
    });
    const s = wp.sections[0];
    expect(s.lines.find((l) => l.key === 'prior_balance_in_favor')?.source).toMatchObject({ kind: 'captured' });
    expect(s.inputs.prior_balance_in_favor).toMatchObject({ origin: 'override', reason: 'Se reserva el saldo de julio para devolución' });
    expect(s.resultWhole).toBe('600');
    expect(s.findings.find((h) => h.codigo === 'IVA-WP-PRIOR-BALANCE-OVERRIDE')?.mensaje).toMatch(/1600\.00/);
  });

  it('1,700 would make September a balance in favour: it blocks', async () => {
    const wp = await paper(a, { priorBalanceInFavor: '1700', priorBalanceReason: 'motivo' });
    expect(wp.blockedBy).toContain('IVA-WP-PRIOR-BALANCE-ABOVE-PAYABLE');
    expect(wp.settlement).toBeNull();
  });

  it('an amount without its reason is refused by key', async () => {
    const err = (await paper(a, { priorBalanceInFavor: '1000' }).catch((e: unknown) => e)) as AppError;
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.messageKey?.key).toBe('filing.workpaper.prior_balance_override_incomplete');
  });
});

describe('each tenant reads its own record', () => {
  it('B, with no tax payable, credits nothing and July\'s 1,000 carries forward', async () => {
    const wp = await paper(b);
    expect(wp.priorBalance).toMatchObject({ cap: '0.00', available: '1000.00', credited: '0.00' });
    expect(wp.priorBalance.balances.map((x) => [x.acknowledgementNumber, x.remnant])).toEqual([['OP-SYN-B-0701', '1000.00']]);
    expect(september.priorBalance.balances.map((x) => x.acknowledgementNumber)).not.toContain('OP-SYN-B-0701');
  });
});
