import { describe, it as vitestIt, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase, withTransaction, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { seedPolicies, resolvePolicy, reopenPolicy } from '../../src/services/policy/policy-service.js';
import { seedLegalParameters } from '../../src/services/jurisdiction/legal-parameters-seed.js';
import { cashLimitFinding, CASH_POLICY_KEY } from '../../src/services/ap/cash-deductibility.js';
import { recordVendorPayment } from '../../src/services/payments/payment-service.js';
import { registerBillCommand } from '../../src/cli/bill-command.js';
import { registerPaymentCommands } from '../../src/cli/payment-command.js';
import { apartarCatalogos } from './helpers/catalogos-globales.js';

/**
 * MNE-001-345 · LISR art. 27 fr. III outside the ingestion: a bill paid in cash
 * above the limit in force ON THE PAYMENT DATE is signalled at `bill approve`
 * (from its CFDI's FormaPago) and at the payment (`--method cash`). The limit
 * comes from legal_parameters, never from a constant; what to do with it is the
 * panel key `cash_over_limit_outside_ingestion`.
 */

apartarCatalogos('legal_parameters');

let f: Fixture;
let sister: Fixture;
let g: Fixture; // its own tenant: the policy answers of one test never leak into another
let us: Fixture; // US law, pesos as functional currency: only the jurisdiction guard can stop it
const DAY = '2026-08-15';
const LIMIT_KEY = 'income_tax.cash_payment_deduction_limit';

beforeAll(async () => {
  await seedLegalParameters();
  f = await crearInquilino('MNE-001-345');
  await seedPolicies({ tenantId: f.tenantId });
  sister = await crearEntidadHermana(f);
  g = await crearInquilino('MNE-001-345 policy');
  await seedPolicies({ tenantId: g.tenantId });
  us = await crearInquilino('MNE-001-345 US', { pais: 'US', moneda: 'MXN' });
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

async function draftBill(fx: Fixture, total: string, cfdiUuid: string | null = null, currency = 'MXN') {
  const billId = uuidv4();
  const vendorId = uuidv4();
  const tag = uuidv4().slice(0, 8);
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,'Proveedor 345','CCC030303CC3','rfc',$4,$5)`,
    [vendorId, fx.entityId, `V-${tag}`, currency, fx.userId]
  );
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, vendor_invoice_number, subtotal, tax_amount,
       total_amount, amount_due, amount_paid, currency_code, bill_date, due_date, status, created_by, cfdi_uuid)
     VALUES ($1,$2,$3,$4,$5,$6,0,$6,$6,0,$7,$8,$8,'draft',$9,$10)`,
    [billId, fx.entityId, `BILL-${tag}`, vendorId, `INV-${tag}`, total, currency, DAY, fx.userId, cfdiUuid]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Servicio',1,$4,$4,0,$4)`,
    [uuidv4(), billId, fx.cuentas['6100'], total]
  );
  return { billId, vendorId, billNumber: `BILL-${tag}` };
}

async function xmlWithPaymentForm(fx: Fixture, uuid: string, paymentForm: string, total: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO xml_documents (id, entity_id, document_type, cfdi_uuid, cfdi_version, cfdi_fecha,
       emisor_rfc, receptor_rfc, subtotal, total, moneda, forma_pago, metodo_pago,
       xml_content, xml_hash, import_source, processing_status)
     VALUES ($1,$2,'cfdi_ingreso',$3,'4.0',$4,'CCC030303CC3','XAXX010101000',$5,$5,'MXN',$6,'PUE',
       '<x/>',$3,'manual_upload','completed')`,
    [id, fx.entityId, uuid, DAY, total, paymentForm]
  );
  return id;
}

async function approvedBill(fx: Fixture, total: string) {
  const b = await draftBill(fx, total);
  await approveBill(b.billId, fx.userId, { entityId: fx.entityId });
  return b;
}

function pay(fx: Fixture, b: { billId: string; vendorId: string }, amount: string, method: string, date = DAY) {
  return recordVendorPayment(
    {
      entityId: fx.entityId, counterpartyId: b.vendorId, paymentAmount: amount, paymentDate: date,
      paymentMethod: method, applications: [{ documentId: b.billId, amountApplied: amount }],
    },
    fx.userId
  );
}

/** Runs the real commands and returns what they wrote. */
async function correr(fx: Fixture, argv: string[]): Promise<{ exitCode?: number; out: string; err: string }> {
  let exitCode: number | undefined;
  const out: string[] = [];
  const err: string[] = [];
  const stdoutOriginal = process.stdout.write.bind(process.stdout);
  const stderrOriginal = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    const p = new Command('mnemosine');
    const plain = {
      dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
      red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
    };
    const deps = {
      palette: plain,
      shutdown: (c: number) => { exitCode = c; },
      reportError: (e: unknown) => { err.push(`${(e as Error).message}\n`); },
    };
    registerBillCommand(p, deps);
    registerPaymentCommands(p, deps);
    try {
      const email = (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [fx.userId])).rows[0].email;
      await p.parseAsync(['node', 'mnemosine', ...argv, '-e', fx.entityId, '-t', fx.tenantId, '--user', email, '-y']);
    } catch (e) {
      err.push(`${(e as Error).message}\n`);
      exitCode = 1;
    }
  } finally {
    process.stdout.write = stdoutOriginal;
    process.stderr.write = stderrOriginal;
  }
  return { exitCode, out: out.join(''), err: err.join('') };
}

/** The firm's answer for the policy fixture's entity, replacing an earlier one. */
async function setCashPolicy(value: string): Promise<void> {
  const ctx = { tenantId: g.tenantId, entityId: g.entityId };
  await reopenPolicy(ctx, CASH_POLICY_KEY).catch(() => undefined);
  await resolvePolicy(ctx, CASH_POLICY_KEY, value, g.userId);
}

/** An `it` that enters the fixture's tenant inside the test's own async context (a hook's does not reach it). */
function inTenant(fx: () => Fixture) {
  return (name: string, fn: () => Promise<void>, timeout?: number) =>
    vitestIt(name, async () => { enterTenant(fx().tenantId); await fn(); }, timeout);
}

/** Moves the only MX vigencia to 2030, so no vigencia covers DAY; restores it. */
async function withoutVigencia<T>(run: () => Promise<T>): Promise<T> {
  await query(`UPDATE legal_parameters SET effective_from = '2030-01-01' WHERE jurisdiction = 'MX' AND key = $1`, [LIMIT_KEY]);
  try {
    return await run();
  } finally {
    await query(`UPDATE legal_parameters SET effective_from = '2014-01-01' WHERE jurisdiction = 'MX' AND key = $1 AND effective_from = '2030-01-01'`, [LIMIT_KEY]);
  }
}

describe('payment --method cash', () => {
  const it = inTenant(() => f);

  it('signals a cash payment above the limit in force on the payment date and leaves the entry alone', async () => {
    const b = await approvedBill(f, '2500.00');
    const r = await pay(f, b, '2500.00', 'cash');
    expect(r.deductibilityFindings).toHaveLength(1);
    expect(r.deductibilityFindings![0]).toMatchObject({
      code: 'cash_over_limit_deductibility_at_risk', amount: '2500.00', limit: '2000.00', onDate: DAY, source: 'vendor_payment',
    });
    expect(r.deductibilityFindings![0].message).toContain('LISR art. 27 fr. III');
    expect(r.journalEntry).not.toBeNull();
    // The audit trail carries the signal under its English key.
    const audit = await query<{ v: string[] | null }>(
      `SELECT new_values->'cash_over_limit_findings' AS v FROM audit_log
        WHERE entity_type = 'vendor_payments' AND entity_id = $1`,
      [r.paymentId]
    );
    expect(audit.rows[0].v).toEqual(['cash_over_limit_deductibility_at_risk']);
  });

  it('does not signal the limit itself, a smaller cash payment, or a transfer of any size', async () => {
    const exact = await pay(f, await approvedBill(f, '2000.00'), '2000.00', 'cash');
    expect(exact.deductibilityFindings, 'the law says exceeds: exactly the limit is deductible').toEqual([]);
    const spei = await pay(f, await approvedBill(f, '9000.00'), '9000.00', 'spei');
    expect(spei.deductibilityFindings).toEqual([]);
  });

  it('reads the limit by the PAYMENT date: a later vigencia changes the answer', async () => {
    await query(
      `INSERT INTO legal_parameters (jurisdiction, key, effective_from, value, unit, source_url, source_note)
       VALUES ('MX',$1,'2026-09-01','10000.0000','MXN','https://example.test/fixture','test vigencia')`,
      [LIMIT_KEY]
    );
    try {
      const later = await pay(f, await approvedBill(f, '5000.00'), '5000.00', 'cash', '2026-09-10');
      expect(later.deductibilityFindings, '5,000 is under the 2026-09 limit of 10,000').toEqual([]);
      const before = await pay(f, await approvedBill(f, '5000.00'), '5000.00', 'cash', DAY);
      expect(before.deductibilityFindings).toHaveLength(1);
    } finally {
      await query(`DELETE FROM legal_parameters WHERE key = $1 AND effective_from = '2026-09-01'`, [LIMIT_KEY]);
    }
  });

  it('a date with no vigencia is surfaced, not silent, and does not block the payment', async () => {
    const b = await approvedBill(f, '5000.00');
    const r = await withoutVigencia(() => pay(f, b, '5000.00', 'cash'));
    expect(r.deductibilityFindings).toHaveLength(1);
    expect(r.deductibilityFindings![0]).toMatchObject({ code: 'cash_limit_unavailable', limit: null });
    expect(r.paymentNumber).toBeTruthy();
  });

  it('judges a pure cash advance to a vendor (no applications) too', async () => {
    const b = await draftBill(f, '1.00');
    const r = await recordVendorPayment(
      { entityId: f.entityId, counterpartyId: b.vendorId, paymentAmount: '3000.00', paymentDate: DAY, paymentMethod: 'cash', applications: [], onAccount: true },
      f.userId
    );
    expect(r.documentos).toEqual([]);
    expect(r.deductibilityFindings).toHaveLength(1);
    expect(r.deductibilityFindings![0]).toMatchObject({ amount: '3000.00', limit: '2000.00' });
  });

  it('prints the finding in the CLI, in the dry run and in --json', async () => {
    const b = await approvedBill(f, '2600.00');
    const dry = await correr(f, ['payment', 'create', b.billNumber, '--amount', '2600.00', '--method', 'cash', '--dry-run']);
    expect(dry.exitCode ?? 0, dry.err).toBe(0);
    expect(dry.err).toContain('LISR art. 27 fr. III');
    const real = await correr(f, ['payment', 'create', b.billNumber, '--amount', '2600.00', '--method', 'cash', '--json']);
    expect(real.exitCode ?? 0, real.err).toBe(0);
    expect(real.err).toContain('LISR art. 27 fr. III');
    expect(real.out).toContain('deductibility_findings');
    expect(real.out).toContain('cash_over_limit_deductibility_at_risk');
  }, 60_000);
});

describe('bill approve', () => {
  const it = inTenant(() => f);

  it('signals a bill whose CFDI says cash (FormaPago 01) above the limit and says the CFDI declares it', async () => {
    const uuid = uuidv4();
    await xmlWithPaymentForm(f, uuid, '01', '4000.00');
    const b = await draftBill(f, '4000.00', uuid);
    const r = await approveBill(b.billId, f.userId, { entityId: f.entityId });
    expect(r.deductibilityFindings).toHaveLength(1);
    expect(r.deductibilityFindings[0]).toMatchObject({ amount: '4000.00', limit: '2000.00', onDate: DAY, source: 'bill_approve' });
    expect(r.deductibilityFindings[0].message).toContain('CFDI declares');
    expect(r.entry).not.toBeNull();
  });

  it('is silent for a transfer CFDI, for cash under the limit and for a bill with no CFDI', async () => {
    const t = uuidv4();
    await xmlWithPaymentForm(f, t, '03', '4000.00');
    const transfer = await approveBill((await draftBill(f, '4000.00', t)).billId, f.userId, { entityId: f.entityId });
    expect(transfer.deductibilityFindings).toEqual([]);
    const c = uuidv4();
    await xmlWithPaymentForm(f, c, '01', '1500.00');
    const small = await approveBill((await draftBill(f, '1500.00', c)).billId, f.userId, { entityId: f.entityId });
    expect(small.deductibilityFindings).toEqual([]);
    const none = await approveBill((await draftBill(f, '4000.00')).billId, f.userId, { entityId: f.entityId });
    expect(none.deductibilityFindings).toEqual([]);
  });

  it('does not judge an entity under US law, even for a peso bill with a cash CFDI', async () => {
    enterTenant(us.tenantId);
    const uuid = uuidv4();
    await xmlWithPaymentForm(us, uuid, '01', '4000.00');
    const b = await draftBill(us, '4000.00', uuid, 'MXN');
    const r = await approveBill(b.billId, us.userId, { entityId: us.entityId });
    expect(r.deductibilityFindings).toEqual([]);
  });

  it('does not judge a foreign-currency amount in a Mexican entity', async () => {
    const out = await withTransaction((client) =>
      cashLimitFinding(client, { entityId: f.entityId, billNumber: 'B-USD', amount: '5000.00', currency: 'USD', onDate: DAY, source: 'bill_approve' })
    );
    expect(out).toEqual([]);
  });

  it('does not read a cash CFDI of ANOTHER entity with the same UUID', async () => {
    const uuid = uuidv4();
    await xmlWithPaymentForm(sister, uuid, '01', '4000.00');
    const b = await draftBill(f, '4000.00', uuid);
    const r = await approveBill(b.billId, f.userId, { entityId: f.entityId });
    expect(r.deductibilityFindings).toEqual([]);
  });

  it('a bill the ingestion created is not judged again: its decision stands', async () => {
    const uuid = uuidv4();
    const xmlId = await xmlWithPaymentForm(f, uuid, '01', '4000.00');
    const b = await draftBill(f, '4000.00', uuid);
    await query(
      `INSERT INTO pre_registrations (id, entity_id, xml_document_id, source_type, document_type, document_date,
         subtotal, total_amount, lines, bill_id)
       VALUES ($1,$2,$3,'xml_cfdi','bill',$4,4000,4000,'[]'::jsonb,$5)`,
      [uuidv4(), f.entityId, xmlId, DAY, b.billId]
    );
    const r = await approveBill(b.billId, f.userId, { entityId: f.entityId });
    expect(r.deductibilityFindings).toEqual([]);
  });

  it('an approval with no vigencia degrades to a finding instead of failing after the posting', async () => {
    const uuid = uuidv4();
    await xmlWithPaymentForm(f, uuid, '01', '4000.00');
    const b = await draftBill(f, '4000.00', uuid);
    const r = await withoutVigencia(() => approveBill(b.billId, f.userId, { entityId: f.entityId }));
    expect(r.entry).not.toBeNull();
    expect(r.deductibilityFindings).toHaveLength(1);
    expect(r.deductibilityFindings[0].code).toBe('cash_limit_unavailable');
  });

  it('shows the finding BEFORE posting (dry run) and in --json, and writes nothing', async () => {
    const uuid = uuidv4();
    await xmlWithPaymentForm(f, uuid, '01', '4000.00');
    const b = await draftBill(f, '4000.00', uuid);
    const dry = await correr(f, ['bill', 'approve', b.billNumber, '--dry-run', '--json']);
    expect(dry.exitCode ?? 0, dry.err).toBe(0);
    expect(dry.err).toContain('LISR art. 27 fr. III');
    expect(dry.out).toContain('cash_over_limit_deductibility_at_risk');
    const status = await query<{ status: string }>('SELECT status FROM bills WHERE id = $1', [b.billId]);
    expect(status.rows[0].status).toBe('draft');
    const real = await correr(f, ['bill', 'approve', b.billNumber]);
    expect(real.exitCode ?? 0, real.err).toBe(0);
    expect(real.err).toContain('LISR art. 27 fr. III');
  }, 60_000);
});

describe('panel key cash_over_limit_outside_ingestion', () => {
  const it = inTenant(() => g);

  async function cashBill(total = '4000.00') {
    const uuid = uuidv4();
    await xmlWithPaymentForm(g, uuid, '01', total);
    return draftBill(g, total, uuid);
  }
  const draftsOf = (billId: string) =>
    query<{ id: string; payload: { lines: Array<{ account_code: string; debit?: number; credit?: number }> } }>(
      `SELECT id, payload FROM ai_drafts WHERE entity_id = $1 AND payload->>'reference' = $2`,
      [g.entityId, `cash27:${billId}`]
    );

  it('"ignore" says nothing; "signal" (the default) reports and proposes no draft', async () => {
    const def = await cashBill();
    const signalled = await approveBill(def.billId, g.userId, { entityId: g.entityId });
    expect(signalled.deductibilityFindings).toHaveLength(1);
    expect(signalled.deductibilityFindings[0].draftIds).toEqual([]);
    expect((await draftsOf(def.billId)).rows).toHaveLength(0);

    await setCashPolicy('ignore');
    const silent = await approveBill((await cashBill()).billId, g.userId, { entityId: g.entityId });
    expect(silent.deductibilityFindings).toEqual([]);
  });

  it('"draft_reclassification" proposes the non-deductible reclassification as a draft, once, and never in a dry run', async () => {
    await setCashPolicy('draft_reclassification');
    const b = await cashBill();
    const preview = await approveBill(b.billId, g.userId, { entityId: g.entityId, dryRun: true });
    expect(preview.deductibilityFindings).toHaveLength(1);
    expect(preview.deductibilityFindings[0].draftIds).toEqual([]);
    expect((await draftsOf(b.billId)).rows, 'a dry run writes nothing').toHaveLength(0);

    const real = await approveBill(b.billId, g.userId, { entityId: g.entityId });
    expect(real.deductibilityFindings[0].draftIds).toHaveLength(1);
    const drafts = (await draftsOf(b.billId)).rows;
    expect(drafts).toHaveLength(1);
    const debit = drafts[0].payload.lines.find((l) => l.debit);
    expect(debit).toMatchObject({ account_code: '6900', debit: 4000 });
    expect(drafts[0].payload.lines.find((l) => l.credit)).toMatchObject({ account_code: '6100', credit: 4000 });

    // The payment signals again, but the bill already has its open draft.
    const paid = await pay(g, b, '4000.00', 'cash');
    expect(paid.deductibilityFindings).toHaveLength(1);
    expect(paid.deductibilityFindings![0].draftIds).toEqual([]);
    expect((await draftsOf(b.billId)).rows).toHaveLength(1);
  });

  it('a payment of a bill the ingestion decided is left out', async () => {
    await setCashPolicy('signal');
    const uuid = uuidv4();
    const xmlId = await xmlWithPaymentForm(g, uuid, '01', '4000.00');
    const b = await draftBill(g, '4000.00', uuid);
    await query(
      `INSERT INTO pre_registrations (id, entity_id, xml_document_id, source_type, document_type, document_date,
         subtotal, total_amount, lines, bill_id)
       VALUES ($1,$2,$3,'xml_cfdi','bill',$4,4000,4000,'[]'::jsonb,$5)`,
      [uuidv4(), g.entityId, xmlId, DAY, b.billId]
    );
    await approveBill(b.billId, g.userId, { entityId: g.entityId });
    const r = await pay(g, b, '4000.00', 'cash');
    expect(r.deductibilityFindings).toEqual([]);
  });
});
