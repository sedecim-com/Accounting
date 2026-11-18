import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { importOpeningBalance } from '../../src/services/accounting/opening-balance.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';
import { registerBillCommand } from '../../src/cli/bill-command.js';
import { registerVendorCommand } from '../../src/cli/vendor-command.js';

// ============================================================
// MNE-001-487 · #684, part 1/3 — WHAT A RECEIVED CFDI'S LINE IS SUGGESTED.
//
// Measured before: an issuer with no vendor was suggested the entity's most
// frequent bill-line account, another vendor's history; after a migration
// that account is 2110, where every opening payable sits, and `bill inbox
// run` posted the expense to the payable itself. Now a control account is
// never suggested, and an issuer with no vendor gets no history at all.
// Which account posts is part 2/3. Synthetic data only.
// ============================================================

const OWN_RFC = 'XAXX010101000';
const SAT = 'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion';
const CONSULTING = '80101500';

interface Concept { key?: string; text: string }
interface Line { suggested_account_id: string | null; suggestion_reason: string }

let f: Fixture;
let sister: Fixture;
const service = new PreRegistrationService();

/** A received CFDI, one concept of 8,000.00 + 16% each, with a fresh UUID. */
function cfdi(rfc: string, name: string, concepts: Concept[]): string {
  const subtotal = (8000 * concepts.length).toFixed(2);
  const vat = (1280 * concepts.length).toFixed(2);
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Serie="B" Folio="${uuidv4().slice(0, 8)}" Fecha="2026-08-20T10:00:00" FormaPago="03" MetodoPago="PPD" TipoDeComprobante="I" Moneda="MXN" SubTotal="${subtotal}" Total="${(Number(subtotal) + Number(vat)).toFixed(2)}" LugarExpedicion="06600">
  <cfdi:Emisor Rfc="${rfc}" Nombre="${name}" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${OWN_RFC}" Nombre="Demo Corp MX" UsoCFDI="G03" DomicilioFiscalReceptor="06600" RegimenFiscalReceptor="601"/>
  <cfdi:Conceptos>${concepts.map((c) => `
    <cfdi:Concepto ClaveProdServ="${c.key ?? CONSULTING}" ClaveUnidad="E48" Unidad="Servicio" Descripcion="${c.text}" Cantidad="1" ValorUnitario="8000.00" Importe="8000.00" ObjetoImp="02"/>`).join('')}
  </cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="${vat}">
    <cfdi:Traslados>
      <cfdi:Traslado Base="${subtotal}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${vat}"/>
    </cfdi:Traslados>
  </cfdi:Impuestos>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="${uuidv4().toUpperCase()}" FechaTimbrado="2026-08-20T10:05:00" RfcProvCertif="SAT970701NN3" SelloCFD="selloCFD" NoCertificadoSAT="30001000000500000001" SelloSAT="selloSAT"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;
}

/** Ingests the CFDI and returns its inbox row: the id and the lines as stored. */
async function received(
  on: Fixture, rfc: string, name: string, ...concepts: Concept[]
): Promise<{ id: string; lines: Line[] }> {
  const r = await service.processXMLUpload(on.entityId, cfdi(rfc, name, concepts), 'manual_upload', on.userId);
  const id = r.preRegistration.id as string;
  const row = await query<{ lines: Line[] }>(
    `SELECT lines FROM pre_registrations WHERE id = $1 AND entity_id = $2`, [id, on.entityId]
  );
  return { id, lines: row.rows[0].lines };
}

async function vendor(on: Fixture, rfc: string, name: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1, $2, $3, $4, $5, 'rfc', 'MXN', $6)`,
    [id, on.entityId, `V-${id.slice(0, 8)}`, name, rfc, on.userId]
  );
  return id;
}

/** A typed bill of the vendor, one line on each account, as `bill create` leaves it. */
async function typedBill(on: Fixture, vendorId: string, accountIds: string[], text = 'Typed by hand'): Promise<void> {
  const id = uuidv4();
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, vendor_invoice_number, subtotal, tax_amount,
       total_amount, amount_due, amount_paid, currency_code, bill_date, due_date, status, created_by)
     VALUES ($1,$2,$3,$4,$3,100,0,100,100,0,'MXN','2026-03-10','2026-04-09','draft',$5)`,
    [id, on.entityId, `BILL-${id.slice(0, 8)}`, vendorId, on.userId]
  );
  for (const [i, accountId] of accountIds.entries()) {
    await query(
      `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price,
         line_amount, tax_amount, total_amount)
       VALUES ($1,$2,$3,$4,$5,1,100,100,0,100)`,
      [uuidv4(), id, i + 1, accountId, text]
    );
  }
}

