import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, getClient, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createBill } from '../../src/services/ap/bill-service.js';
import { recordVendorPayment } from '../../src/services/payments/payment-service.js';
import { seedPolicies, resolvePolicy, reopenPolicy } from '../../src/services/policy/policy-service.js';
import {
  PreRegistrationService,
  registrarFacturaDeBorradorAprobado,
} from '../../src/services/xml-ingestion/pre-registration-service.js';
import { construirDiot, esEntregable } from '../../src/services/sat/diot/index.js';

// ============================================================
// MNE-001-027 · #284 — THE DIOT CAN DECLARE AN EXEMPT PURCHASE.
//
// Migration 066 added `tipo_factor`, `tax_rate` and `valor_actos` to
// `bill_lines` and no writer filled them: every line stayed 'tasa' with a NULL
// rate, so the DIOT's exempt box could never be populated and
// DIOT-BASE-EXENTA-DESCONOCIDA could never fire. Each case below ingests a
// real CFDI through a real constructor and reads what reached the table and
// the DIOT. All data is synthetic.
// ============================================================

const OWN_RFC = 'XAXX010101000';
const VENDOR_RFC = 'EXM010101AA1';

let f: Fixture;
let vendorId: string;
const svc = new PreRegistrationService();

interface Concept {
  amount: string;
  transfers: string;
}

const exempt = (base: string | null) =>
  `<cfdi:Traslado${base === null ? '' : ` Base="${base}"`} Impuesto="002" TipoFactor="Exento"/>`;
const vat16 = (base: string, tax: string) =>
  `<cfdi:Traslado Base="${base}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${tax}"/>`;
const ieps8 = (base: string, tax: string) =>
  `<cfdi:Traslado Base="${base}" Impuesto="003" TipoFactor="Tasa" TasaOCuota="0.080000" Importe="${tax}"/>`;

/** A received PPD CFDI with a fresh UUID; the summary node repeats every concept transfer. */
function cfdi(month: number, concepts: Concept[], taxes: string, total: string): string {
  const subtotal = concepts.reduce((s, c) => s + Number(c.amount), 0).toFixed(2);
  const lines = concepts
    .map(
      (c, i) =>
        `<cfdi:Concepto ClaveProdServ="86121700" ClaveUnidad="E48" Descripcion="Concept ${i + 1}" Cantidad="1" ` +
        `ValorUnitario="${c.amount}" Importe="${c.amount}" ObjetoImp="02">` +
        `<cfdi:Impuestos><cfdi:Traslados>${c.transfers}</cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto>`
    )
    .join('');
  const date = `2026-${String(month).padStart(2, '0')}-10T10:00:00`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Serie="E" Folio="${uuidv4().slice(0, 6)}" Fecha="${date}" FormaPago="99" MetodoPago="PPD" TipoDeComprobante="I" Moneda="MXN" SubTotal="${subtotal}" Total="${total}" LugarExpedicion="06600">
  <cfdi:Emisor Rfc="${VENDOR_RFC}" Nombre="Exempt Services SC" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${OWN_RFC}" Nombre="Demo Corp MX" UsoCFDI="G03" DomicilioFiscalReceptor="06600" RegimenFiscalReceptor="601"/>
  <cfdi:Conceptos>${lines}</cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="${taxes}"><cfdi:Traslados>${concepts.map((c) => c.transfers).join('')}</cfdi:Traslados></cfdi:Impuestos>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="${uuidv4().toUpperCase()}" FechaTimbrado="${date}" RfcProvCertif="SAT970701NN3" SelloCFD="s" NoCertificadoSAT="30001000000500000001" SelloSAT="s"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;
}

interface LineRow {
  tipo_factor: string;
  tax_rate: string | null;
  valor_actos: string | null;
  tax_amount: string;
}

const linesOf = async (billId: string, db: { query: typeof query } = { query }): Promise<LineRow[]> =>
  (
    await db.query<LineRow>(
      `SELECT tipo_factor, tax_rate::text, valor_actos::text, tax_amount::text
         FROM bill_lines WHERE bill_id = $1 ORDER BY line_number`,
      [billId]
    )
  ).rows;

/** `bill inbox run`: upload, then the same processToAccounting the command calls. */
async function inbox(xml: string): Promise<{ billId: string; total: string }> {
  const up = await svc.processXMLUpload(f.entityId, xml, 'manual_upload', f.userId);
  const r = await svc.processToAccounting(up.preRegistration, f.userId);
  const bill = r.bill as { id: string; total_amount: string };
  return { billId: bill.id, total: bill.total_amount };
}

