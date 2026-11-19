import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { Command } from 'commander';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';
import { resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import { applyVendorPayment, recordVendorPayment } from '../../src/services/payments/payment-service.js';
import { apReconcile } from '../../src/services/ap/ap-controls.js';
import { construirDiot } from '../../src/services/sat/diot/index.js';
import { buildIvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';
import { registerBillCommand } from '../../src/cli/bill-command.js';

// ============================================================
// MNE-001-555 (#692, part 2/3) · `bill inbox run` POSTS A RECEIVED CREDIT NOTE
//
// The bill is the fixture PPD of 9,280.00 (8,000.00 + 1,280.00) posted from
// the inbox, so its VAT is parked in 1135. The note is the golden one of
// 2,320.00 (2,000.00 + 320.00), rewritten onto that bill and its vendor.
// Each test builds its own bill; T10 and T2 go on from T1's.
// ============================================================

const cfdi = (...file: string[]) => fs.readFileSync(path.join(__dirname, '..', ...file), 'utf8');
const BILL = cfdi('fixtures', 'cfdi', 'factura-consultoria-2001.xml');
const NOTE = cfdi('golden', 'cfdi', 'nota-credito-ppd.xml');
const VENDOR_RFC = 'SIN060101AB1';
const CONCEPT_VAT = '<cfdi:Traslado Base="8000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="1280.00"/>';
const svc = new PreRegistrationService();
type Edit = (xml: string) => string;
type Row = Record<string, unknown>;
interface Entry extends Row { id: string; source_type: string; source_id: string; day: string; lines: string[] }

let f: Fixture;
let email: string;
let vendorId: string;
let first: { id: string; uuid: string };
let firstNote: { uuid: string; pre: Row };

const rows = async <T extends Row = Row>(sql: string, params: unknown[]) => (await query<T>(sql, params)).rows;
const upload = (xml: string) => svc.processXMLUpload(f.entityId, xml, 'manual_upload', f.userId);
const post = (n: { pre: Row }) => svc.processToAccounting(n.pre, f.userId);
const policy = (key: string, value: string) => resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, key, value, email);

/** The fixture bill under a fresh UUID, posted from the inbox. */
async function bill(edit: Edit = (x) => x): Promise<{ id: string; uuid: string }> {
  const uuid = uuidv4().toUpperCase();
  const up = await upload(edit(BILL.replace('F7C0E1A3-6D41-4C8F-B05E-314C5D6E7F80', uuid).replace('Folio="2001"', `Folio="${uuid.slice(0, 8)}"`)
    // The DIOT splits by rate from the concept's own VAT; the fixture states it only in the summary node.
    .replace('ObjetoImp="02"/>', `ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados>${CONCEPT_VAT}</cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto>`)));
  return { id: ((await post({ pre: up.preRegistration })).bill as { id: string }).id, uuid };
}

/** The golden note from the bill's vendor, naming `billUuid`, dated 2026-09-10 and uploaded. */
async function note(billUuid: string, edit: Edit = (x) => x) {
  const uuid = uuidv4().toUpperCase();
  const up = await upload(edit(NOTE.replace('55E5E5E5-0005-4E05-8E05-E5E5E5E5E005', uuid).replace('22B2B2B2-0002-4B02-8B02-B2B2B2B2B002', billUuid)
    .replace('CON850101AB3', VENDOR_RFC).replace('Folio="501"', `Folio="${uuid.slice(0, 8)}"`).replaceAll('2026-08-20', '2026-09-10')));
  return { uuid, pre: up.preRegistration, autoProcessed: up.autoProcessed };
}

/** The posted entries with this reference or id, each with its lines as `code debit/credit`. */
const entriesOf = (referenceOrId: string) => rows<Entry>(
  `SELECT je.id, je.source_type, je.source_id::text, to_char(je.entry_date, 'YYYY-MM-DD') AS day,
          (SELECT array_agg(a.code || ' ' || COALESCE(l.debit_amount, 0)::text || '/' || COALESCE(l.credit_amount, 0)::text ORDER BY a.code)
             FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id WHERE l.journal_entry_id = je.id) AS lines
     FROM journal_entries je
    WHERE je.entity_id = $1 AND je.status = 'posted' AND $2 IN (je.reference, je.id::text)`,
  [f.entityId, referenceOrId]
);
const linesOf = async (noteUuid: string) => (await entriesOf(noteUuid))[0].lines;
const balanceOf = async (billId: string) =>
  (await rows(`SELECT status, amount_due::text AS due, amount_paid::text AS paid FROM bills WHERE id = $1`, [billId]))[0];
/** What the whole entity has in 1135: zero once every bill so far is settled. */
const parked = async () => (await rows<{ net: string }>(
  `SELECT COALESCE(SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)), 0)::numeric(19,2)::text AS net
     FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id AND je.status = 'posted'
    WHERE je.entity_id = $1 AND l.account_id = $2`,
  [f.entityId, f.cuentas['1135']]
))[0].net;

/** The VAT lines of a vendor payment applied to the bill; with `onAccount`, of its application afterwards. */
async function pay(billId: string, amount: string, date: string, onAccount = false, discountAmount = '0'): Promise<string[]> {
  const applications = [{ documentId: billId, amountApplied: amount, discountAmount }];
  const paid = await recordVendorPayment(
    { entityId: f.entityId, counterpartyId: vendorId, paymentAmount: amount, paymentDate: date, paymentMethod: 'spei',
      ...(onAccount ? { applications: [], onAccount: true } : { applications }) },
    f.userId
  );
  const entry = onAccount ? (await applyVendorPayment(f.entityId, paid.paymentId, applications, f.userId)).journalEntry : paid.journalEntry;
  return (await entriesOf(entry!.id))[0].lines.filter((line) => /^113[05] /.test(line));
}

/** `mnemosine bill inbox run <id> --yes`, as the terminal runs it: its exit code. */
async function inboxRun(id: string): Promise<number | undefined> {
  let exitCode: number | undefined;
  const same = (s: string) => s;
  const program = new Command('mnemosine').exitOverride();
  registerBillCommand(program, {
    palette: { dim: same, bold: same, cyan: same, red: same, green: same, yellow: same } as never,
    shutdown: (code: number) => { exitCode = code; }, reportError: () => undefined, confirm: () => Promise.resolve(true),
  });
  await program.parseAsync(['node', 'mnemosine', 'bill', 'inbox', 'run', id, '--yes', '--entity', f.entityId, '--tenant', f.tenantId, '--user', email]);
  return exitCode;
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-555 received credit note');
  email = (await rows<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [f.userId]))[0].email;
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  await policy('lineas_factura_desde', 'conceptos_cfdi');
  vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by, default_expense_account_id)
     VALUES ($1, $2, 'V-555', 'Servicios Integrales SA', $3, 'rfc', 'MXN', $4, $5)`,
    [vendorId, f.entityId, VENDOR_RFC, f.userId, f.cuentas['6100']]
  );
}, 180_000);

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('the note of a PPD bill whose VAT is parked', () => {
  it('T1 · `bill inbox run` posts it on its own date against the bill, which owes 6,960.00; `ap reconcile` ties', async () => {
    first = await bill();
    firstNote = await note(first.uuid);
    expect(await inboxRun(String(firstNote.pre.id))).toBe(0);
    expect(await entriesOf(firstNote.uuid)).toEqual([expect.objectContaining({
      source_type: 'vendor_credit_note', source_id: first.id, day: '2026-09-10',
      lines: ['1135 0/320.0000', '2110 2320.0000/0', '6100 0/2000.0000'],
    })]);
    expect(await balanceOf(first.id)).toEqual({ status: 'posted', due: '6960.0000', paid: '0.0000' });
    expect(await rows(`SELECT status, bill_id, journal_entry_id IS NOT NULL AS entry FROM pre_registrations WHERE id = $1`, [firstNote.pre.id]))
      .toEqual([{ status: 'completed', bill_id: null, entry: true }]);
    expect(await apReconcile(f.entityId)).toMatchObject({ cuadra: true, partidas: [] });
  }, 90_000);

  it('T10 · run again, the same note returns its entry: one entry, and the balance dropped once', async () => {
    const [entry] = await entriesOf(firstNote.uuid);
    expect((await post(firstNote)).journalEntry).toMatchObject({ id: entry.id });
    expect(await entriesOf(firstNote.uuid)).toHaveLength(1);
    expect(await balanceOf(first.id)).toMatchObject({ due: '6960.0000' });
  });

  it('T2 · 6,960.00 paid on 2026-09-30 releases 960.00; the bill is paid, the DIOT declares 6,000.00 and 960.00', async () => {
    expect(await pay(first.id, '6960.00', '2026-09-30')).toEqual(['1130 960.0000/0', '1135 0/960.0000']);
    expect(await balanceOf(first.id)).toEqual({ status: 'paid', due: '0.0000', paid: '6960.0000' });
    expect(await parked()).toBe('0.00');
    const diot = await construirDiot({ tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: 9 });
    const declared = diot.renglones.flatMap((r) => r.documentos).find((d) => d.billId === first.id);
    expect(declared?.desglose.tasa16).toMatchObject({ base: '6000.0000', iva: '960.0000' });
    const september = await buildIvaWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 9 });
    expect(september.findings.map((h) => h.codigo)).not.toContain('IVA-WP-CREDITABLE-VS-LEDGER');
  }, 90_000);

  it('T3 · after 4,640.00 paid on 2026-08-31 the note still takes 320.00 from 1135, and a last 2,320.00 releases 320.00', async () => {
    const b = await bill();
    await pay(b.id, '4640.00', '2026-08-31');
    const n = await note(b.uuid);
    await post(n);
    expect(await linesOf(n.uuid)).toContain('1135 0/320.0000');
    expect(await pay(b.id, '2320.00', '2026-09-30')).toEqual(['1130 320.0000/0', '1135 0/320.0000']);
    expect(await parked()).toBe('0.00');
  }, 90_000);

  it('a note with a cent more VAT than the bill still has parked takes that cent from 1130, and 1135 never goes below zero', async () => {
    const b = await bill();
    await pay(b.id, '6960.00', '2026-08-31');
    const n = await note(b.uuid, (x) => x.replaceAll('2000.00', '1999.99').replaceAll('"320.00"', '"320.01"'));
    await post(n);
    expect(await linesOf(n.uuid)).toEqual(['1130 0/0.0100', '1135 0/320.0000', '2110 2320.0000/0', '6100 0/1999.9900']);
    expect(await parked()).toBe('0.00');
  }, 90_000);

  it.each([false, true])('T9 · a note with 319.99 of VAT: the last 6,960.00 releases 960.01 and 1135 ends at zero (on account: %s)', async (onAccount) => {
    const b = await bill();
    const n = await note(b.uuid, (x) => x.replaceAll('2000.00', '2000.01').replaceAll('"320.00"', '"319.99"'));
    await post(n);
    expect(await linesOf(n.uuid)).toEqual(['1135 0/319.9900', '2110 2320.0000/0', '6100 0/2000.0100']);
    expect(await pay(b.id, '6960.00', '2026-09-30', onAccount)).toEqual(['1130 960.0100/0', '1135 0/960.0100']);
    expect(await parked()).toBe('0.00');
  }, 90_000);

  it('a note for the whole balance leaves the bill paid with nothing paid; a last payment with a discount keeps its pro rata', async () => {
    const whole = await bill();
    await post(await note(whole.uuid, (x) => x.replaceAll('2320.00', '9280.00').replaceAll('2000.00', '8000.00').replaceAll('"320.00"', '"1280.00"')));
    expect(await balanceOf(whole.id)).toEqual({ status: 'paid', due: '0.0000', paid: '0.0000' });
    const b = await bill();
    await post(await note(b.uuid));
    // 827.5862 = 1,280.00 x 6,000.00 / 9,280.00: the VAT of the 960.00 nobody paid is not credited.
    expect(await pay(b.id, '6000.00', '2026-09-30', false, '960.00')).toEqual(['1130 827.5862/0', '1135 0/827.5862']);
  }, 90_000);
});

// MNE-001-490 (#692, part 3/3). Its rule goes away with the block: left in
// place it would post every note uploaded below, T8's among them.
describe('a firm rule that sets auto and requires document_type = credit_note', () => {
  const ruleId = uuidv4();
  const vendors = async () => (await rows<{ n: number }>(`SELECT COUNT(*)::int AS n FROM vendors WHERE entity_id = $1`, [f.entityId]))[0].n;

  beforeAll(async () => {
    await query(
      `INSERT INTO processing_rules (id, entity_id, rule_name, rule_type, conditions, actions)
       VALUES ($1, $2, 'vendor credit notes post by themselves', 'processing_mode',
               '{"all":[{"field":"document_type","operator":"equals","value":"credit_note"}]}'::jsonb, '{"set_processing_mode":"auto"}'::jsonb)`,
      [ruleId, f.entityId]
    );
  });
  afterAll(async () => {
    await query(`DELETE FROM processing_rules WHERE id = $1 AND entity_id = $2`, [ruleId, f.entityId]);
  });

  it('T12 · the upload posts the note against its bill, which owes 6,960.00', async () => {
    const b = await bill();
    const n = await note(b.uuid);
    expect(n.autoProcessed).toBe(true);
    expect(await entriesOf(n.uuid)).toEqual([expect.objectContaining({
      source_type: 'vendor_credit_note', source_id: b.id, day: '2026-09-10',
      lines: ['1135 0/320.0000', '2110 2320.0000/0', '6100 0/2000.0000'],
    })]);
    expect(await balanceOf(b.id)).toMatchObject({ due: '6960.0000' });
  }, 90_000);

  it('T13 · a note from an RFC that is not the vendor of the bill waits with its reason, and no vendor is created', async () => {
    const b = await bill();
    const before = await vendors();
    const n = await note(b.uuid, (x) => x.replace(VENDOR_RFC, 'CON850101AB3'));
    expect(n.autoProcessed).toBe(false);
    expect(await entriesOf(n.uuid)).toEqual([]);
    expect(await rows(`SELECT validation_status, error_message FROM pre_registrations WHERE id = $1`, [n.pre.id]))
      .toEqual([{ validation_status: 'needs_review', error_message: expect.stringMatching(/issued by CON850101AB3, and bill \S+ belongs to vendor SIN060101AB1/) }]);
    expect(await vendors()).toBe(before);
    expect(await balanceOf(b.id)).toMatchObject({ due: '9280.0000' });
  }, 90_000);

  it('T14 · a type E this entity issued stays refused: nothing posts', async () => {
    const b = await bill();
    const n = await note(b.uuid, (x) => x.replace('Rfc="XAXX010101000"', 'Rfc="CLI010101AB2"').replace(VENDOR_RFC, 'XAXX010101000'));
    expect(n.autoProcessed).toBe(false);
    expect(await entriesOf(n.uuid)).toEqual([]);
    expect(await rows(`SELECT document_type, status FROM pre_registrations WHERE id = $1`, [n.pre.id]))
      .toEqual([{ document_type: 'credit_note', status: expect.not.stringMatching(/completed/) }]);
  }, 90_000);
});

describe('what the note reads besides its bill', () => {
  it('T4 · the VAT of the bill in 1130, as a PUE and as a PPD credited the old way: the note credits 1130 and the workpaper warns', async () => {
    const october: Edit = (x) => x.replaceAll(/2026-0[89]-/g, '2026-10-');
    for (const oldWay of [false, true]) {
      const b = await bill((x) => october(x).replace('MetodoPago="PPD"', 'MetodoPago="PUE"'));
      // NOTE: seeded, not posted: a PPD document whose entry debited 1130 is what the door wrote before cash-basis VAT.
      if (oldWay) await query(`UPDATE xml_documents SET xml_content = replace(xml_content, '"PUE"', '"PPD"') WHERE entity_id = $1 AND cfdi_uuid = $2`, [f.entityId, b.uuid]);
      const n = await note(b.uuid, october);
      await post(n);
      expect(await linesOf(n.uuid)).toEqual(['1130 0/320.0000', '2110 2320.0000/0', '6100 0/2000.0000']);
    }
    const { findings } = await buildIvaWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 10 });
    expect(findings.find((h) => h.codigo === 'IVA-WP-CREDITABLE-VS-LEDGER')?.mensaje).toMatch(/nota de crédito/);
  }, 120_000);

  it('T6 · a refusal through the door posts nothing and leaves its reason on the pre-registration', async () => {
    const b = await bill();
    const refused: Array<[{ uuid: string; pre: Row }, RegExp]> = [
      [await note(b.uuid, (x) => x.replace(VENDOR_RFC, 'CON850101AB3')), /issued by CON850101AB3, and bill \S+ belongs to vendor SIN060101AB1/],
      [await note(uuidv4().toUpperCase()), /exactly one bill of this entity among its related CFDI, and it names 0/],
      [await note(first.uuid), /Bill \S+ is "paid"/],
    ];
    for (const [n, reason] of refused) {
      await expect(post(n)).rejects.toMatchObject({ code: 'CFDI_REQUIERE_DECISION' });
      expect(await rows(`SELECT validation_status, error_message FROM pre_registrations WHERE id = $1`, [n.pre.id]))
        .toEqual([{ validation_status: 'needs_review', error_message: expect.stringMatching(reason) }]);
      expect(await entriesOf(n.uuid)).toEqual([]);
    }
    expect(await balanceOf(b.id)).toMatchObject({ due: '9280.0000' });
  }, 120_000);

  it('T5 · with received_credit_note_cost = purchase_returns the 2,000.00 goes to 5200', async () => {
    const b = await bill();
    await policy('received_credit_note_cost', 'purchase_returns');
    const n = await note(b.uuid);
    await post(n);
    expect(await linesOf(n.uuid)).toEqual(['1135 0/320.0000', '2110 2320.0000/0', '5200 0/2000.0000']);
  }, 90_000);

  it('T7 · dated in a closed month it waits until cfdi_periodo_cerrado says periodo_actual, and then posts today', async () => {
    const b = await bill();
    const n = await note(b.uuid, (x) => x.replaceAll('2026-09-10', '2026-07-10'));
    await query(`UPDATE fiscal_periods SET status = 'hard_close' WHERE id = $1 AND entity_id = $2`, [f.periodos[7], f.entityId]);
    await expect(post(n)).rejects.toThrow(/dated 2026-07-10.*closed.*cfdi_periodo_cerrado periodo_actual/);
    expect(await entriesOf(n.uuid)).toEqual([]);
    await policy('cfdi_periodo_cerrado', 'periodo_actual');
    // The fixture creates 2026 only, so "today" is pinned inside it.
    vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(new Date('2026-11-16T12:00:00'));
    await post(n).finally(() => vi.useRealTimers());
    expect((await entriesOf(n.uuid)).map((e) => e.day)).toEqual(['2026-11-16']);
  }, 90_000);

  // Last on purpose: its rule would post every bill uploaded after it.
  it('T8 · a rule that sets processing_mode = auto with no conditions posts nothing for a note and leaves it ready', async () => {
    const b = await bill();
    await query(
      `INSERT INTO processing_rules (id, entity_id, rule_name, rule_type, conditions, actions)
       VALUES ($1, $2, 'everything posts by itself', 'processing_mode', '{}'::jsonb, '{"set_processing_mode":"auto"}'::jsonb)`,
      [uuidv4(), f.entityId]
    );
    const n = await note(b.uuid);
    expect(n.autoProcessed).toBe(false);
    expect(await entriesOf(n.uuid)).toEqual([]);
    expect(await rows(`SELECT processing_mode, status, error_message FROM pre_registrations WHERE id = $1`, [n.pre.id]))
      .toEqual([{ processing_mode: 'auto', status: 'ready', error_message: null }]);
  }, 90_000);
});
