import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { ingestCfdiFiles } from '../../src/ai/ingest-service.js';
import { approveDraft, canonicalDraftHash, createDraft, getDraft, rejectDraft, type Reviewer } from '../../src/ai/draft-service.js';
import { resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';
import { codePreRegistration } from '../../src/services/xml-ingestion/pre-registration-coding.js';
import type { AgentContext } from '../../src/ai/context.js';

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
    { name: 'IEPS transferred', edits: WITH_IEPS, refusal: /IEPS \(640\.00\)/ },
    { name: 'a local tax transferred', edits: WITH_LOCAL_TAX, refusal: /local taxes \(240\.00\)/ },
    { name: 'an expense account passed as the revenue account', account: '6100', refusal: /6100 \(expense.*cannot take the revenue/ },
    { name: 'an expense account coded on a line', coding: ['6100', 1], refusal: /6100 .*line 1.*cannot take the revenue/ },
    { name: 'a liability account with a credit balance', account: '2150', refusal: /2150 \(liability, credit.*cannot take the revenue/ },
    { name: 'a header account', account: '4000', refusal: /4000 \(revenue, credit.*cannot take the revenue/ },
    { name: 'a contra-revenue account (4400, debit balance)', account: '4400', refusal: /4400 \(revenue, debit.*cannot take the revenue/ },
    {
      // The concept nets 7,900.00 and the header says 7,900.00 − 100.00: ingestion takes it, the door does not.
      name: 'concepts whose nets do not add up to SubTotal − Descuento',
      edits: [swap(' ObjetoImp="02"/>', ' Descuento="100.00" ObjetoImp="02"/>'), total('SubTotal="7900.00" Descuento="100.00" Total="9080.00"')],
      refusal: /7900\.00.*7800\.00/,
    },
  ])('refuses $name, and writes nothing', async ({ edits, received, coding, account, refusal }) => {
    const { uuid, id } = await stranded(edits, received);
    if (coding) await code(id, ...coding);
    const before = await ledger();
    await expect(post(uuid, account)).rejects.toThrow(refusal);
    await expect(post(uuid, account, true)).rejects.toThrow(refusal);
    expect(await ledger()).toEqual(before);
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
