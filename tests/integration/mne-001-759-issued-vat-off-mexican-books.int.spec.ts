import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { recordCustomerPayment } from '../../src/services/payments/payment-service.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';

// ============================================================
// MNE-001-759 (#692) · `cfdi post` ASKS THE ENTITY BEFORE IT PARKS THE TAX
// OF A SALE. The mirror of MNE-001-742 on the issued side.
//
// The sale is the fixture CFDI turned around: the entity issues it to the
// customer SIN060101AB1, 8,000.00 + 1,280.00 VAT = 9,280.00, PPD; with IEPS
// of 640.00 (8 %) on the same base, 9,920.00. It is uploaded and posted by
// `postIssuedCfdiByHand`, the service behind `cfdi post`.
//
// `moved` was seeded with the Mexican chart and then declared US / us_gaap:
// it has 2120, 2125, 2180 and 2181. `born` was seeded US: its neutral chart
// has 2135 for the tax of a sale and none of the Mexican roles.
// ============================================================

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', 'factura-consultoria-2001.xml'), 'utf8');
const FIXTURE_UUID = 'F7C0E1A3-6D41-4C8F-B05E-314C5D6E7F80';
const OWN_RFC = 'XAXX010101000';
const CUSTOMER_RFC = 'SIN060101AB1';
const svc = new PreRegistrationService();
interface Books { f: Fixture; customerId: string }

let moved: Books;
let born: Books;

const rows = async <T extends Record<string, unknown>>(sql: string, params: unknown[]) => (await query<T>(sql, params)).rows;

