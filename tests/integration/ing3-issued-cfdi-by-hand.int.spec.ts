import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { Command } from 'commander';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { ingestCfdiFiles } from '../../src/ai/ingest-service.js';
import { approveDraft, canonicalDraftHash, createDraft, getDraft, rejectDraft, type Reviewer } from '../../src/ai/draft-service.js';
import { resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';
import { codePreRegistration } from '../../src/services/xml-ingestion/pre-registration-coding.js';
import type { AgentContext } from '../../src/ai/context.js';
import { registerCfdiCommand } from '../../src/cli/cfdi-command.js';
import { registerBillCommand } from '../../src/cli/bill-command.js';
import { registerRepCommand } from '../../src/cli/rep-command.js';
import { entityScope } from '../../src/database/scope.js';
import { emptyReading, loadCensus } from '../../src/services/sat-census/census.js';
import { reconcileCensus } from '../../src/services/sat-census/reconcile.js';
import xmlIngestionRouter from '../../src/api/rest/routes/xml-ingestion.js';
import { levantar, pedir, sesionDe } from './helpers/servidor.js';
import { repXml } from './helpers/rep-xml.js';

// ============================================================
// MNE-001-417 (#620, part 2/4) — AN ISSUED CFDI CODED BY HAND GOES TO AR.
//
// Measured before: with no model provider an issued CFDI stayed «to code» and
// no door took it; only the approval of an AI draft reached receivables. The
// hand door, postIssuedCfdiByHand, makes the customer invoice, its entry and
// the close of the pre-registration one act. Every CFDI is ingested with no
// model, and a person's coding goes through codePreRegistration, the service
// behind `bill inbox edit`. Synthetic data only: the entity is the generic RFC
// XAXX010101000 and the customer a made-up RFC. Every figure is worked out by
// hand and written here.
//
// MNE-001-455 (part 4/5) adds, on the same door: the issued REP that settles
// the invoice, whether it arrives after it or waited parked for it; the doors
// that still book no issued CFDI; and the census, which counts it as booked.
// ============================================================

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', 'factura-consultoria-2001.xml'), 'utf8');
const FIXTURE_UUID = 'F7C0E1A3-6D41-4C8F-B05E-314C5D6E7F80';
const OWN_RFC = 'XAXX010101000';
const CUSTOMER_RFC = 'SIN060101AB1';

type Edit = (xml: string) => string;
/** A string replacement that fails when the fixture no longer has the text. */
const swap = (from: string | RegExp, to: string): Edit => (xml) => {
  expect(xml).toMatch(from);
  return xml.replace(from, to);
};
const method = (m: string | null) => swap(' MetodoPago="PPD"', m ? ` MetodoPago="${m}"` : '');
const total = (attributes: string) => swap('SubTotal="8000.00" Total="9280.00"', attributes);
const related = (type: string, uuid: string) =>
  swap('<cfdi:Emisor', `<cfdi:CfdiRelacionados TipoRelacion="${type}"><cfdi:CfdiRelacionado UUID="${uuid}"/></cfdi:CfdiRelacionados><cfdi:Emisor`);
const tax = (kind: 'Traslado' | 'Retencion', code: string, rate: string, amount: string) =>
  `<cfdi:${kind} Base="8000.00" Impuesto="${code}" TipoFactor="Tasa" TasaOCuota="${rate}" Importe="${amount}"/>`;
/**
 * Taxes go on the concept as well as in the global node: with the global node
 * only, the facts read every withholding as ISR.
 */
const taxes = (totals: string, nodes: string): Edit[] => [
  swap(' ObjetoImp="02"/>', ` ObjetoImp="02"><cfdi:Impuestos>${nodes}</cfdi:Impuestos></cfdi:Concepto>`),
  swap(/<cfdi:Impuestos TotalImpuestosTrasladados[\s\S]*?<\/cfdi:Impuestos>/, `<cfdi:Impuestos ${totals}>${nodes}</cfdi:Impuestos>`),
];
const VAT = tax('Traslado', '002', '0.160000', '1280.00');
/**
 * A PPD sale with the customer's withholdings: base 8,000.00, VAT 1,280.00
 * (16 %), ISR withheld 800.00 (10 %), VAT withheld 853.33 (two thirds), total
 * 7,626.67. The issuer becomes regime 612 so the withholdings have their legal
 * basis: a legal entity that pays an individual's professional fees withholds
 * 10 % ISR (LISR 106) and two thirds of the VAT (LIVA 1-A II a, RLIVA 3-I).
 */
const WITHHELD: Edit[] = [
  swap('SA" RegimenFiscal="601"', 'SA" RegimenFiscal="612"'),
  total('SubTotal="8000.00" Total="7626.67"'),
  ...taxes(
    'TotalImpuestosRetenidos="1653.33" TotalImpuestosTrasladados="1280.00"',
    `<cfdi:Traslados>${VAT}</cfdi:Traslados><cfdi:Retenciones>${tax('Retencion', '001', '0.100000', '800.00')}` +
      `${tax('Retencion', '002', '0.106667', '853.33')}</cfdi:Retenciones>`
  ),
];
/** IEPS of 640.00 (8 %) next to the VAT: total 9,920.00. */
const WITH_IEPS: Edit[] = [
  total('SubTotal="8000.00" Total="9920.00"'),
  ...taxes('TotalImpuestosTrasladados="1920.00"', `<cfdi:Traslados>${VAT}${tax('Traslado', '003', '0.080000', '640.00')}</cfdi:Traslados>`),
];
/** A local tax of 240.00 (3 %) transferred in its complement: total 9,520.00. */
const WITH_LOCAL_TAX: Edit[] = [
  total('SubTotal="8000.00" Total="9520.00"'),
  swap('<cfdi:Complemento>',
    '<cfdi:Complemento><implocal:ImpuestosLocales xmlns:implocal="http://www.sat.gob.mx/implocal" version="1.0" ' +
      'TotaldeRetenciones="0.00" TotaldeTraslados="240.00"><implocal:TrasladosLocales ImpLocTrasladado="ISH" ' +
      'TasadeTraslado="3.00" Importe="240.00"/></implocal:ImpuestosLocales>'),
];

let f: Fixture;
let ctx: AgentContext;
let reviewer: Reviewer;
let dir: string;

/** The fixture ingested with no model: issued by the entity to the customer unless `received`. */
async function stranded(edits: Edit[] = [], received = false): Promise<{ uuid: string; id: string }> {
  const uuid = uuidv4().toUpperCase();
  const turned = received ? FIXTURE : FIXTURE
    .replace(`<cfdi:Emisor Rfc="${CUSTOMER_RFC}"`, `<cfdi:Emisor Rfc="${OWN_RFC}"`)
    .replace(`<cfdi:Receptor Rfc="${OWN_RFC}"`, `<cfdi:Receptor Rfc="${CUSTOMER_RFC}"`);
  const file = path.join(dir, `${uuid}.xml`);
  fs.writeFileSync(file, edits.reduce((xml, edit) => edit(xml), turned.replace(FIXTURE_UUID, uuid)));
  const report = await ingestCfdiFiles({
    ctx, reviewer, files: [file], session: null, capture: { drafts: [] },
    thresholds: { autoPost: false, minConfidence: 0.95, maxAmount: 10000 },
  });
  const pre = await query<{ id: string }>(
    `SELECT p.id FROM pre_registrations p JOIN xml_documents x ON x.id = p.xml_document_id
      WHERE p.entity_id = $1 AND x.cfdi_uuid = $2`,
    [f.entityId, uuid]
  );
  expect(pre.rows, report.results[0].detail).toHaveLength(1);
  return { uuid, id: pre.rows[0].id };
}

const post = (uuid: string, account?: string, dryRun = false) =>
  new PreRegistrationService().postIssuedCfdiByHand({
    entityId: f.entityId, cfdiUuid: uuid, userId: f.userId, revenueAccountId: account ? f.cuentas[account] : undefined, dryRun,
  });

/** Everything a refusal must leave as it was; `folios` is the INV counter. */
async function ledger() {
  return (await query<Record<string, number>>(
    `SELECT (SELECT count(*) FROM invoices WHERE entity_id = $1)::int AS invoices,
            (SELECT count(*) FROM journal_entries WHERE entity_id = $1)::int AS entries,
            (SELECT count(*) FROM customer_payments WHERE entity_id = $1)::int AS payments,
            (SELECT count(*) FROM customers WHERE entity_id = $1)::int AS customers,
            (SELECT count(*) FROM pre_registrations WHERE entity_id = $1 AND result_id IS NOT NULL)::int AS closed,
            (SELECT COALESCE(sum(value), 0) FROM entity_sequences WHERE entity_id = $1 AND name LIKE 'invoice_%')::int AS folios`,
    [f.entityId]
  )).rows[0];
}

/** What the door wrote for a CFDI: the invoice, its entry line by line, and the closed pre-registration. */
async function born(uuid: string) {
  const rows = (await query<Record<'id' | 'invoice_number' | 'amount_due' | 'description' | 'entry_id', string>>(
    `SELECT i.id, i.invoice_number, i.status, i.amount_due::text, i.cfdi_status, i.invoice_date::text,
            je.id AS entry_id, je.status AS entry_status, je.source_type, je.source_id, je.description,
            je.entry_date::text, p.status AS pre_status, p.result_type, p.result_id, x.processing_status
       FROM invoices i
       JOIN journal_entries je ON je.id = i.journal_entry_id AND je.entity_id = i.entity_id
       JOIN xml_documents x ON x.entity_id = i.entity_id AND x.cfdi_uuid = i.cfdi_uuid
       JOIN pre_registrations p ON p.xml_document_id = x.id AND p.entity_id = i.entity_id
      WHERE i.entity_id = $1 AND i.cfdi_uuid = $2`,
    [f.entityId, uuid]
  )).rows;
  expect(rows).toHaveLength(1);
  const [invoice] = rows;
  expect(invoice).toMatchObject({
    status: 'sent', cfdi_status: 'stamped', entry_status: 'posted', source_type: 'invoice', source_id: invoice.id,
    pre_status: 'completed', result_type: 'invoice', result_id: invoice.id, processing_status: 'completed',
  });
  const lines = await query<{ line: string }>(
    `SELECT (CASE WHEN l.debit_amount IS NULL THEN 'CR ' ELSE 'DR ' END) || a.code || ' ' ||
            to_char(COALESCE(l.debit_amount, l.credit_amount), 'FM9999990.00') AS line
       FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.journal_entry_id = $1 ORDER BY l.line_number`,
    [invoice.entry_id]
  );
  return { ...invoice, lines: lines.rows.map((l) => l.line) };
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-417 issued CFDI by hand');
  ctx = {
    entityId: f.entityId, entityName: 'ING-3 by hand', tenantId: f.tenantId, currency: 'MXN',
    country: 'MX', accountingStandard: 'mx_nif', taxId: OWN_RFC,
  };
  const email = (await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [f.userId])).rows[0].email;
  reviewer = { userId: f.userId, email };
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ing3-hand-'));
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1, $2, 'C-ING3', 'Servicios Integrales SA', $3, 'rfc', 'MXN', $4)`,
    [uuidv4(), f.entityId, CUSTOMER_RFC, f.userId]
  );
});

const code = (id: string, account: string, line?: number) =>
  codePreRegistration(f.entityId, id, line
    ? { line: { lineNumber: line, accountId: f.cuentas[account] } }
    : { defaultAccountId: f.cuentas[account] });

/** One command line in process; `said` is everything it printed or reported. */
async function cli(...argv: string[]): Promise<{ exitCode?: number; said: string }> {
  const program = new Command('mnemosine').exitOverride();
  let exitCode: number | undefined;
  let said = '';
  const plain = (text: string) => text;
  const say = (chunk: unknown) => { said += String((chunk as Error)?.message ?? chunk); return true; };
  const deps = {
    palette: { dim: plain, bold: plain, cyan: plain, red: plain, green: plain, yellow: plain } as never,
    shutdown: (c: number) => { exitCode = c; }, reportError: say,
  };
  registerCfdiCommand(program, deps);
  registerBillCommand(program, deps);
  registerRepCommand(program, deps);
  const streams = [vi.spyOn(process.stdout, 'write').mockImplementation(say), vi.spyOn(process.stderr, 'write').mockImplementation(say)];
  await program.parseAsync(['node', 'mnemosine', ...argv, '--entity', f.entityId, '--tenant', f.tenantId])
    .finally(() => streams.forEach((stream) => stream.mockRestore()));
  return { exitCode, said };
}

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('an issued CFDI coded by hand becomes a customer invoice with its entry, in one act', () => {
  it('PPD, nothing coded: a dry run shows the act and writes nothing; the real run draws the same folio', async () => {
    const { uuid, id } = await stranded();
    const before = await ledger();
    const preview = await post(uuid, undefined, true);
    expect(preview).toMatchObject({ dryRun: true, preRegistrationId: id, invoice: { status: 'sent', amountDue: '9280.0000' } });
    expect(preview.lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([
      ['1120', '9280.0000', null], ['4100', null, '8000.0000'], ['2125', null, '1280.0000'],
    ]);
    expect(await ledger()).toEqual(before);

    const posted = await post(uuid);
    const invoice = await born(uuid);
    expect(posted).toMatchObject({
      dryRun: false, invoice: { id: invoice.id, number: preview.invoice.number }, entry: { number: preview.entry.number },
    });
    expect(invoice).toMatchObject({ amount_due: '9280.0000', invoice_date: '2026-08-20', entry_date: '2026-08-20' });
    expect(invoice.lines).toEqual(['DR 1120 9280.00', 'CR 4100 8000.00', 'CR 2125 1280.00']);
    expect(invoice.description).not.toMatch(/MetodoPago/);
  });

  it.each<{ name: string; edits: Edit[]; coding?: [account: string, line?: number]; account?: string; entry: string[]; due?: string }>([
    {
      name: 'PUE with 4200 stored as the default: VAT on 2120, the invoice stays sent with the total due',
      edits: [method('PUE')], coding: ['4200'], entry: ['DR 1120 9280.00', 'CR 4200 8000.00', 'CR 2120 1280.00'],
    },
    {
      name: 'PPD with the customer withholdings: each on its own account, VAT parked on 2125',
      edits: WITHHELD, due: '7626.6700',
      entry: ['DR 1120 7626.67', 'DR 1145 800.00', 'DR 1146 853.33', 'CR 4100 8000.00', 'CR 2125 1280.00'],
    },
    {
      name: 'a coded line beats the account passed',
      edits: [], coding: ['4300', 1], account: '4200', entry: ['DR 1120 9280.00', 'CR 4300 8000.00', 'CR 2125 1280.00'],
    },
    {
      name: 'the account passed beats the stored default',
      edits: [], coding: ['4200'], account: '4300', entry: ['DR 1120 9280.00', 'CR 4300 8000.00', 'CR 2125 1280.00'],
    },
    // MNE-001-521 (#669): each tax on its own role. 8,000.00 + 1,280.00 + 240.00 = 9,520.00; with IEPS, + 640.00 = 9,920.00.
    {
      name: 'PPD with a local tax of 240.00: on 2190 at issuance, VAT parked on 2125',
      edits: WITH_LOCAL_TAX, due: '9520.0000',
      entry: ['DR 1120 9520.00', 'CR 4100 8000.00', 'CR 2125 1280.00', 'CR 2190 240.00'],
    },
    {
      name: 'PUE with IEPS of 640.00: on 2180 at issuance, VAT on 2120',
      edits: [...WITH_IEPS, method('PUE')], due: '9920.0000',
      entry: ['DR 1120 9920.00', 'CR 4100 8000.00', 'CR 2180 640.00', 'CR 2120 1280.00'],
    },
  ])('$name', async ({ edits, coding, account, entry, due }) => {
    const { uuid, id } = await stranded(edits);
    if (coding) await code(id, ...coding);
    await post(uuid, account);
    const invoice = await born(uuid);
    expect(invoice.lines).toEqual(entry);
    expect(invoice.amount_due).toBe(due ?? '9280.0000');
  });

  it('no MetodoPago is a PUE sale and the entry says so; a line suggestion, an expense account, is ignored', async () => {
    const { uuid, id } = await stranded([method(null)]);
    const suggested = await query(
      `UPDATE pre_registrations SET lines = jsonb_set(lines, '{0,suggested_account_id}', to_jsonb($3::text))
        WHERE id = $1 AND entity_id = $2`,
      [id, f.entityId, f.cuentas['6100']]
    );
    expect(suggested.rowCount).toBe(1);
    await post(uuid);
    const invoice = await born(uuid);
    expect(invoice.lines).toEqual(['DR 1120 9280.00', 'CR 4100 8000.00', 'CR 2120 1280.00']);
    expect(invoice.description).toMatch(/ · MetodoPago missing: PUE assumed$/);
  });

  it.each<{ name: string; edits?: Edit[]; received?: boolean; coding?: [string, number?]; account?: string; refusal: RegExp }>([
    {
      name: 'a receiver outside the customer catalog, with the command that registers it',
      edits: [swap(`<cfdi:Receptor Rfc="${CUSTOMER_RFC}"`, '<cfdi:Receptor Rfc="GAL150623QK8"')],
      refusal: /not in this entity's customer catalog.*mnemosine customer create --name '.*' --tax-id 'GAL150623QK8'.*run the command again/,
    },
    { name: 'a CFDI the entity received', received: true, refusal: /received.*mnemosine bill inbox run [0-9a-f-]{36}/ },
    { name: 'an issued credit note', edits: [swap('TipoDeComprobante="I"', 'TipoDeComprobante="E"')], refusal: /credit_note, not a sale invoice/ },
    { name: 'a CFDI in USD', edits: [swap('Moneda="MXN"', 'Moneda="USD" TipoCambio="18.50"')], refusal: /USD.*does not convert/ },
    { name: 'an advance', edits: [swap('Descripcion="Consultoria', 'Descripcion="Anticipo de consultoria')], refusal: /advance/ },
    { name: 'an invoice that applies an advance (TipoRelacion 07)', edits: [related('07', uuidv4())], refusal: /TipoRelacion 07/ },
    // MNE-001-521: the core's refusal, the same at both doors, until #699 gives that IEPS a role to wait in.
    { name: 'IEPS transferred on a PPD sale', edits: WITH_IEPS, refusal: /PPD sale.*IEPS \(640\.00\).*#699/ },
    { name: 'an expense account passed as the revenue account', account: '6100', refusal: /6100 \(expense.*cannot take the revenue/ },
    { name: 'an expense account coded on a line', coding: ['6100', 1], refusal: /6100 .*line 1.*cannot take the revenue/ },
    { name: 'a liability account with a credit balance', account: '2150', refusal: /2150 \(liability, credit.*cannot take the revenue/ },
    { name: 'a header account', account: '4000', refusal: /4000 \(revenue, credit.*cannot take the revenue/ },
    { name: 'a contra-revenue account (4400, debit balance)', account: '4400', refusal: /4400 \(revenue, debit.*cannot take the revenue/ },
  ])('refuses $name, and writes nothing', async ({ edits, received, coding, account, refusal }) => {
    const { uuid, id } = await stranded(edits, received);
    if (coding) await code(id, ...coding);
    const before = await ledger();
    await expect(post(uuid, account)).rejects.toThrow(refusal);
    await expect(post(uuid, account, true)).rejects.toThrow(refusal);
    expect(await ledger()).toEqual(before);
  });

  it('a CFDI whose concepts do not add up to its SubTotal never reaches the door: the upload refuses it (#729)', async () => {
    // The concept is 8,000.00 gross with 100.00 off, and the header says SubTotal 7,900.00 less 100.00.
    const edits = [swap(' ObjetoImp="02"/>', ' Descuento="100.00" ObjetoImp="02"/>'), total('SubTotal="7900.00" Descuento="100.00" Total="9080.00"')];
    await expect(stranded(edits)).rejects.toThrow(/Conceptos total 8000\.00.*does not match SubTotal 7900\.00/);
  });

  it('one CFDI gives one invoice: a repeat, a UUID already on a live invoice and a substitute of one are refused by name', async () => {
    const { uuid } = await stranded();
    const first = await post(uuid);
    const before = await ledger();
    await expect(post(uuid)).rejects.toThrow(new RegExp(`completed.*${first.invoice.number}`));
    await expect(post(uuidv4())).rejects.toMatchObject({ statusCode: 404 });

    const opening = await stranded();
    await query(
      `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount, total_amount, amount_due,
         currency_code, invoice_date, due_date, status, cfdi_uuid, created_by)
       SELECT $1, $2, 'INV-OPENING-7', c.id, 8000, 1280, 9280, 9280, 'MXN', '2026-08-20', '2026-08-20', 'sent', $3, $4
         FROM customers c WHERE c.entity_id = $2 AND c.tax_id = $5`,
      [uuidv4(), f.entityId, opening.uuid.toLowerCase(), f.userId, CUSTOMER_RFC]
    );
    const refusal = await post(opening.uuid).catch((e: unknown) => e);
    expect(refusal).toMatchObject({ code: 'CFDI_ALREADY_INVOICED' });
    expect((refusal as Error).message).toMatch(/INV-OPENING-7.*sent/);

    const substitute = await stranded([related('04', uuid.toLowerCase())]);
    await expect(post(substitute.uuid)).rejects.toThrow(new RegExp(`substitutes.*${first.invoice.number}`));
    expect(await ledger()).toEqual({ ...before, invoices: before.invoices + 1 });
  });

  it('an AI draft in review closes the hand door; rejected, the door posts, and a second draft is refused at approval', async () => {
    const { uuid, id } = await stranded();
    const draft = () => createDraft(ctx, {
      confidence: 0.9, reasoning: 'Issued sale', model: 'fake-model', preRegistrationId: id,
      payload: {
        entry_date: '2026-08-20', description: 'Venta B2001',
        lines: [{ account_code: '1120', debit: 9280 }, { account_code: '4100', credit: 8000 }, { account_code: '2125', credit: 1280 }],
      },
    });
    const pending = await draft();
    const before = await ledger();
    await expect(post(uuid)).rejects.toThrow(/AI draft.*mnemosine review/);
    expect(await ledger()).toEqual(before);

    await rejectDraft(ctx, pending.id, reviewer, 'Coded by hand');
    await post(uuid);
    const after = await ledger();
    const late = await getDraft(ctx, (await draft()).id);
    const refusal = await approveDraft(ctx, late!.id, reviewer, undefined, canonicalDraftHash(late!.payload, late!.origin))
      .catch((e: unknown) => e);
    expect(refusal).toMatchObject({ code: 'CFDI_ALREADY_INVOICED' });
    expect(await ledger()).toEqual(after);
  });

  // MNE-001-418: the terminal command over the door, and the messages that send an issued CFDI to it.
  describe('cfdi post at the terminal, in process', () => {
    it('--dry-run writes nothing and names the folio the real run then draws; --account reaches the entry by its code', async () => {
      const { uuid, id } = await stranded([method('PUE')]);
      const before = await ledger();
      expect(await cli('cfdi', 'post', uuid)).toMatchObject({ exitCode: 10 });
      const preview = await cli('cfdi', 'post', uuid, '--account', '4200', '--dry-run');
      expect(preview.exitCode).toBe(0);
      expect(preview.said).toContain(`bill inbox edit ${id} --line`);
      expect(await ledger()).toEqual(before);

      const posted = await cli('cfdi', 'post', uuid, '--account', '4200', '--yes');
      expect(posted).toMatchObject({ exitCode: 0 });
      const invoice = await born(uuid);
      expect(invoice.lines).toEqual(['DR 1120 9280.00', 'CR 4200 8000.00', 'CR 2120 1280.00']);
      expect(preview.said).toContain(invoice.invoice_number);
      expect(posted.said).toContain(invoice.invoice_number);
      expect(posted.said).toContain(`receipt record ${invoice.invoice_number}`);
      expect(await cli('cfdi', 'post', uuid, '--yes')).toMatchObject({ exitCode: 5 });
    });

    it('bill inbox edit and bill inbox run send an issued CFDI to cfdi post, and the run still posts nothing', async () => {
      const { uuid, id } = await stranded();
      const coded = await cli('bill', 'inbox', 'edit', id, '--account', '4200');
      expect(coded.exitCode).toBe(0);
      expect(coded.said).toContain(`mnemosine cfdi post ${uuid}`);
      expect(coded.said).not.toContain('bill inbox run');
      const before = await ledger();
      const run = await cli('bill', 'inbox', 'run', id, '--yes');
      expect(run.exitCode).toBe(1);
      expect(run.said).toContain(`mnemosine cfdi post ${uuid}`);
      expect(await ledger()).toEqual(before);
    });
  });

  // MNE-001-455: the hand door against the REP, the doors that stay closed and the census.
  describe('after the hand door: the REP, the closed doors and the census', () => {
    /** Signed balance (debits less credits) of an account in August, the month of every document here. */
    async function august(account: string): Promise<number> {
      const r = await query<{ balance: string }>(
        `SELECT COALESCE(sum(ab.debit_total - ab.credit_total), 0)::text AS balance
           FROM account_balances ab JOIN accounts a ON a.id = ab.account_id
          WHERE a.entity_id = $1 AND a.code = $2 AND ab.fiscal_period_id = $3`,
        [f.entityId, account, f.periodos[8]]
      );
      return Number(r.rows[0].balance);
    }

    /** The entity's own REP for 9,280.00 on 2026-08-25, paying `invoiceUuid` in full, ingested with no model. */
    async function ingestRep(invoiceUuid: string) {
      const uuid = uuidv4().toUpperCase();
      const file = path.join(dir, `${uuid}.xml`);
      fs.writeFileSync(file, repXml({ cfdiUuid: invoiceUuid, total: '9280.00', iva: 1280 }, uuid, {
        issuerRfc: OWN_RFC, issuerName: 'Demo Corp MX', receiverRfc: CUSTOMER_RFC, date: new Date(Date.UTC(2026, 7, 25)),
      }));
      const report = await ingestCfdiFiles({
        ctx, reviewer, files: [file], session: null, capture: { drafts: [] },
        thresholds: { autoPost: false, minConfidence: 0.95, maxAmount: 10000 },
      });
      return { uuid, result: report.results[0] };
    }

    /** The invoice of a CFDI and the collections applied to it, each with the REP it carries and its entry. */
    async function collected(invoiceUuid: string) {
      const invoice = (await query<{ id: string; status: string; amount_due: string }>(
        `SELECT id, status, amount_due::text FROM invoices WHERE entity_id = $1 AND cfdi_uuid = $2`,
        [f.entityId, invoiceUuid]
      )).rows;
      expect(invoice).toHaveLength(1);
      const payments = (await query<{ rep: string; applied: string; entry: string | null }>(
        `SELECT p.cfdi_uuid AS rep, a.amount_applied::text AS applied, je.status AS entry
           FROM payment_allocations a
           JOIN customer_payments p ON p.id = a.payment_id AND p.entity_id = $1
           LEFT JOIN journal_entries je ON je.id = p.journal_entry_id AND je.entity_id = $1
          WHERE a.invoice_id = $2`,
        [f.entityId, invoice[0].id]
      )).rows;
      return { status: invoice[0].status, due: invoice[0].amount_due, payments };
    }

    it('the issued REP that arrives after the invoice settles it and moves 1,280.00 from 2125 to 2120', async () => {
      const { uuid } = await stranded();
      await post(uuid);
      expect(await collected(uuid)).toEqual({ status: 'sent', due: '9280.0000', payments: [] });
      const parked = await august('2125');
      const payable = await august('2120');

      const rep = await ingestRep(uuid);
      expect(rep.result, rep.result.detail).toMatchObject({ status: 'rules' });
      expect(rep.result.detail).toMatch(/linked deterministically/);
      // One collection, made by the payments gate: posted entry, the REP's UUID, the whole invoice applied.
      expect(await collected(uuid)).toEqual({
        status: 'paid', due: '0.0000', payments: [{ rep: rep.uuid, applied: '9280.0000', entry: 'posted' }],
      });
      // Credit balances are negative: the debit raises 2125 and the credit lowers 2120.
      expect(await august('2125')).toBeCloseTo(parked + 1280, 2);
      expect(await august('2120')).toBeCloseTo(payable - 1280, 2);
    });

    it('a REP that arrived before its invoice waits parked, and rep reconcile links it once the CFDI is coded', async () => {
      const { uuid } = await stranded();
      const before = await ledger();
      const rep = await ingestRep(uuid);
      expect(rep.result.status, rep.result.detail).not.toBe('rules');
      expect(rep.result.detail).toContain(uuid);
      expect(await ledger()).toEqual(before);

      await post(uuid);
      const parked = await august('2125');
      const payable = await august('2120');
      expect(await collected(uuid)).toEqual({ status: 'sent', due: '9280.0000', payments: [] });

      const reconciled = await cli('rep', 'reconcile');
      expect(reconciled.exitCode, reconciled.said).toBe(0);
      expect(await collected(uuid)).toEqual({
        status: 'paid', due: '0.0000', payments: [{ rep: rep.uuid, applied: '9280.0000', entry: 'posted' }],
      });
      expect(await august('2125')).toBeCloseTo(parked + 1280, 2);
      expect(await august('2120')).toBeCloseTo(payable - 1280, 2);
    });

    it('bill inbox run, the scheduled batch and both REST routes book no issued CFDI; the hand door still posts the row they left in error', async () => {
      const { uuid, id } = await stranded();
      const before = await ledger();
      const row = async () => (await query<{ status: string }>(
        `SELECT status FROM pre_registrations WHERE id = $1 AND entity_id = $2`, [id, f.entityId]
      )).rows[0].status;

      expect(await cli('bill', 'inbox', 'run', id, '--yes')).toMatchObject({ exitCode: 1 });
      expect(await ledger()).toEqual(before);

      const server = await levantar([['/v1', xmlIngestionRouter]], sesionDe(f));
      try {
        const single = await pedir(server, 'POST', `/v1/pre-registrations/${id}/process`);
        expect(single.status, JSON.stringify(single.body)).toBe(422);
        expect(await ledger()).toEqual(before);
        const bulk = await pedir(server, 'POST', '/v1/pre-registrations/bulk', { action: 'process', ids: [id] });
        expect(bulk.status, JSON.stringify(bulk.body)).toBe(200);
        expect(JSON.stringify(bulk.body)).toMatch(new RegExp(`"id":"${id}","status":"error"`));
        expect(await ledger()).toEqual(before);
      } finally {
        await server.cerrar();
      }

      // An issued row is born `draft`; the batch only takes `ready` rows, so the test puts it there.
      const batchId = uuidv4();
      await query(
        `INSERT INTO processing_batches (id, entity_id, batch_number, batch_name, status) VALUES ($1, $2, $3, 'issued row', 'scheduled')`,
        [batchId, f.entityId, `MNE455-${batchId.slice(0, 8)}`]
      );
      const queued = await query(
        `UPDATE pre_registrations SET status = 'ready', processing_mode = 'batch', scheduled_batch_id = $3
          WHERE id = $1 AND entity_id = $2 AND status = 'error'`,
        [id, f.entityId, batchId]
      );
      expect(queued.rowCount).toBe(1);
      expect(await new PreRegistrationService().processBatch(batchId, f.userId, f.entityId))
        .toMatchObject({ total: 1, successful: 0, failed: 1, errors: [{ id }] });
      expect(await ledger()).toEqual(before);
      expect(await row()).toBe('error');

      await post(uuid);
      expect((await born(uuid)).lines).toEqual(['DR 1120 9280.00', 'CR 4100 8000.00', 'CR 2125 1280.00']);
    });

    it('the census counts the coded CFDI as matched, where before the door it was to post', async () => {
      const { uuid } = await stranded();
      const scope = entityScope(f.tenantId, f.entityId);
      await loadCensus(scope, { source: 'metadata', fileName: 'mne-455.txt', sha256: 'a'.repeat(64), loadedBy: null }, {
        ...emptyReading(),
        rows: [{
          uuid: uuid.toLowerCase(), direction: 'issued', cfdiType: 'I', issuerRfc: OWN_RFC, receiverRfc: CUSTOMER_RFC,
          issuedAt: '2026-08-20 10:00:00', amount: '9280.00', satStatus: 'current', cancelledAt: null, source: 'metadata',
        }],
      });
      const waiting = await reconcileCensus(scope, '2026-08-01', '2026-08-31');
      expect(waiting.toPost.map((item) => item.uuid)).toEqual([uuid.toLowerCase()]);
      expect(waiting.matched).toBe(0);

      await post(uuid);
      const booked = await reconcileCensus(scope, '2026-08-01', '2026-08-31');
      expect(booked).toMatchObject({ matched: 1, toPost: [], toFetch: [] });
    });
  });

  // Last on purpose: it closes August, the month of every CFDI above.
  it('a CFDI of a month closed hard is held until cfdi_periodo_cerrado is answered; with periodo_actual the entry posts today', async () => {
    const { uuid } = await stranded();
    const closed = await query(
      `UPDATE fiscal_periods SET status = 'hard_close' WHERE id = $1 AND entity_id = $2 AND status = 'open'`,
      [f.periodos[8], f.entityId]
    );
    expect(closed.rowCount).toBe(1);
    const before = await ledger();
    const refusal = await post(uuid).catch((e: unknown) => e);
    expect(refusal).toMatchObject({ code: 'CFDI_REQUIERE_DECISION' });
    expect((refusal as Error).message).toMatch(/held.*periodo_cerrado.*mnemosine pending define cfdi_periodo_cerrado periodo_actual/);
    expect(await ledger()).toEqual(before);

    await resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, 'cfdi_periodo_cerrado', 'periodo_actual', reviewer.email);
    // The fixture creates 2026 only, so "today" is pinned inside it.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T12:00:00'));
    try {
      await post(uuid);
    } finally {
      vi.useRealTimers();
    }
    const invoice = await born(uuid);
    expect(invoice).toMatchObject({ entry_date: '2026-11-16', invoice_date: '2026-08-20' });
    expect(invoice.invoice_number).toMatch(/^INV-2026-/);
  });
});