/** A postable account the seeded chart does not have, with no role on it. */
async function account(on: Fixture, code: string, flags: { manual?: boolean; control?: boolean } = {}): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO accounts (id, code, name, account_type, normal_balance, entity_id, created_by,
       allow_manual_entries, is_control_account)
     VALUES ($1, $2, $3, 'expense', 'debit', $4, $5, $6, $7)`,
    [id, code, `Account ${code}`, on.entityId, on.userId, flags.manual ?? true, flags.control ?? false]
  );
  return id;
}

async function satMapping(on: Fixture, key: string, accountId: string): Promise<void> {
  await query(
    `INSERT INTO sat_code_mappings (id, entity_id, sat_code, account_id, confidence) VALUES ($1, $2, $3, $4, 0.8)`,
    [uuidv4(), on.entityId, key, accountId]
  );
}

async function cli(...argv: string[]): Promise<{ exitCode?: number; errors: string[] }> {
  const program = new Command('mnemosine').exitOverride();
  let exitCode: number | undefined;
  const errors: string[] = [];
  const id = (s: string) => s;
  const deps = {
    palette: { dim: id, bold: id, cyan: id, red: id, green: id, yellow: id } as never,
    shutdown: (c: number) => { exitCode = c; },
    reportError: (e: unknown) => { errors.push(String((e as Error)?.message ?? e)); },
    confirm: () => Promise.resolve(true),
  };
  registerBillCommand(program, deps);
  registerVendorCommand(program, deps);
  // The sister entity brings a second user to the tenant, so the reviewer is named.
  const email = (await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [f.userId])).rows[0].email;
  await program.parseAsync(['node', 'mnemosine', ...argv, '--entity', f.entityId, '--tenant', f.tenantId, '--user', email]);
  return { exitCode, errors };
}

const none = { suggested_account_id: null, suggestion_reason: 'no_match' };

beforeAll(async () => {
  f = await crearInquilino('MNE-001-487 suggestions');
  sister = await crearEntidadHermana(f, 'MNE-001-487 the other entity');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('MNE-001-487 · what a received line is suggested', () => {
  it('A1 · an issuer with no vendor gets no other vendor\'s history, and its run is refused', async () => {
    const text = 'Flete terrestre de mercancia a Monterrey';
    await typedBill(f, await vendor(f, 'OTR060101AB1', 'Otro Proveedor Ajeno SA'), [f.cuentas['6200']], text);

    const row = await received(f, 'DES060101AB1', 'Emisor Desconocido del Sureste SC', { text });
    expect(row.lines[0]).toMatchObject(none);

    const created = await cli('vendor', 'create', 'Emisor Desconocido del Sureste SC', '--tax-id', 'DES060101AB1');
    expect(created.exitCode, created.errors.join('\n')).toBe(0);
    const run = await cli('bill', 'inbox', 'run', row.id, '--yes');
    expect(run.exitCode).toBe(1);
    const after = (await query<{ error_message: string; bill_id: string | null; journal_entry_id: string | null }>(
      `SELECT error_message, bill_id, journal_entry_id FROM pre_registrations WHERE id = $1 AND entity_id = $2`,
      [row.id, f.entityId]
    )).rows[0];
    expect(after).toEqual({ error_message: 'Line 1: no account assigned', bill_id: null, journal_entry_id: null });
    const bills = await query(
      `SELECT b.id FROM bills b JOIN vendors v ON v.id = b.vendor_id AND v.entity_id = b.entity_id
        WHERE b.entity_id = $1 AND v.tax_id = 'DES060101AB1'`,
      [f.entityId]
    );
    expect(bills.rows).toHaveLength(0);
  });

  it('A2 · opening payables on 2110 are not a history; a typed bill on 6200 is', async () => {
    const rows: Array<[string, string]> = [
      ['1000', '100640.00'], ['1100', '100640.00'], ['1110', '100000.00'], ['1111', '100000.00'],
      ['1135', '640.00'], ['2000', '4640.00'], ['2100', '4640.00'], ['2110', '4640.00'],
      ['3000', '96000.00'], ['3100', '96000.00'],
    ];
    const xml = `<?xml version="1.0" encoding="UTF-8"?><BCE:Balanza xmlns:BCE="${SAT}" Version="1.3" ` +
      `RFC="${OWN_RFC}" Mes="12" Anio="2025" TipoEnvio="N">` +
      rows.map(([n, s]) => `<BCE:Ctas NumCta="${n}" SaldoIni="${s}" Debe="0.00" Haber="0.00" SaldoFin="${s}"/>`).join('') +
      '</BCE:Balanza>';
    const payable = (doc: string) => ({
      cuenta: '2110', documento: doc, contraparte: 'Servicios Logisticos del Norte SA de CV', rfc: 'SLN060101AB1',
      fecha: '2025-12-12', vencimiento: '2026-01-11', importe: '2320.00', ivaRate: '0.16',
    });
    const loaded = await importOpeningBalance({ tenantId: f.tenantId, entityId: f.entityId }, {
      entityId: f.entityId, xml, userId: f.userId, documentos: [payable('F-2025-881'), payable('F-2025-882')],
    });
    expect(loaded.escrito).toBe(true);
    expect(loaded.apBills).toBe(2);
    const sln = (await query<{ id: string }>(
      `SELECT id FROM vendors WHERE entity_id = $1 AND tax_id = 'SLN060101AB1'`, [f.entityId]
    )).rows[0].id;
    const onControl = await query(
      `SELECT bl.id FROM bill_lines bl JOIN bills b ON b.id = bl.bill_id
        WHERE b.entity_id = $1 AND b.vendor_id = $2 AND bl.account_id = $3`,
      [f.entityId, sln, f.cuentas['2110']]
    );
    expect(onControl.rows).toHaveLength(2);

    const name = 'Servicios Logisticos del Norte SA de CV';
    const before = await received(f, 'SLN060101AB1', name, { text: 'Maniobras de carga y descarga en almacen' });
    expect(before.lines[0]).toMatchObject(none);

    await typedBill(f, sln, [f.cuentas['6200']]);
    const after = await received(f, 'SLN060101AB1', name, { text: 'Maniobras de carga y descarga en almacen' });
    expect(after.lines[0]).toMatchObject({ suggested_account_id: f.cuentas['6200'], suggestion_reason: 'historical_pattern' });
  });

  it('A3 · no control account is suggested, from the history, a vendor default or a SAT mapping', async () => {
    const bankGl = await account(f, '1119');
    await query(
      `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code)
       VALUES ($1, $2, 'Operating', 'Banco Sintetico', $3, 'MXN')`,
      [uuidv4(), f.entityId, bankGl]
    );
    const closed = await account(f, '6901', { manual: false });
    const flagged = await account(f, '6902', { control: true });
    const v = await vendor(f, 'CTL060101AB1', 'Papeleria Controlada del Centro SA');
    await typedBill(f, v, [f.cuentas['2110'], f.cuentas['1130'], bankGl, closed, flagged]);
    const name = 'Papeleria Controlada del Centro SA';
    const concept = { key: '44121600', text: 'Articulos de papeleria para oficina' };

    expect((await received(f, 'CTL060101AB1', name, concept)).lines[0]).toMatchObject(none);

    await query(
      `UPDATE vendors SET default_expense_account_id = $3 WHERE id = $1 AND entity_id = $2`,
      [v, f.entityId, f.cuentas['2110']]
    );
    expect((await received(f, 'CTL060101AB1', name, concept)).lines[0]).toMatchObject(none);

    await satMapping(f, '44121600', f.cuentas['2110']);
    expect((await received(f, 'CTL060101AB1', name, concept)).lines[0]).toMatchObject(none);

    // A refused default and a refused mapping do not end the search: the history still speaks.
    await typedBill(f, v, [f.cuentas['6200']]);
    expect((await received(f, 'CTL060101AB1', name, concept)).lines[0])
      .toMatchObject({ suggested_account_id: f.cuentas['6200'], suggestion_reason: 'historical_pattern' });
  });

  it('A4 · an expense account stays suggestible: 6100, and 6310 for a bank as a vendor', async () => {
    await typedBill(f, await vendor(f, 'ADM060101AB1', 'Despacho Administrativo Uno SC'), [f.cuentas['6100']]);
    expect((await received(f, 'ADM060101AB1', 'Despacho Administrativo Uno SC', { text: 'Honorarios de gestoria mensual' })).lines[0])
      .toMatchObject({ suggested_account_id: f.cuentas['6100'], suggestion_reason: 'historical_pattern' });

    await typedBill(f, await vendor(f, 'BNA060101AB1', 'Banco Nacional Sintetico SA'), [f.cuentas['6310']]);
    expect((await received(f, 'BNA060101AB1', 'Banco Nacional Sintetico SA', { text: 'Comision por manejo de cuenta' })).lines[0])
      .toMatchObject({ suggested_account_id: f.cuentas['6310'], suggestion_reason: 'historical_pattern' });
  });

  it('A5 · edges: no cxp role row, a fuzzy name match, another entity, and a tie', async () => {
    // The sister entity, same tenant, loses its cxp role row: 2110 is still refused by its legacy code.
    await query(`DELETE FROM account_roles WHERE entity_id = $1 AND tenant_id = $2 AND role = 'cxp'`, [sister.entityId, sister.tenantId]);
    const theirs = await vendor(sister, 'HER060101AB1', 'Refacciones Hermanas del Valle SA');
    await typedBill(sister, theirs, [sister.cuentas['2110']]);
    expect((await received(sister, 'HER060101AB1', 'Refacciones Hermanas del Valle SA', { text: 'Refacciones para montacargas' })).lines[0])
      .toMatchObject(none);

    // Its bills are never read from this entity, even for the same RFC and the same words.
    await typedBill(sister, theirs, [sister.cuentas['6200']], 'Refacciones para montacargas');
    await vendor(f, 'HER060101AB1', 'Refacciones Hermanas del Valle SA');
    expect((await received(f, 'HER060101AB1', 'Refacciones Hermanas del Valle SA', { text: 'Refacciones para montacargas' })).lines[0])
      .toMatchObject(none);

    // A name over 0.7 of similarity, with another RFC, is that vendor: it gets its own history.
    await typedBill(f, await vendor(f, 'TRG060101AB1', 'Transportes Rapidos del Golfo SA de CV'), [f.cuentas['6200']]);
    expect((await received(f, 'TRG990909ZZ9', 'Transportes Rapidos del Golfo SA de CV', { text: 'Traslado de maquinaria pesada' })).lines[0])
      .toMatchObject({ suggested_account_id: f.cuentas['6200'], suggestion_reason: 'historical_pattern' });

    // Tied on frequency: the lower code, and the same answer twice.
    await typedBill(f, await vendor(f, 'EMP060101AB1', 'Empates Frecuentes del Bajio SA'), [f.cuentas['6200'], f.cuentas['6100']]);
    for (let i = 0; i < 2; i++) {
      expect((await received(f, 'EMP060101AB1', 'Empates Frecuentes del Bajio SA', { text: 'Mantenimiento de aire acondicionado' })).lines[0])
        .toMatchObject({ suggested_account_id: f.cuentas['6100'], suggestion_reason: 'historical_pattern' });
    }
  });

  it('A6 · two concepts in one CFDI: each line is judged alone', async () => {
    await typedBill(f, await vendor(f, 'DOS060101AB1', 'Suministros Dobles de Occidente SA'), [f.cuentas['6200']]);
    await satMapping(f, '43211500', f.cuentas['6100']);
    await satMapping(f, '26111700', f.cuentas['2110']);
    const row = await received(f, 'DOS060101AB1', 'Suministros Dobles de Occidente SA',
      { key: '43211500', text: 'Equipo de computo portatil' }, { key: '26111700', text: 'Baterias de respaldo' });
    expect(row.lines[0]).toMatchObject({ suggested_account_id: f.cuentas['6100'], suggestion_reason: 'sat_code_mapping' });
    expect(row.lines[1]).toMatchObject({ suggested_account_id: f.cuentas['6200'], suggestion_reason: 'historical_pattern' });
  });
});
