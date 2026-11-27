import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { registerBillCommand } from '../../src/cli/bill-command.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearEntidadHermana, crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { VAT_OVERCREDIT_CORRECTION_SOURCE } from '../../src/services/accounting/iva-cash-basis.js';
import { createJournalEntry, drainAttestations, reverseJournalEntry } from '../../src/services/accounting/posting.js';
import { apReconcile } from '../../src/services/ap/ap-controls.js';
import { approveBill, createBill, voidBill } from '../../src/services/ap/bill-service.js';
import { recordVendorPayment, unapplyVendorPayment } from '../../src/services/payments/payment-service.js';
import { resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import { todayFor } from '../../src/services/policy/today.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';
import { JournalEntryType } from '../../src/types/index.js';

// ============================================================
// MNE-001-947 (#1079) · AN APPROVED BILL IS VOIDED BY ITS OWN DOOR.
//
// Hand figures, the issue's case: a bill of 10,000.00 + 1,600.00 = 11,600.00,
// dated 2026-08-15 and approved: DR 6100 10,000.00 · DR 1135 1,600.00 /
// CR 2110 11,600.00. Its mirror: DR 2110 11,600.00 / CR 6100 10,000.00 ·
// CR 1135 1,600.00. The inbox cases use the fixture PPD bill of 9,280.00
// (8,000.00 + 1,280.00) and the golden note of 2,320.00. Every party is
// synthetic.
// ============================================================

type Row = Record<string, unknown>;
const cfdi = (...file: string[]) => fs.readFileSync(path.join(__dirname, '..', ...file), 'utf8');
const VENDOR_RFC = 'SIN060101AB1';
const svc = new PreRegistrationService();
const REASON = 'The vendor cancelled the CFDI';
let f: Fixture;
let ctx: { tenantId: string; entityId: string };
let email: string;
let vendorId: string;

const rows = async <T extends Row = Row>(sql: string, params: unknown[]) => (await query<T>(sql, params)).rows;

/** The approved bill of 10,000.00 + 1,600.00 dated `date`, parked in 1135; in dollars when a rate is given. */
async function bill(date = '2026-08-15', usdRate?: string, draftOnly = false): Promise<{ id: string; number: string; entryId: string }> {
  const draft = await createBill({
    entity_id: f.entityId, vendor_id: vendorId, created_by: f.userId, bill_date: date, due_date: date,
    currency_code: usdRate ? 'USD' : 'MXN', vendor_invoice_number: `F-${uuidv4().slice(0, 8)}`,
    lines: [{ account_id: f.cuentas['6100'], unit_price: '10000.00', tax_amount: '1600.00' }],
  });
  if (usdRate) {
    await query(`UPDATE bills SET exchange_rate = $3 WHERE id = $1 AND entity_id = $2 AND status = 'draft'`, [draft.id, f.entityId, usdRate]);
  }
  if (draftOnly) return { id: draft.id, number: draft.bill_number, entryId: '' };
  const { entry } = await approveBill(draft.id, f.userId, { entityId: f.entityId });
  return { id: draft.id, number: draft.bill_number, entryId: entry!.id };
}

/** An account of the whole entity over posted entries, debit minus credit. */
const net = async (code: string) => (await rows<{ net: string }>(
  `SELECT COALESCE(SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)), 0)::text AS net
     FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id AND je.status = 'posted'
    WHERE je.entity_id = $1 AND l.account_id = $2`,
  [f.entityId, f.cuentas[code]]
))[0].net;
const billRow = async (id: string) => (await rows<{ status: string; due: string }>(
  `SELECT status, amount_due::text AS due FROM bills WHERE id = $1 AND entity_id = $2`, [id, f.entityId]
))[0];
const entries = async () => Number((await rows<{ n: string }>(
  `SELECT count(*)::text AS n FROM journal_entries WHERE entity_id = $1`, [f.entityId]))[0].n);
const reconciled = async () => {
  const r = await apReconcile(f.entityId);
  return { delta: r.diferencia, ties: r.cuadra };
};
const voided = (id: string, opts: { dryRun?: boolean } = {}) =>
  voidBill(id, f.userId, { entityId: f.entityId, reason: REASON, ...opts });
const refusedBy = (key: string): Row => ({ messageKey: expect.objectContaining({ key }) as unknown });
const flat = (lines: Array<{ account_code: string; debit_amount: string | null; credit_amount: string | null }>) =>
  lines.map((l) => `${l.account_code} ${l.debit_amount ?? '-'} ${l.credit_amount ?? '-'}`);

/** The real leaf `bill void`, answering yes to its question: what it printed, its exit code and its refusals. */
async function cli(...argv: string[]): Promise<{ out: string; exitCode?: number; errors: string[]; asked: string[] }> {
  const program = new Command('mnemosine').exitOverride();
  const seen = { out: '', exitCode: undefined as number | undefined, errors: [] as string[], asked: [] as string[] };
  const id = (text: string) => text;
  registerBillCommand(program, {
    palette: { dim: id, bold: id, cyan: id, red: id, green: id, yellow: id } as never,
    shutdown: (code: number) => { seen.exitCode = code; },
    reportError: (e: unknown) => { seen.errors.push(String((e as Error)?.message ?? e)); },
    confirm: (question: string) => { seen.asked.push(question); return Promise.resolve(true); },
  });
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { seen.out += String(chunk); return true; });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await program.parseAsync(['node', 'mnemosine', 'bill', 'void', ...argv, '--entity', f.entityId, '--tenant', f.tenantId]);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
  return seen;
}

