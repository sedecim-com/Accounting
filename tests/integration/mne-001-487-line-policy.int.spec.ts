import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { getPolicy, resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';
import { registerBillCommand } from '../../src/cli/bill-command.js';
import { registerApCommand } from '../../src/cli/ap-command.js';

// ============================================================
// MNE-001-553 · #684, part 3/3 — WHERE A LINE WITH NO ACCOUNT GOES.
//
// Measured before: a received line with no account of its own, none for the
// document and no eligible suggestion was always refused, and the branch of
// the posting plan that books the classifier's expense role was unreachable.
// Now the panel key `received_line_without_account` decides: `refuse` (the
// default) keeps the refusal, `role_generic_account` posts the line to the
// account of that role. Synthetic data only.
// ============================================================

const OWN_RFC = 'XAXX010101000';
const KEY = 'received_line_without_account';

let f: Fixture;
const service = new PreRegistrationService();

/** A received PPD CFDI, one concept of 8,000.00 + 16%, with a fresh UUID. */
function cfdi(rfc: string, name: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Serie="B" Folio="${uuidv4().slice(0, 8)}" Fecha="2026-08-20T10:00:00" FormaPago="03" MetodoPago="PPD" TipoDeComprobante="I" Moneda="MXN" SubTotal="8000.00" Total="9280.00" LugarExpedicion="06600">
  <cfdi:Emisor Rfc="${rfc}" Nombre="${name}" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${OWN_RFC}" Nombre="Demo Corp MX" UsoCFDI="G03" DomicilioFiscalReceptor="06600" RegimenFiscalReceptor="601"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="80101500" ClaveUnidad="E48" Unidad="Servicio" Descripcion="Asesoria mensual" Cantidad="1" ValorUnitario="8000.00" Importe="8000.00" ObjetoImp="02"/>
  </cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="1280.00">
    <cfdi:Traslados>
      <cfdi:Traslado Base="8000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="1280.00"/>
    </cfdi:Traslados>
  </cfdi:Impuestos>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="${uuidv4().toUpperCase()}" FechaTimbrado="2026-08-20T10:05:00" RfcProvCertif="SAT970701NN3" SelloCFD="selloCFD" NoCertificadoSAT="30001000000500000001" SelloSAT="selloSAT"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;
}

/**
 * The run of part 1/3's A1: a CFDI ingested while its issuer has no vendor,
 * so its line gets no suggestion, and the vendor created afterwards.
 */
async function uncoded(rfc: string, name: string): Promise<string> {
  const r = await service.processXMLUpload(f.entityId, cfdi(rfc, name), 'manual_upload', f.userId);
  const id = r.preRegistration.id as string;
  const lines = (await query<{ lines: Array<{ account_id?: string | null; suggested_account_id: string | null }> }>(
    `SELECT lines FROM pre_registrations WHERE id = $1 AND entity_id = $2`, [id, f.entityId]
  )).rows[0].lines;
  expect(lines.map((l) => [l.account_id ?? null, l.suggested_account_id])).toEqual([[null, null]]);
  const vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1, $2, $3, $4, $5, 'rfc', 'MXN', $6)`,
    [vendorId, f.entityId, `V-${vendorId.slice(0, 8)}`, name, rfc, f.userId]
  );
  return id;
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
  registerApCommand(program, deps);
  await program.parseAsync(['node', 'mnemosine', ...argv, '--entity', f.entityId, '--tenant', f.tenantId]);
  return { exitCode, errors };
}

const run = (id: string) => cli('bill', 'inbox', 'run', id, '--yes');

async function row(id: string) {
  return (await query<{ error_message: string | null; bill_id: string | null; journal_entry_id: string | null }>(
    `SELECT error_message, bill_id, journal_entry_id FROM pre_registrations WHERE id = $1 AND entity_id = $2`,
    [id, f.entityId]
  )).rows[0];
}

async function billsOf(rfc: string): Promise<number> {
  const r = await query(
    `SELECT b.id FROM bills b JOIN vendors v ON v.id = b.vendor_id AND v.entity_id = b.entity_id
      WHERE b.entity_id = $1 AND v.tax_id = $2`,
    [f.entityId, rfc]
  );
  return r.rows.length;
}

/** What the row posted: the accounts of its bill lines, and its entry as `code debit credit`. */
async function posted(id: string): Promise<{ bill: string[]; entry: string[] }> {
  const bill = await query<{ code: string }>(
    `SELECT a.code FROM pre_registrations p
       JOIN bill_lines bl ON bl.bill_id = p.bill_id
       JOIN accounts a ON a.id = bl.account_id AND a.entity_id = p.entity_id
      WHERE p.id = $1 AND p.entity_id = $2 ORDER BY bl.line_number`,
    [id, f.entityId]
  );
  const entry = await query<{ line: string }>(
    `SELECT a.code || ' ' || COALESCE(l.debit_amount, 0)::numeric(14,2) || ' ' || COALESCE(l.credit_amount, 0)::numeric(14,2) AS line
       FROM pre_registrations p
       JOIN journal_entry_lines l ON l.journal_entry_id = p.journal_entry_id
       JOIN accounts a ON a.id = l.account_id AND a.entity_id = p.entity_id
      WHERE p.id = $1 AND p.entity_id = $2 ORDER BY a.code`,
    [id, f.entityId]
  );
  return { bill: bill.rows.map((r) => r.code), entry: entry.rows.map((r) => r.line) };
}

/** Files `value` as the entity's answer without the panel's own check of the options. */
async function store(value: string): Promise<void> {
  const r = await query(
    `UPDATE policy_decisions SET resolved_value = $3, status = 'resolved'
      WHERE tenant_id = $1 AND key = $4 AND (entity_id = $2 OR entity_id IS NULL)`,
    [f.tenantId, f.entityId, value, KEY]
  );
  expect(r.rowCount, 'the policy row was not there: the case would prove nothing').toBeGreaterThan(0);
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-553 line policy');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('MNE-001-553 · received_line_without_account', () => {
  it('C1 · with nothing answered the key reads refuse, and the run is refused as before', async () => {
    const policy = await getPolicy({ tenantId: f.tenantId, entityId: f.entityId }, KEY);
    expect([policy.value, policy.defined]).toEqual(['refuse', false]);

    const id = await uncoded('DES060101AB1', 'Emisor Desconocido del Sureste SC');
    expect((await run(id)).exitCode).toBe(1);
    expect(await row(id)).toEqual({ error_message: 'Line 1: no account assigned', bill_id: null, journal_entry_id: null });
    expect(await billsOf('DES060101AB1')).toBe(0);
  });

  it('C3 · under role_generic_account the line and the entry go to the account of the expense role', async () => {
    await resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, KEY, 'role_generic_account', f.userId);
    const id = await uncoded('GEN060101AB1', 'Transportes Genericos del Bajio SA');
    const result = await run(id);
    expect(result.exitCode, result.errors.join('\n')).toBe(0);
    expect(await posted(id)).toEqual({
      bill: ['6100'],
      entry: ['1135 1280.00 0.00', '2110 0.00 9280.00', '6100 8000.00 0.00'],
    });
    expect((await cli('ap', 'reconcile', '--strict')).exitCode).toBe(0);
  });

  it('under role_generic_account a role with no account refuses like refuse, and says why', async () => {
    const id = await uncoded('SIN060101AB1', 'Ferreteria Sinrol del Pacifico SA');
    const dropped = await query(
      `DELETE FROM account_roles WHERE entity_id = $1 AND tenant_id = $2 AND role = 'gasto'`, [f.entityId, f.tenantId]
    );
    expect(dropped.rowCount).toBeGreaterThan(0);
    expect((await run(id)).exitCode).toBe(1);
    const after = await row(id);
    expect(after.error_message).toBe(
      'Line 1: no account assigned (received_line_without_account = role_generic_account: the role gasto has no account in this entity)'
    );
    expect([after.bill_id, after.journal_entry_id]).toEqual([null, null]);
  });

  it('C4 · a stored value the system does not know refuses the run and posts nothing', async () => {
    await store('whatever');
    const id = await uncoded('RAR060101AB1', 'Papeleria Rarisima de Occidente SA');
    const stored = (await query(`SELECT * FROM pre_registrations WHERE id = $1 AND entity_id = $2`, [id, f.entityId])).rows[0];
    const failure = await service.processToAccounting(stored, f.userId).catch((e: unknown) => e);
    expect((failure as { code?: string }).code).toBe('POLICY_VALUE_UNKNOWN');

    expect((await run(id)).exitCode).toBe(1);
    const after = await row(id);
    expect(after.error_message).toContain('received_line_without_account = "whatever"');
    expect(after.error_message).toContain('refuse | role_generic_account');
    expect([after.bill_id, after.journal_entry_id]).toEqual([null, null]);
    expect(await billsOf('RAR060101AB1')).toBe(0);
  });
});