async function books(name: string, options?: Parameters<typeof crearInquilino>[1]): Promise<Books> {
  const f = await crearInquilino(name, options);
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  const customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1, $2, 'C-759', 'Servicios Integrales SA', $3, 'rfc', 'MXN', $4)`,
    [customerId, f.entityId, CUSTOMER_RFC, f.userId]
  );
  return { f, customerId };
}

const declare = ({ f }: Books, country: string, standard: string) => query(
  `UPDATE legal_entities SET incorporation_country = $1, accounting_standard = $2 WHERE id = $3 AND tenant_id = $4`,
  [country, standard, f.entityId, f.tenantId]
);

const IEPS_NODES =
  '<cfdi:Traslado Base="8000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="1280.00"/>' +
  '<cfdi:Traslado Base="8000.00" Impuesto="003" TipoFactor="Tasa" TasaOCuota="0.080000" Importe="640.00"/>';

/** The fixture issued by the entity under a fresh UUID; with IEPS of 640.00 when `ieps`. */
function sale(uuid: string, ieps: boolean): string {
  let xml = FIXTURE.replace(FIXTURE_UUID, uuid).replace('Folio="2001"', `Folio="${uuid.slice(0, 8)}"`)
    .replace(`<cfdi:Emisor Rfc="${CUSTOMER_RFC}"`, `<cfdi:Emisor Rfc="${OWN_RFC}"`)
    .replace(`<cfdi:Receptor Rfc="${OWN_RFC}"`, `<cfdi:Receptor Rfc="${CUSTOMER_RFC}"`);
  if (ieps) {
    expect(xml).toMatch(/<cfdi:Impuestos TotalImpuestosTrasladados[\s\S]*?<\/cfdi:Impuestos>/);
    xml = xml.replace('SubTotal="8000.00" Total="9280.00"', 'SubTotal="8000.00" Total="9920.00"')
      .replace(' ObjetoImp="02"/>', ` ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados>${IEPS_NODES}</cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto>`)
      .replace(/<cfdi:Impuestos TotalImpuestosTrasladados[\s\S]*?<\/cfdi:Impuestos>/,
        `<cfdi:Impuestos TotalImpuestosTrasladados="1920.00"><cfdi:Traslados>${IEPS_NODES}</cfdi:Traslados></cfdi:Impuestos>`);
  }
  return xml;
}

/** The sale uploaded and posted by `cfdi post`: its invoice and its entry's lines. */
async function cfdiPost({ f }: Books, ieps = false): Promise<{ invoiceId: string; lines: string[] }> {
  enterTenant(f.tenantId);
  const uuid = uuidv4().toUpperCase();
  await svc.processXMLUpload(f.entityId, sale(uuid, ieps), 'manual_upload', f.userId);
  const posted = await svc.postIssuedCfdiByHand({ entityId: f.entityId, cfdiUuid: uuid, userId: f.userId, revenueAccountId: f.cuentas['4100'] });
  return { invoiceId: posted.invoice.id, lines: await linesOf(f, posted.entry.id) };
}

/** The lines of a posted entry as `code debit/credit`, ordered by account code (every code is digits). */
const linesOf = async (f: Fixture, entryId: string) => (await rows<{ lines: string[] }>(
  `SELECT array_agg(a.code || ' ' || COALESCE(l.debit_amount, 0)::text || '/' || COALESCE(l.credit_amount, 0)::text
                    ORDER BY a.code COLLATE "C", COALESCE(l.debit_amount, 0), COALESCE(l.credit_amount, 0)) AS lines
     FROM journal_entry_lines l
     JOIN accounts a ON a.id = l.account_id
     JOIN journal_entries je ON je.id = l.journal_entry_id AND je.status = 'posted'
    WHERE je.entity_id = $1 AND je.id = $2`,
  [f.entityId, entryId]
))[0].lines;

/** What the entity's ledger holds in an account, credit positive. */
const owed = async ({ f }: Books, code: string) => (await rows<{ net: string }>(
  `SELECT COALESCE(SUM(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)), 0)::numeric(19,2)::text AS net
     FROM journal_entry_lines l
     JOIN journal_entries je ON je.id = l.journal_entry_id AND je.status = 'posted'
     JOIN accounts a ON a.id = l.account_id
    WHERE je.entity_id = $1 AND a.code = $2`,
  [f.entityId, code]
))[0].net;

/** The whole invoice collected by transfer: the collection's own lines. */
async function collect(b: Books, invoiceId: string, amount: string): Promise<string[]> {
  const paid = await recordCustomerPayment(
    { entityId: b.f.entityId, counterpartyId: b.customerId, paymentAmount: amount, paymentDate: '2026-08-31', paymentMethod: 'spei',
      applications: [{ documentId: invoiceId, amountApplied: amount }] },
    b.f.userId
  );
  return linesOf(b.f, paid.journalEntry!.id);
}

beforeAll(async () => {
  moved = await books('MNE-001-759 moved off Mexican books');
  await declare(moved, 'US', 'us_gaap');
  born = await books('MNE-001-759 born off Mexican books', { pais: 'US', moneda: 'MXN' });
  // NOTE: the fixture gives a US entity an EIN; a CFDI names its issuer by RFC, and the door
  // refuses one the entity is not a party to.
  await query(`UPDATE legal_entities SET tax_id = $1, tax_id_type = 'rfc' WHERE id = $2 AND tenant_id = $3`, [OWN_RFC, born.f.entityId, born.f.tenantId]);
}, 240_000);

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('an entity that does not keep Mexican books', () => {
  it('the invoice door credits the 1,280.00 of VAT of a sale to 2120: the treatment `cfdi post` follows', async () => {
    enterTenant(moved.f.tenantId);
    const draft = await createInvoice({
      entity_id: moved.f.entityId, customer_id: moved.customerId, invoice_date: '2026-08-20', due_date: '2026-09-19', currency_code: 'MXN',
      lines: [{ revenue_account_id: moved.f.cuentas['4100'], description: 'Consulting', quantity: '1', unit_price: '8000.00', tax_rate: '16' }],
      created_by: moved.f.userId,
    });
    const { invoice } = await issueInvoice(draft.id, moved.f.userId, { entityId: moved.f.entityId });
    expect(await linesOf(moved.f, invoice.journal_entry_id!)).toEqual(['1120 9280.0000/0', '2120 0/1280.0000', '4100 0/8000.0000']);
  }, 120_000);

  it('a PPD sale credits its VAT to 2120, and its collection strands nothing in 2125', async () => {
    const before = await owed(moved, '2125');
    const sold = await cfdiPost(moved);
    expect.soft(sold.lines).toEqual(['1120 9280.0000/0', '2120 0/1280.0000', '4100 0/8000.0000']);
    // The release asks the entity too, so the collection moves no VAT: whatever the sale parked would stay.
    expect(await collect(moved, sold.invoiceId, '9280.00')).toEqual(['1111 9280.0000/0', '1120 0/9280.0000']);
    expect(await owed(moved, '2125')).toBe(before);
  }, 120_000);

  it('a PPD sale with 640.00 of IEPS credits it to 2180 and its VAT to 2120, and nothing waits in 2181', async () => {
    const sold = await cfdiPost(moved, true);
    expect.soft(sold.lines).toEqual(['1120 9920.0000/0', '2120 0/1280.0000', '2180 0/640.0000', '4100 0/8000.0000']);
    expect(await collect(moved, sold.invoiceId, '9920.00')).toEqual(['1111 9920.0000/0', '1120 0/9920.0000']);
    expect(await owed(moved, '2181')).toBe('0.00');
  }, 120_000);

  it('seeded with the neutral chart, which has no role for parked VAT, the sale posts its VAT to 2135 instead of waiting', async () => {
    expect(born.f.roles.iva_trasladado_no_cobrado).toBeUndefined();
    const sold = await cfdiPost(born);
    expect(sold.lines).toEqual(['1120 9280.0000/0', '2135 0/1280.0000', '4100 0/8000.0000']);
  }, 120_000);

  it('seeded with the neutral chart, a sale with IEPS still waits, now for the role a cash sale needs as well', async () => {
    const entries = async () => (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM journal_entries WHERE entity_id = $1`, [born.f.entityId]))[0].n;
    const before = await entries();
    // ieps_por_pagar is a Mexican role (account-roles-seed.ts): a PUE sale with IEPS waits for it today.
    await expect(cfdiPost(born, true)).rejects.toThrow(/held and nothing was posted: Missing accounts for roles: ieps_por_pagar/);
    expect(await entries()).toBe(before);
  }, 120_000);
});

describe('an entity that keeps Mexican books', () => {
  it('a PPD sale with IEPS parks 1,280.00 in 2125 and 640.00 in 2181, as before, and its collection releases both', async () => {
    await declare(moved, 'MX', 'mx_nif');
    try {
      const sold = await cfdiPost(moved, true);
      expect(sold.lines).toEqual(['1120 9920.0000/0', '2125 0/1280.0000', '2181 0/640.0000', '4100 0/8000.0000']);
      expect(await collect(moved, sold.invoiceId, '9920.00')).toEqual([
        '1111 9920.0000/0', '1120 0/9920.0000', '2120 0/1280.0000', '2125 1280.0000/0', '2180 0/640.0000', '2181 640.0000/0',
      ]);
    } finally {
      await declare(moved, 'US', 'us_gaap');
    }
  }, 120_000);
});