async function payInFull(billId: string, total: string, month: number): Promise<void> {
  await recordVendorPayment(
    {
      entityId: f.entityId,
      counterpartyId: vendorId,
      paymentAmount: total,
      paymentDate: new Date(Date.UTC(2026, month - 1, 20)),
      paymentMethod: 'spei',
      applications: [{ documentId: billId, amountApplied: total }],
    },
    f.userId
  );
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-027 exempt DIOT');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code,
       created_by, tipo_tercero, tipo_operacion, default_expense_account_id)
     VALUES ($1, $2, 'V-EXM', 'Exempt Services SC', $3, 'rfc', 'MXN', $4, '04', '85',
       (SELECT id FROM accounts WHERE entity_id = $2 AND code = '6100'))`,
    [vendorId, f.entityId, VENDOR_RFC, f.userId]
  );
}, 180_000);

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('the inbox (`bill inbox run`)', () => {
  it('an exempt concept reaches the DIOT exempt box with the base its CFDI declared', async () => {
    const month = 3;
    const { billId, total } = await inbox(
      cfdi(month, [
        { amount: '300.00', transfers: exempt('300.00') },
        { amount: '1000.00', transfers: vat16('1000.00', '160.00') },
      ], '160.00', '1460.00')
    );
    expect(await linesOf(billId)).toEqual([
      { tipo_factor: 'exento', tax_rate: null, valor_actos: '300.0000', tax_amount: '0.0000' },
      { tipo_factor: 'tasa', tax_rate: '16.00', valor_actos: '1000.0000', tax_amount: '160.0000' },
    ]);

    await payInFull(billId, total, month);
    const diot = await construirDiot({ tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: month });
    const row = diot.renglones.find((r) => r.tercero.rfc === VENDOR_RFC);
    expect(row?.desglose.exento).toEqual({ base: '300.0000', iva: '0.0000' });
    expect(row?.desglose.tasa16).toEqual({ base: '1000.0000', iva: '160.0000' });
    expect(diot.hallazgos.filter((h) => h.severidad === 'bloqueante')).toEqual([]);
  }, 90_000);

  it('an exempt concept whose CFDI omitted the Base blocks the DIOT and names the bill', async () => {
    const month = 4;
    const { billId, total } = await inbox(
      cfdi(month, [{ amount: '500.00', transfers: exempt(null) }], '0.00', '500.00')
    );
    expect(await linesOf(billId)).toEqual([
      { tipo_factor: 'exento', tax_rate: null, valor_actos: null, tax_amount: '0.0000' },
    ]);

    await payInFull(billId, total, month);
    const diot = await construirDiot({ tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: month });
    const found = diot.hallazgos.find((h) => h.codigo === 'DIOT-BASE-EXENTA-DESCONOCIDA');
    expect(found?.severidad).toBe('bloqueante');
    expect(found?.documentId).toBe(billId);
    expect(esEntregable(diot)).toBe(false);
  }, 90_000);

  it('tax_amount is only the IVA transfer, also when IEPS comes first', async () => {
    const { billId } = await inbox(
      cfdi(5, [{ amount: '1000.00', transfers: ieps8('1000.00', '80.00') + vat16('1080.00', '172.80') }],
        '252.80', '1252.80')
    );
    expect(await linesOf(billId)).toEqual([
      { tipo_factor: 'tasa', tax_rate: '16.00', valor_actos: '1080.0000', tax_amount: '172.8000' },
    ]);
  }, 90_000);
});

describe('the approval of an AI draft', () => {
  /** Runs the approval constructor in a transaction that is rolled back after reading its lines. */
  async function approve(xml: string, entry: Array<{ account_code: string; debit?: number; credit?: number }>) {
    const up = await svc.processXMLUpload(f.entityId, xml, 'manual_upload', f.userId);
    const codes = (await query<{ code: string; id: string }>(
      `SELECT code, id FROM accounts WHERE entity_id = $1`, [f.entityId]
    )).rows;
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const bill = await registrarFacturaDeBorradorAprobado(client, {
        tenantId: f.tenantId,
        entityId: f.entityId,
        preRegistrationId: String(up.preRegistration.id),
        approvedLines: entry,
        approvedDescription: 'Approved draft',
        accountIdByCode: new Map(codes.map((c) => [c.code, c.id])),
        userId: f.userId,
      });
      return await linesOf(bill.billId, client);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  it('lineas_factura_desde = poliza (the default): an all-exempt CFDI makes every line exempt', async () => {
    const lines = await approve(
      cfdi(6, [
        { amount: '400.00', transfers: exempt('400.00') },
        { amount: '300.00', transfers: exempt('300.00') },
      ], '0.00', '700.00'),
      [{ account_code: '6100', debit: 700 }, { account_code: '2110', credit: 700 }]
    );
    expect(lines).toEqual([{ tipo_factor: 'exento', tax_rate: null, valor_actos: '700.0000', tax_amount: '0.0000' }]);
  }, 90_000);

  it('lineas_factura_desde = conceptos_cfdi: each line carries its own concept regime', async () => {
    await resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, 'lineas_factura_desde', 'conceptos_cfdi', f.userId, 'test');
    try {
      const lines = await approve(
        cfdi(6, [
          { amount: '300.00', transfers: exempt('300.00') },
          { amount: '1000.00', transfers: vat16('1000.00', '160.00') },
        ], '160.00', '1460.00'),
        [
          { account_code: '6100', debit: 300 },
          { account_code: '6100', debit: 1000 },
          { account_code: '1135', debit: 160 },
          { account_code: '2110', credit: 1460 },
        ]
      );
      expect(lines).toEqual([
        { tipo_factor: 'exento', tax_rate: null, valor_actos: '300.0000', tax_amount: '0.0000' },
        { tipo_factor: 'tasa', tax_rate: '16.00', valor_actos: '1000.0000', tax_amount: '160.0000' },
      ]);
    } finally {
      await reopenPolicy({ tenantId: f.tenantId, entityId: f.entityId }, 'lineas_factura_desde');
    }
  }, 90_000);
});

describe('manual `bill create`', () => {
  it('stores the rate and the value of the acts, never NULL', async () => {
    const bill = await createBill({
      entity_id: f.entityId,
      vendor_id: vendorId,
      created_by: f.userId,
      bill_date: '2027-01-10', // its own year: the inbox numbers bills by COUNT(*)
      due_date: '2027-02-09',
      currency_code: 'MXN',
      lines: [{
        account_id: (await query<{ id: string }>(
          `SELECT id FROM accounts WHERE entity_id = $1 AND code = '6100'`, [f.entityId]
        )).rows[0].id,
        unit_price: '1000',
        tax_amount: '160',
      }],
    });
    expect(await linesOf(bill.id)).toEqual([
      { tipo_factor: 'tasa', tax_rate: '16.00', valor_actos: '1000.0000', tax_amount: '160.0000' },
    ]);
  }, 60_000);
});
