import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import {
  recordVendorPayment,
  applyVendorPayment,
  unapplyVendorPayment,
  reverseVendorPayment,
} from '../../src/services/payments/payment-service.js';
import { conciliarCheque } from '../../src/services/banking/treasury-posting.js';
import { buildIvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';
import { construirDiot } from '../../src/services/sat/diot/diot-service.js';

/**
 * MNE-001-508 (#700), part 1: the ledger of a cheque written to a vendor.
 *
 * The cheque's IVA stays in 1135 until the bank cashes it; `conciliarCheque`
 * moves it to 1130 dated the bank charge's day. Everything runs through the
 * services; only the bank charge is inserted. The second block is
 * MNE-001-559: the IVA paper and the DIOT credit the cheque in that month.
 */

let f: Fixture;
let bank: string;
const SIGNED = '2026-01-15';
const CASHED = '2026-03-10';

/** A Mexican entity of its own with one MXN account: the helpers below read both. */
async function entity(name: string): Promise<void> {
  f = await crearInquilino(name);
  await seedPolicies({ tenantId: f.tenantId });
  bank = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
     VALUES ($1,$2,'Cheques','Banco',$3,'MXN','checking')`,
    [bank, f.entityId, f.roles.banco]
  );
}

beforeAll(() => entity('MNE-001-508 vendor cheque'), 240_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

/** A PPD bill of 1,000.00 + 160.00, approved: its IVA is parked in 1135. */
async function bill(): Promise<{ billId: string; vendorId: string }> {
  const billId = uuidv4();
  const vendorId = uuidv4();
  const tag = uuidv4().slice(0, 8);
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,'Proveedor 508','CCC030303CC3','rfc','MXN',$4)`,
    [vendorId, f.entityId, `V-${tag}`, f.userId]
  );
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, vendor_invoice_number, subtotal, tax_amount,
       total_amount, amount_due, amount_paid, currency_code, bill_date, due_date, status, created_by, terms)
     VALUES ($1,$2,$3,$4,$5,1000,160,1160,1160,0,'MXN','2026-01-05','2026-01-05','draft',$6,'PPD')`,
    [billId, f.entityId, `BILL-${tag}`, vendorId, `CFDI-${tag}`, f.userId]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount,
       tax_rate, tipo_factor, valor_actos)
     VALUES ($1,$2,1,$3,'Servicio a credito',1,1000,1000,160,1160,16,'tasa',1000)`,
    [uuidv4(), billId, f.cuentas['6100']]
  );
  await approveBill(billId, f.userId, { entityId: f.entityId });
  return { billId, vendorId };
}

/** A payment of 1,160.00 signed on 2026-01-15: against the bill, or on account when none is given. */
async function pay(vendorId: string, method: string, billId?: string): Promise<string> {
  const r = await recordVendorPayment(
    {
      entityId: f.entityId, counterpartyId: vendorId, paymentAmount: '1160.00', paymentDate: SIGNED,
      paymentMethod: method, bankAccountId: bank,
      ...(method === 'check' ? { checkNumber: uuidv4().slice(0, 6) } : {}),
      ...(billId
        ? { applications: [{ documentId: billId, amountApplied: '1160.00' }] }
        : { applications: [], onAccount: true }),
    },
    f.userId
  );
  return r.paymentId;
}