/** The fixture PPD bill of 9,280.00 under a fresh UUID, posted from the inbox: status posted, 1,280.00 in 1135. */
async function inboxBill(): Promise<{ id: string; uuid: string }> {
  const uuid = uuidv4().toUpperCase();
  const xml = cfdi('fixtures', 'cfdi', 'factura-consultoria-2001.xml')
    .replace('F7C0E1A3-6D41-4C8F-B05E-314C5D6E7F80', uuid).replace('Folio="2001"', `Folio="${uuid.slice(0, 8)}"`);
  const up = await svc.processXMLUpload(f.entityId, xml, 'manual_upload', f.userId);
  return { id: ((await svc.processToAccounting(up.preRegistration, f.userId)).bill as { id: string }).id, uuid };
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-947 bill void');
  ctx = { tenantId: f.tenantId, entityId: f.entityId };
  email = (await rows<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [f.userId]))[0].email;
  await seedPolicies(ctx);
  await resolvePolicy(ctx, 'lineas_factura_desde', 'conceptos_cfdi', email);
  vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by, default_expense_account_id)
     VALUES ($1, $2, 'V-947', 'Servicios Integrales SA', $3, 'rfc', 'MXN', $4, $5)`,
    [vendorId, f.entityId, VENDOR_RFC, f.userId, f.cuentas['6100']]
  );
}, 180_000);

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('the defect and its cure: the entry reversed by hand leaves the bill open', () => {
  it('after `entry reverse` the bill still owes 11,600.00 and the subledger does not tie; `voidBill` closes it against that mirror', async () => {
    const b = await bill();
    const byHand = await reverseJournalEntry(b.entryId, f.userId, { reason: REASON });
    expect(await net('2110')).toBe('0.0000');
    expect(await net('1135')).toBe('0.0000');
    expect(await billRow(b.id)).toEqual({ status: 'approved', due: '11600.0000' });
    expect(await reconciled()).toEqual({ delta: '11600.00', ties: false });

    const before = await entries();
    const r = await voided(b.id);
    expect(r.mirror).toMatchObject({ id: byHand.id, posted: false });
    expect(r.attestation).toBeNull();
    expect(await entries()).toBe(before);
    expect(await billRow(b.id)).toEqual({ status: 'void', due: '0.0000' });
    expect(await reconciled()).toEqual({ delta: '0.00', ties: true });
  }, 90_000);
});

describe('void_date, the default: the mirror, the bill at void and the audit row', () => {
  it('--dry-run returns the mirror and writes nothing; the void posts it today, and 2110, 6100 and 1135 net to zero', async () => {
    const expense = await net('6100');
    const b = await bill();
    const before = await entries();
    const mirror = ['2110 11600.0000 -', '6100 - 10000.0000', '1135 - 1600.0000'];

    const dry = await voided(b.id, { dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(flat(dry.mirrorLines)).toEqual(mirror);
    expect(await entries()).toBe(before);
    expect(await billRow(b.id)).toEqual({ status: 'approved', due: '11600.0000' });

    const r = await voided(b.id);
    expect(flat(r.mirrorLines)).toEqual(mirror);
    expect(r.mirror).toMatchObject({ date: await todayFor(ctx), posted: true, datedBy: 'void_date' });
    expect(r.attestation).toEqual({ entityId: f.entityId, entryId: r.mirror!.id });
    expect(await entries()).toBe(before + 1);
    expect(await billRow(b.id)).toEqual({ status: 'void', due: '0.0000' });
    expect([await net('2110'), await net('1135'), await net('6100')]).toEqual(['0.0000', '0.0000', expense]);
    expect(await reconciled()).toEqual({ delta: '0.00', ties: true });
    const audit = await rows(
      `SELECT action, reason, old_values->>'status' AS was, new_values->>'reversal_entry_id' AS mirror
         FROM audit_log WHERE entity_type = 'bills' AND entity_id = $1 AND legal_entity_id = $2 AND action = 'void'`,
      [b.id, f.entityId]
    );
    expect(audit).toEqual([{ action: 'void', reason: REASON, was: 'approved', mirror: r.mirror!.id }]);

    await expect(voided(b.id)).rejects.toMatchObject(refusedBy('bill.void.not_voidable'));
  }, 90_000);

  it('a bill posted from the inbox (status posted) is voided the same way: its 1,280.00 leave 1135', async () => {
    const b = await inboxBill();
    expect((await billRow(b.id)).status).toBe('posted');
    expect(await net('1135')).toBe('1280.0000');
    await voided(b.id);
    expect(await billRow(b.id)).toEqual({ status: 'void', due: '0.0000' });
    expect([await net('2110'), await net('1135')]).toEqual(['0.0000', '0.0000']);

    // What the inbox keeps of its CFDI: registered against the void bill, and offered by no door again.
    const [pre] = await rows<{ status: string; bill_id: string; xml_document_id: string; xml_content: string }>(
      `SELECT p.status, p.bill_id, p.xml_document_id, x.xml_content FROM pre_registrations p
         JOIN xml_documents x ON x.id = p.xml_document_id WHERE p.entity_id = $1 AND upper(x.cfdi_uuid) = $2`,
      [f.entityId, b.uuid]
    );
    expect({ status: pre.status, bill: pre.bill_id }).toEqual({ status: 'completed', bill: b.id });
    await expect(svc.processXMLUpload(f.entityId, pre.xml_content, 'manual_upload', f.userId)).rejects.toThrow(/CFDI already exists/);
    expect(await svc.reprocessXmlDocument(f.entityId, pre.xml_document_id, f.userId)).toBeNull();
  }, 90_000);
});

describe('the leaf `bill void`, against the real service', () => {
  it('without --reason it is a usage error (exit 2) and nothing is written', async () => {
    const b = await bill();
    const r = await cli(b.number, '--yes');
    expect(r.exitCode).toBe(2);
    expect(await billRow(b.id)).toEqual({ status: 'approved', due: '11600.0000' });
    await voided(b.id); // the entity's accounts go back to zero for the cases that follow
  }, 90_000);

  it('--dry-run writes nothing; then it asks, voids, and the receipt names the mirror, its date and the key that dated it', async () => {
    const b = await bill();
    const before = await entries();
    const dry = await cli(b.number, '--reason', REASON, '--dry-run');
    expect(dry.exitCode).toBe(0);
    expect(dry.out).toMatch(/2110 .*11,600\.00\n6100 .*10,000\.00\n1135 .*1,600\.00\n/);
    expect(dry.out).toMatch(new RegExp(`Would void ${b.number} · mirror JE-\\S+ dated `));
    expect(dry.asked).toEqual([]);
    expect(await entries()).toBe(before);
    expect((await billRow(b.id)).status).toBe('approved');

    const today = await todayFor(ctx);
    const done = await cli(b.number, '--reason', REASON);
    expect(done.exitCode).toBe(0);
    expect(done.asked).toHaveLength(1);
    expect(done.asked[0]).toContain(`Void ${b.number} (11600.0000 MXN)`);
    expect(done.asked[0]).toContain(`The mirror of its entry is posted on ${today}. This cannot be undone.`);
    const [mirror] = await rows<{ entry_number: string }>(
      `SELECT entry_number FROM journal_entries WHERE entity_id = $1 AND reverses_entry_id = $2`, [f.entityId, b.entryId]);
    expect(done.out).toContain(`${b.number} voided · mirror ${mirror.entry_number} dated ${today} by bill_void_mirror_date = void_date`);
    expect(await billRow(b.id)).toEqual({ status: 'void', due: '0.0000' });
  }, 90_000);

  it('a draft goes to void with no mirror: nothing is posted, and the audit row keeps the reason', async () => {
    const b = await bill('2026-08-15', undefined, true);
    const before = await entries();
    const r = await cli(b.number, '--reason', 'Captured twice', '--yes', '--json');
    expect(r.exitCode).toBe(0);
    expect((JSON.parse(r.out) as { rows: unknown[] }).rows).toEqual([
      { bill: b.number, status: 'void', dry_run: false, mirror_entry: null, mirror_date: null, mirror_posted: false, dated_by: null, mirror_lines: [] },
    ]);
    expect(await entries()).toBe(before);
    expect(await billRow(b.id)).toEqual({ status: 'void', due: '0.0000' });
    expect(await rows(
      `SELECT reason, old_values->>'status' AS was FROM audit_log WHERE entity_type = 'bills' AND entity_id = $1 AND action = 'void'`, [b.id]
    )).toEqual([{ reason: 'Captured twice', was: 'draft' }]);
  }, 90_000);
});

describe('a bill in dollars', () => {
  it('11,600.00 USD at 18.50: the mirror crosses the origin too, and 2110 and 1135 are back at zero', async () => {
    // 10,000.00 x 18.50 = 185,000.00 · 1,600.00 x 18.50 = 29,600.00 · 11,600.00 x 18.50 = 214,600.00.
    const b = await bill('2026-08-15', '18.5');
    const r = await voided(b.id);
    expect(flat(r.mirrorLines)).toEqual(['2110 214600.0000 -', '6100 - 185000.0000', '1135 - 29600.0000']);
    const origin = await rows(
      `SELECT currency_code, foreign_debit::text AS debit, foreign_credit::text AS credit
         FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY line_number`, [r.mirror!.id]);
    expect(origin).toEqual([
      { currency_code: 'USD', debit: '11600.0000', credit: null },
      { currency_code: 'USD', debit: null, credit: '10000.0000' },
      { currency_code: 'USD', debit: null, credit: '1600.0000' },
    ]);
    expect(await billRow(b.id)).toEqual({ status: 'void', due: '0.0000' });
    expect([await net('2110'), await net('1135')]).toEqual(['0.0000', '0.0000']);
  }, 90_000);
});

describe('what is refused, and nothing is written', () => {
  it('a live payment application: the refusal names `payment unapply`; once unapplied, the bill is voided and 1135 and 1130 net to zero', async () => {
    const b = await bill();
    const paid = await recordVendorPayment(
      { entityId: f.entityId, counterpartyId: vendorId, paymentAmount: '11600.00', paymentDate: '2026-08-20',
        paymentMethod: 'spei', applications: [{ documentId: b.id, amountApplied: '11600.00' }] },
      f.userId
    );
    expect(await net('1130')).toBe('1600.0000');
    const before = await entries();
    const refusal = await voided(b.id).catch((e: Error) => e);
    expect(refusal).toMatchObject({ statusCode: 409, ...refusedBy('bill.void.settled') });
    expect((refusal as Error).message).toMatch(/1 payment application and no VAT over-credit correction .*`payment unapply <payment> --bill BILL-/);
    expect(await entries()).toBe(before);
    expect((await billRow(b.id)).status).toBe('paid');

    await unapplyVendorPayment(f.entityId, paid.paymentId, { billId: b.id, reason: 'The CFDI was cancelled' }, f.userId);
    await voided(b.id);
    expect(await billRow(b.id)).toEqual({ status: 'void', due: '0.0000' });
    expect([await net('2110'), await net('1135'), await net('1130')]).toEqual(['0.0000', '0.0000', '0.0000']);
  }, 90_000);

  it('a standing VAT over-credit correction on the bill: refused; once that entry is reversed, the bill is voided', async () => {
    const b = await bill();
    const line = (code: string, debit: string | null, credit: string | null) =>
      ({ account_id: f.cuentas[code], debit_amount: debit, credit_amount: credit, description: 'Excess VAT back to pending' });
    const correction = await createJournalEntry(
      f.entityId, '2026-08-31', JournalEntryType.ADJUSTING, 'VAT over-credit correction',
      [line('1135', '10.00', null), line('1130', null, '10.00')],
      f.userId, { sourceType: VAT_OVERCREDIT_CORRECTION_SOURCE, sourceId: b.id, autoPost: true }
    );
    await expect(voided(b.id)).rejects.toMatchObject(refusedBy('bill.void.settled'));
    expect((await billRow(b.id)).status).toBe('approved');
    await reverseJournalEntry(correction.id, f.userId, { reason: 'Posted on the wrong bill' });
    await voided(b.id);
    expect([await net('2110'), await net('1135'), await net('1130')]).toEqual(['0.0000', '0.0000', '0.0000']);
  }, 90_000);

  it('a live received credit note: refused, and the bill keeps what the note left owed', async () => {
    const b = await inboxBill();
    const noteUuid = uuidv4().toUpperCase();
    const note = await svc.processXMLUpload(f.entityId, cfdi('golden', 'cfdi', 'nota-credito-ppd.xml')
      .replace('55E5E5E5-0005-4E05-8E05-E5E5E5E5E005', noteUuid).replace('22B2B2B2-0002-4B02-8B02-B2B2B2B2B002', b.uuid)
      .replace('CON850101AB3', VENDOR_RFC).replace('Folio="501"', `Folio="${noteUuid.slice(0, 8)}"`).replaceAll('2026-08-20', '2026-09-10'),
      'manual_upload', f.userId);
    await svc.processToAccounting(note.preRegistration, f.userId);
    const before = await entries();
    const refusal = await voided(b.id).catch((e: Error) => e);
    expect(refusal).toMatchObject(refusedBy('bill.void.credit_note'));
    expect((refusal as Error).message).toContain(`a received credit note that still stands (${noteUuid}). Undoing a received credit note is not built yet`);
    expect(await entries()).toBe(before);
    expect(await billRow(b.id)).toEqual({ status: 'posted', due: '6960.0000' });
  }, 90_000);

  it('no reason; a bill of a sibling entity, which answers as a missing one; a bill born from the opening', async () => {
    const b = await bill();
    await expect(voidBill(b.id, f.userId, { entityId: f.entityId, reason: '  ' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const sibling = await crearEntidadHermana(f);
    await expect(voidBill(b.id, f.userId, { entityId: sibling.entityId, reason: REASON }))
      .rejects.toMatchObject({ statusCode: 404, code: 'RESOURCE_NOT_FOUND' });
    expect((await billRow(b.id)).status).toBe('approved');

    // An opening's entry is shared by every open document: 500.00 of it is this bill's.
    const opening = await createJournalEntry(
      f.entityId, '2026-01-01', JournalEntryType.STANDARD, 'Opening balance',
      [{ account_id: f.cuentas['3100'], debit_amount: '500.00', credit_amount: null, description: 'Opening' },
       { account_id: f.cuentas['2110'], debit_amount: null, credit_amount: '500.00', description: 'F-OPEN' }],
      f.userId, { sourceType: 'opening_balance', autoPost: true }
    );
    const openId = uuidv4();
    await query(
      `INSERT INTO bills (id, entity_id, bill_number, vendor_id, subtotal, total_amount, amount_due, currency_code,
                          bill_date, due_date, status, journal_entry_id, created_by)
       VALUES ($1, $2, 'BILL-OPEN-947', $3, 500, 500, 500, 'MXN', '2026-01-01', '2026-01-01', 'approved', $4, $5)`,
      [openId, f.entityId, vendorId, opening.id, f.userId]
    );
    await expect(voided(openId)).rejects.toMatchObject(refusedBy('bill.void.opening'));
    expect(await billRow(openId)).toEqual({ status: 'approved', due: '500.0000' });
  }, 120_000);
});

describe('bill_date: the mirror takes the day of the bill\'s entry, and a period that is not open follows cfdi_periodo_cerrado', () => {
  it('open period: dated 2026-08-15. Closed period: `preguntar` writes nothing; `periodo_actual` dates it today', async () => {
    await resolvePolicy(ctx, 'bill_void_mirror_date', 'bill_date', email);
    const open = await bill();
    expect((await voided(open.id)).mirror).toMatchObject({ date: '2026-08-15', posted: true, datedBy: 'bill_date' });

    const march = await bill('2026-03-10');
    const closed = await query(
      `UPDATE fiscal_periods SET status = 'hard_close' WHERE id = $1 AND entity_id = $2 AND status = 'open'`,
      [f.periodos[3], f.entityId]
    );
    expect(closed.rowCount).toBe(1);
    const before = await entries();
    const refusal = await voided(march.id).catch((e: Error) => e);
    expect(refusal).toMatchObject({ code: 'PERIOD_CLOSED', ...refusedBy('bill.void.closed_period') });
    expect((refusal as Error).message).toMatch(/dated 2026-03-10, .*pending define cfdi_periodo_cerrado periodo_actual/);
    expect(await entries()).toBe(before);
    expect(await billRow(march.id)).toEqual({ status: 'approved', due: '11600.0000' });

    await resolvePolicy(ctx, 'cfdi_periodo_cerrado', 'periodo_actual', email);
    expect((await voided(march.id)).mirror).toMatchObject({ date: await todayFor(ctx), posted: true, datedBy: 'closed_period' });
    expect(await billRow(march.id)).toEqual({ status: 'void', due: '0.0000' });
  }, 90_000);
});
