import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe } from './helpers/servidor.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';
import xmlIngestionRouter from '../../src/api/rest/routes/xml-ingestion.js';
import { registerBillCommand } from '../../src/cli/bill-command.js';
import { registerApCommand } from '../../src/cli/ap-command.js';

// ============================================================
// MNE-001-552 · #684, part 2/3 — WHICH ACCOUNT A RECEIVED LINE POSTS TO.
//
// Measured before: a line's suggestion beat the account a person gave the
// whole document, so `bill inbox edit --account 6200` on a line suggested
// 6100 posted to 6100; and a row suggested 2110 before part 1/3 still posted
// its expense to the payable. Now the line's own account posts, then the
// document's, and a suggestion only while it is eligible. Synthetic data only.
// ============================================================

const OWN_RFC = 'XAXX010101000';

let f: Fixture;
const service = new PreRegistrationService();

/** A received PPD CFDI of `concepts` concepts, 8,000.00 + 16% each, with a fresh UUID. */
function cfdi(rfc: string, concepts: number, name: string): string {
  const subtotal = (8000 * concepts).toFixed(2);
  const vat = (1280 * concepts).toFixed(2);
  const concept = '<cfdi:Concepto ClaveProdServ="80101500" ClaveUnidad="E48" Unidad="Servicio" ' +
    'Descripcion="Asesoria mensual" Cantidad="1" ValorUnitario="8000.00" Importe="8000.00" ObjetoImp="02"/>';
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Serie="B" Folio="${uuidv4().slice(0, 8)}" Fecha="2026-08-20T10:00:00" FormaPago="03" MetodoPago="PPD" TipoDeComprobante="I" Moneda="MXN" SubTotal="${subtotal}" Total="${(Number(subtotal) + Number(vat)).toFixed(2)}" LugarExpedicion="06600">
  <cfdi:Emisor Rfc="${rfc}" Nombre="${name}" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${OWN_RFC}" Nombre="Demo Corp MX" UsoCFDI="G03" DomicilioFiscalReceptor="06600" RegimenFiscalReceptor="601"/>
  <cfdi:Conceptos>${concept.repeat(concepts)}</cfdi:Conceptos>
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

/**
 * A vendor, optionally with a typed bill on `history` (so its lines are
 * suggested that account), and one CFDI of it in the inbox. `stale` rewrites
 * line 1 as a row ingested before part 1/3 has it: suggested a control account.
 */
async function received(
  rfc: string, opts: { history?: string; concepts?: number; stale?: string; vendor?: boolean } = {}
): Promise<string> {
  const vendorId = uuidv4();
  if (opts.vendor !== false) {
    await query(
      `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
       VALUES ($1, $2, $3, $4, $5, 'rfc', 'MXN', $6)`,
      [vendorId, f.entityId, `V-${vendorId.slice(0, 8)}`, `Emisor ${rfc}`, rfc, f.userId]
    );
  }
  if (opts.history) {
    const billId = uuidv4();
    await query(
      `INSERT INTO bills (id, entity_id, bill_number, vendor_id, vendor_invoice_number, subtotal, tax_amount,
         total_amount, amount_due, amount_paid, currency_code, bill_date, due_date, status, created_by)
       VALUES ($1,$2,$3,$4,$3,100,0,100,100,0,'MXN','2026-03-10','2026-04-09','draft',$5)`,
      [billId, f.entityId, `BILL-${billId.slice(0, 8)}`, vendorId, f.userId]
    );
    await query(
      `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price,
         line_amount, tax_amount, total_amount)
       VALUES ($1,$2,1,$3,'Typed by hand',1,100,100,0,100)`,
      [uuidv4(), billId, f.cuentas[opts.history]]
    );
  }
  // An unknown issuer carries a name no vendor resembles: the fuzzy match would adopt it.
  const name = opts.vendor === false ? 'Despacho Desconocido del Sureste SC' : `Emisor ${rfc}`;
  const r = await service.processXMLUpload(f.entityId, cfdi(rfc, opts.concepts ?? 1, name), 'manual_upload', f.userId);
  const id = r.preRegistration.id as string;
  if (opts.stale) {
    await query(
      `UPDATE pre_registrations
          SET lines = jsonb_set(jsonb_set(lines, '{0,suggested_account_id}', to_jsonb($3::text)),
                                '{0,suggestion_reason}', '"historical_pattern"')
        WHERE id = $1 AND entity_id = $2`,
      [id, f.entityId, f.cuentas[opts.stale]]
    );
  }
  return id;
}

async function cli(...argv: string[]): Promise<{ exitCode?: number; out: string }> {
  const program = new Command('mnemosine').exitOverride();
  let exitCode: number | undefined;
  const id = (s: string) => s;
  const deps = {
    palette: { dim: id, bold: id, cyan: id, red: id, green: id, yellow: id } as never,
    shutdown: (c: number) => { exitCode = c; },
    reportError: () => undefined,
    confirm: () => Promise.resolve(true),
  };
  registerBillCommand(program, deps);
  registerApCommand(program, deps);
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string | Uint8Array) => { chunks.push(String(c)); return true; }) as typeof process.stdout.write;
  try {
    await program.parseAsync(['node', 'mnemosine', ...argv, '--entity', f.entityId, '--tenant', f.tenantId]);
  } finally {
    process.stdout.write = write;
  }
  return { exitCode, out: chunks.join('') };
}