/** The bank's charge of 2026-03-10, and the cashing recorded against it. */
async function cash(paymentId: string) {
  const tx = uuidv4();
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type, description, is_matched)
     VALUES ($1,$2,$3::date,-1160,'debit','cheque',false)`,
    [tx, bank, CASHED]
  );
  return conciliarCheque(f.entityId, paymentId, { transactionId: tx, userId: f.userId });
}

const IVA = ['1130', '1135'];

/** Lines of one entry on the two IVA accounts, as `code debit credit`. */
async function ivaLines(entryId: string | null | undefined): Promise<string[]> {
  const r = await query<{ l: string }>(
    `SELECT a.code || ' ' || COALESCE(l.debit_amount, 0)::numeric(19,2) || ' ' || COALESCE(l.credit_amount, 0)::numeric(19,2) AS l
       FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.journal_entry_id = $1 AND a.code = ANY($2) ORDER BY a.code`,
    [entryId, IVA]
  );
  return r.rows.map((x) => x.l);
}

/** What the bill's and the payment's posted entries leave in 1130 and 1135. */
async function ivaOf(billId: string, paymentId: string): Promise<Record<string, string>> {
  const r = await query<{ code: string; net: string }>(
    `SELECT a.code, SUM(COALESCE(l.debit_amount,0) - COALESCE(l.credit_amount,0))::text AS net
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE je.entity_id = $1 AND je.status = 'posted' AND a.code = ANY($4)
        AND (je.source_id = ANY($2::uuid[]) OR je.reverses_entry_id IN (
              SELECT id FROM journal_entries WHERE source_id = ANY($3::uuid[])))
      GROUP BY a.code`,
    [f.entityId, [billId, paymentId], [paymentId], IVA]
  );
  const out: Record<string, string> = { '1130': '0.00', '1135': '0.00' };
  for (const x of r.rows) out[x.code] = new Decimal(x.net).toFixed(2);
  return out;
}

async function stored(paymentId: string): Promise<(string | null)[]> {
  const r = await query<{ v: string | null }>(
    `SELECT iva_reclass_amount::text AS v FROM payment_applications
      WHERE payment_id = $1 AND unapplied_at IS NULL ORDER BY created_at`,
    [paymentId]
  );
  return r.rows.map((x) => x.v);
}

async function entryOf(paymentId: string, sourceType: string) {
  const r = await query<{ id: string; d: string; period: number }>(
    `SELECT je.id, to_char(je.entry_date, 'YYYY-MM-DD') AS d, p.period_number AS period
       FROM journal_entries je JOIN fiscal_periods p ON p.id = je.fiscal_period_id
      WHERE je.entity_id = $1 AND je.source_id = $2 AND je.source_type = $3
      ORDER BY je.created_at DESC LIMIT 1`,
    [f.entityId, paymentId, sourceType]
  );
  return r.rows[0];
}

describe('a cheque to a vendor credits its IVA the day the bank cashes it', () => {
  it('T2 · the payment entry holds the IVA in 1135 and the cashing moves it on 2026-03-10', async () => {
    const { billId, vendorId } = await bill();
    const paymentId = await pay(vendorId, 'check', billId);

    expect(await ivaLines((await entryOf(paymentId, 'vendor_payment')).id)).toEqual([]);
    expect(await stored(paymentId)).toEqual(['0.0000']);
    expect(await ivaOf(billId, paymentId)).toEqual({ '1130': '0.00', '1135': '160.00' });

    const r = await cash(paymentId);
    expect(r.reclasificado).toBe('160.0000');
    const cashing = await entryOf(paymentId, 'bank_check_clearing');
    expect({ d: cashing.d, period: cashing.period }).toEqual({ d: CASHED, period: 3 });
    expect(await ivaLines(cashing.id)).toEqual(['1130 160.00 0.00', '1135 0.00 160.00']);
    expect(await stored(paymentId)).toEqual(['160.0000']);
    expect(await ivaOf(billId, paymentId), '1135 is empty and 1130 holds the IVA once').toEqual({ '1130': '160.00', '1135': '0.00' });
  }, 120_000);

  it('T3 · by spei the payment entry credits the IVA on its own day, as before', async () => {
    const { billId, vendorId } = await bill();
    const paymentId = await pay(vendorId, 'spei', billId);
    const entry = await entryOf(paymentId, 'vendor_payment');
    const all = await query<{ l: string }>(
      `SELECT a.code || ' ' || COALESCE(l.debit_amount, 0)::numeric(19,2) || ' ' || COALESCE(l.credit_amount, 0)::numeric(19,2) AS l
         FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
        WHERE l.journal_entry_id = $1 ORDER BY a.code`,
      [entry.id]
    );
    const bankCode = (await query<{ code: string }>(`SELECT code FROM accounts WHERE id = $1`, [f.roles.banco])).rows[0].code;
    expect(entry.d).toBe(SIGNED);
    expect(all.rows.map((x) => x.l).sort()).toEqual(
      [`${bankCode} 0.00 1160.00`, '1130 160.00 0.00', '1135 0.00 160.00', '2110 1160.00 0.00'].sort()
    );
    expect(await stored(paymentId)).toEqual(['160.0000']);
  }, 120_000);

  it('T4 · an advance by cheque applied before its cashing waits for it; applied after, it credits as before', async () => {
    const before = await bill();
    const held = await pay(before.vendorId, 'check');
    const applied = await applyVendorPayment(f.entityId, held, [{ documentId: before.billId, amountApplied: '1160.00' }], f.userId);
    expect(await ivaLines(applied.journalEntry?.id)).toEqual([]);
    expect(await stored(held)).toEqual(['0.0000']);
    expect(await ivaOf(before.billId, held)).toEqual({ '1130': '0.00', '1135': '160.00' });
    expect((await cash(held)).reclasificado).toBe('160.0000');
    expect(await ivaOf(before.billId, held)).toEqual({ '1130': '160.00', '1135': '0.00' });

    const after = await bill();
    const cashedFirst = await pay(after.vendorId, 'check');
    const r = await cash(cashedFirst);
    expect({ moved: r.reclasificado, entry: r.entryId }).toEqual({ moved: '0.0000', entry: null });
    const late = await applyVendorPayment(f.entityId, cashedFirst, [{ documentId: after.billId, amountApplied: '1160.00' }], f.userId);
    expect(await ivaLines(late.journalEntry?.id)).toEqual(['1130 160.00 0.00', '1135 0.00 160.00']);
    expect(await stored(cashedFirst)).toEqual(['160.0000']);
  }, 120_000);

  it('T5 · an unapply re-parks nothing before the cashing and 160.00 after it', async () => {
    const { billId, vendorId } = await bill();
    const paymentId = await pay(vendorId, 'check');
    const apply = () => applyVendorPayment(f.entityId, paymentId, [{ documentId: billId, amountApplied: '1160.00' }], f.userId);
    const unapply = () => unapplyVendorPayment(f.entityId, paymentId, { billId, reason: 'Gasto equivocado' }, f.userId);

    await apply();
    expect(await ivaLines((await unapply()).journalEntry.id)).toEqual([]);

    await apply();
    await cash(paymentId);
    expect(await ivaLines((await unapply()).journalEntry.id)).toEqual(['1130 0.00 160.00', '1135 160.00 0.00']);
    expect(await ivaOf(billId, paymentId)).toEqual({ '1130': '0.00', '1135': '160.00' });
  }, 120_000);

  it('T6 · a cheque whose own entry already credited the IVA records its cashing and moves nothing', async () => {
    const { billId, vendorId } = await bill();
    // Posted the way every cheque was before this task: the entry of a transfer.
    const paymentId = await pay(vendorId, 'spei', billId);
    await query(`UPDATE vendor_payments SET payment_method = 'check', check_number = 'OLD-1' WHERE id = $1`, [paymentId]);

    const r = await cash(paymentId);
    expect(await ivaOf(billId, paymentId), 'never credited twice').toEqual({ '1130': '160.00', '1135': '0.00' });
    expect({ moved: r.reclasificado, entry: r.entryId }).toEqual({ moved: '0.0000', entry: null });
    expect(r.nota).toMatch(/ya lo acreditó/);
    const row = await query<{ d: string }>(
      `SELECT check_cleared_date::text AS d FROM vendor_payments WHERE id = $1`, [paymentId]
    );
    expect(row.rows[0].d).toBe(CASHED);
  }, 120_000);

  it('T7 · a cashed cheque reversed mirrors the cashing entry too, and not before its cashing', async () => {
    const { billId, vendorId } = await bill();
    const paymentId = await pay(vendorId, 'check', billId);
    await cash(paymentId);

    await expect(
      reverseVendorPayment(f.entityId, paymentId, { reason: 'x', date: '2026-03-09' }, f.userId)
    ).rejects.toThrow(/2026-03-10/);

    const r = await reverseVendorPayment(f.entityId, paymentId, { reason: 'Cheque devuelto' }, f.userId);
    expect(r.reversals).toHaveLength(2);
    const open = await query<{ t: string }>(
      `SELECT source_type AS t FROM journal_entries
        WHERE entity_id = $1 AND source_id = $2 AND reversed_by_entry_id IS NULL
          AND source_type IN ('vendor_payment', 'bank_check_clearing')`,
      [f.entityId, paymentId]
    );
    expect(open.rows, 'every entry of the payment has its mirror').toEqual([]);
    expect(await ivaOf(billId, paymentId)).toEqual({ '1130': '0.00', '1135': '160.00' });
  }, 120_000);

  it('T8 · of two concurrent cashings of one cheque, one is written and the other fails', async () => {
    const { billId, vendorId } = await bill();
    const paymentId = await pay(vendorId, 'check', billId);
    const done = await Promise.allSettled([cash(paymentId), cash(paymentId)]);
    expect(done.map((d) => d.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await ivaOf(billId, paymentId)).toEqual({ '1130': '160.00', '1135': '0.00' });
  }, 120_000);
});

describe('the IVA paper and the DIOT credit a vendor cheque in the month the bank cashes it (MNE-001-559)', () => {
  // The paper's tie-out reads the whole entity's 1130, so these cases get their own.
  beforeAll(() => entity('MNE-001-559 vendor cheque paper'), 240_000);

  /** What one month's paper and DIOT say of one bill. */
  async function month(m: number, billId: string) {
    const scope = { tenantId: f.tenantId, entityId: f.entityId };
    const wp = await buildIvaWorkpaper({ ...scope, year: 2026, month: m });
    const diot = await construirDiot({ ...scope, anio: 2026, mes: m });
    const inPaper = wp.contributions.creditable.find((c) => c.documentId === billId);
    const inDiot = diot.renglones.flatMap((r) => r.documentos).find((d) => d.billId === billId);
    const of = (code: string) => (list: typeof wp.findings) => list.filter((h) => h.codigo === code && h.documentId === billId);
    return {
      paper: inPaper ? `${inPaper.breakdown.tasa16.base} / ${inPaper.breakdown.tasa16.iva}` : null,
      entries: inPaper?.entryIds ?? [],
      diot: inDiot ? `${inDiot.desglose.tasa16.base} / ${inDiot.desglose.tasa16.iva}` : null,
      tieOut: wp.findings.filter((h) => h.codigo === 'IVA-WP-CREDITABLE-VS-LEDGER').map((h) => h.mensaje),
      settles: wp.settlement !== null,
      notCashed: { paper: of('DIOT-CHEQUE-NOT-CASHED')(wp.findings), diot: of('DIOT-CHEQUE-NOT-CASHED')(diot.hallazgos) },
      early: { paper: of('DIOT-CHEQUE-CREDITED-BEFORE-CASHING')(wp.findings), diot: of('DIOT-CHEQUE-CREDITED-BEFORE-CASHING')(diot.hallazgos) },
    };
  }
  const NOTHING = { paper: null, diot: null };
  const CREDITED = { paper: '1000.0000 / 160.0000', diot: '1000.0000 / 160.0000' };
  const figures = (x: { paper: string | null; diot: string | null }) => ({ paper: x.paper, diot: x.diot });

  it('T9 · January credits nothing for the cheque and March credits 1,000.00 / 160.00, traced to the cashing entry', async () => {
    const { billId, vendorId } = await bill();
    const paymentId = await pay(vendorId, 'check', billId);
    await cash(paymentId);

    const january = await month(1, billId);
    expect(figures(january)).toEqual(NOTHING);
    expect(january.tieOut).toEqual([]);

    const march = await month(3, billId);
    expect(figures(march)).toEqual(CREDITED);
    expect(march.entries).toEqual([(await entryOf(paymentId, 'bank_check_clearing')).id]);
    expect(march.tieOut).toEqual([]);
    expect([january.notCashed, january.early, march.notCashed, march.early].flatMap((x) => [...x.paper, ...x.diot])).toEqual([]);
  }, 120_000);

  it('T10 · a cheque nobody cashed is credited in no month, and each month warns and settles', async () => {
    const { billId, vendorId } = await bill();
    const paymentId = await pay(vendorId, 'check', billId);
    const row = await query<{ n: string }>(`SELECT check_number AS n FROM vendor_payments WHERE id = $1`, [paymentId]);

    for (const m of [1, 2, 3]) {
      const r = await month(m, billId);
      expect(figures(r), `month ${m}`).toEqual(NOTHING);
      expect(r.settles, `month ${m} settles`).toBe(true);
      for (const list of [r.notCashed.paper, r.notCashed.diot]) {
        expect(list.map((h) => h.severidad)).toEqual(['aviso']);
        expect(list[0].mensaje).toContain(row.rows[0].n);
        expect(list[0].mensaje).toContain(SIGNED);
        expect(list[0].mensaje).toContain('160.00');
      }
    }
  }, 120_000);

  it('T11 · a cheque its own entry credited keeps January, which names March and the amended return', async () => {
    const { billId, vendorId } = await bill();
    // Posted the way every cheque was before MNE-001-508: the entry of a transfer.
    const paymentId = await pay(vendorId, 'spei', billId);
    await query(`UPDATE vendor_payments SET payment_method = 'check', check_number = 'OLD-9' WHERE id = $1`, [paymentId]);

    const uncashed = await month(1, billId);
    expect(figures(uncashed)).toEqual(CREDITED);
    expect([...uncashed.notCashed.paper, ...uncashed.early.paper], 'credited by its entry and not cashed: nothing to say').toEqual([]);

    await cash(paymentId);
    const january = await month(1, billId);
    expect(figures(january)).toEqual(CREDITED);
    expect(january.settles).toBe(true);
    for (const list of [january.early.paper, january.early.diot]) {
      expect(list.map((h) => h.severidad)).toEqual(['aviso']);
      expect(list[0].mensaje).toContain('OLD-9');
      expect(list[0].mensaje).toContain(CASHED);
      expect(list[0].mensaje).toMatch(/complementaria/);
    }
    const march = await month(3, billId);
    expect(figures(march)).toEqual(NOTHING);
    expect([...march.early.paper, ...march.early.diot]).toEqual([]);
    expect([january.tieOut, march.tieOut]).toEqual([[], []]);
  }, 120_000);
});