const edit = (id: string, ...argv: string[]) => cli('bill', 'inbox', 'edit', id, ...argv);
const run = (id: string) => cli('bill', 'inbox', 'run', id, '--yes');

async function row(id: string) {
  return (await query<{ status: string; error_message: string | null; bill_id: string | null; lines: string }>(
    `SELECT status, error_message, bill_id, lines::text AS lines FROM pre_registrations WHERE id = $1 AND entity_id = $2`,
    [id, f.entityId]
  )).rows[0];
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

const on = (code: string) => ({
  bill: [code],
  entry: ['1135 1280.00 0.00', '2110 0.00 9280.00', `${code} 8000.00 0.00`].sort(),
});

beforeAll(async () => {
  f = await crearInquilino('MNE-001-552 line account');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('MNE-001-552 · which account a received line posts to', () => {
  it('B1 · an account for the whole document posts every uncoded line, and AP ties', async () => {
    const id = await received('SLN060101AB1');
    expect((await edit(id, '--account', '6100')).exitCode).toBe(0);
    expect((await run(id)).exitCode).toBe(0);
    expect(await posted(id)).toEqual(on('6100'));
    expect((await cli('ap', 'reconcile', '--strict')).exitCode).toBe(0);
  });

  it('B2 · the account a person gives the document beats a suggestion', async () => {
    const id = await received('BDO060101AB1', { history: '6100' });
    expect((await row(id)).lines).toContain(`"suggested_account_id": "${f.cuentas['6100']}"`);
    expect((await edit(id, '--account', '6200')).out).toContain('0 line(s) still without an account');
    expect((await run(id)).exitCode).toBe(0);
    expect(await posted(id)).toEqual(on('6200'));
  });

  it('an eligible suggestion still posts a line nobody coded', async () => {
    const id = await received('BEL060101AB1', { history: '6200' });
    expect((await run(id)).exitCode).toBe(0);
    expect(await posted(id)).toEqual(on('6200'));
  });

  it('B3 · through REST too: a PATCHed default_account_id beats a suggestion', async () => {
    const id = await received('BTR060101AB1', { history: '6100' });
    const s = await levantar([['/v1', xmlIngestionRouter]], sesionDe(f));
    try {
      const patched = await pedir(s, 'PATCH', `/v1/pre-registrations/${id}`, { default_account_id: f.cuentas['6200'] });
      expect(patched.status).toBe(200);
      expect((await pedir(s, 'POST', `/v1/pre-registrations/${id}/process`, {})).status).toBe(200);
    } finally {
      await s.cerrar();
    }
    expect(await posted(id)).toEqual(on('6200'));
  });

  it('B4 · the line\'s own account, from --line or from a rule, beats a later document account', async () => {
    const byHand = await received('BCU060101AB1');
    await edit(byHand, '--line', '1', '--account', '6100');
    await edit(byHand, '--account', '6200');
    expect((await run(byHand)).exitCode).toBe(0);
    expect(await posted(byHand)).toEqual(on('6100'));

    const rule = (rfc: string, ...then: string[]) => cli(
      'bill', 'rule', 'create', '--name', `Rule ${rfc}`, '--when', `emisor_rfc equals ${rfc}`,
      '--then', 'set_account=6100', ...then
    );
    expect((await rule('BRE060101AB1')).exitCode).toBe(0);
    const byRule = await received('BRE060101AB1');
    await edit(byRule, '--account', '6200');
    expect((await run(byRule)).exitCode).toBe(0);
    expect(await posted(byRule)).toEqual(on('6100'));

    expect((await rule('BAU060101AB1', '--then', 'set_processing_mode=auto')).exitCode).toBe(0);
    const atIngestion = await received('BAU060101AB1');
    expect((await row(atIngestion)).status).toBe('completed');
    expect(await posted(atIngestion)).toEqual(on('6100'));
  });

  it('B5 · a row suggested 2110 before part 1/3 is refused, untouched, and posts once coded', async () => {
    const id = await received('BVI060101AB1', { stale: '2110' });
    const before = await row(id);
    expect((await run(id)).exitCode).toBe(1);
    expect(await row(id)).toEqual({
      status: 'error', error_message: 'Line 1: no account assigned', bill_id: null, lines: before.lines,
    });
    await edit(id, '--line', '1', '--account', '6100');
    expect((await run(id)).exitCode).toBe(0);
    expect(await posted(id)).toEqual(on('6100'));
  });

  it('B6 · an unknown issuer without --allow-new-vendor still waits for a person (exit 11)', async () => {
    const id = await received('BDE060101AB1', { vendor: false, stale: '2110' });
    expect((await run(id)).exitCode).toBe(11);
    expect((await row(id)).bill_id).toBeNull();
  });

  it('B7 · the summary does not count a control-account suggestion as an account', async () => {
    const id = await received('BSU060101AB1', { concepts: 2, stale: '2110' });
    expect((await edit(id, '--line', '2', '--account', '6100')).out).toContain('1 line(s) still without an account');
  });
});
