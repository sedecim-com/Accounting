import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { JournalEntryType } from '../../src/types/index.js';
import { generarAuxiliar, generarPolizas } from '../../src/services/sat/anexo24/polizas-service.js';
import type { HallazgoPoliza } from '../../src/services/sat/anexo24/polizas-invariantes.js';

// ============================================================
// MNE-001-667 (#608) · the vouchers file and both auxiliaries are deliverable
// only when the SAT's official XSD accepts them: Postgres and the real xmllint.
//
// The four cases the issue measured, each deliverable with no finding on
// develop: a voucher concept of 320 characters (the schema takes 300), a line
// concept of 250 (200), an account name of 150 (100), an RFC with month 99.
//
//   January   a bill of 1 160.00 approved with its CFDI: the valid month
//   February  a voucher concept of 320 characters · March  a line concept of 250
//   April     320 characters again, on money moved with no registered payment
//
// Synthetic data; runs as superuser like its siblings.
// ============================================================

let f: Fixture;

const AUDIT = { tipo: 'AF', numOrden: 'ABC1234567/26' } as const;
const CONCEPT_320 = 'C'.repeat(320);
const LINE_250 = 'R'.repeat(250);
const NAME_150 = 'N'.repeat(150);
const RFC_MONTH_99 = 'AAA019901AAA';
const REJECTED = ['xsd', 'blocking', '', 'anexo24.xsd.rejected'];
const NOT_VALIDATED = ['xsd', 'blocking', '', 'anexo24.xsd.not_validated'];

type File = 'vouchers' | 'accounts' | 'folios';

/** One of the three files of a month, read the same way whichever generator built it. */
async function generate(file: File, month: number) {
  const opts = { periodo: f.periodos[month], solicitud: AUDIT, generadoPor: f.userId };
  if (file === 'vouchers') {
    const p = await generarPolizas(f.entityId, opts);
    return { findings: p.hallazgos, deliverable: p.puedeEntregarse, artifact: p.artefacto, xml: p.xml };
  }
  const a = await generarAuxiliar(f.entityId, file, opts);
  return { findings: a.findings, deliverable: a.deliverable, artifact: a.artefacto, xml: a.xml };
}

const shape = (hs: readonly HallazgoPoliza[]) =>
  hs.map((h) => [h.check, h.severity, h.referencia, h.messageKey?.key]);

const archived = async (): Promise<number> =>
  (await query<{ n: number }>(`SELECT count(*)::int AS n FROM sat_anexo24_artefactos WHERE entity_id = $1`, [f.entityId]))
    .rows[0].n;

/** Runs `fn` with one value of the books changed, and puts it back. */
async function withValue<T>(table: 'accounts' | 'legal_entities', column: 'name' | 'tax_id', id: string, value: string, fn: () => Promise<T>) {
  const before = (await query<{ v: string }>(`SELECT ${column} AS v FROM ${table} WHERE id = $1`, [id])).rows[0].v;
  const write = (v: string) => query(`UPDATE ${table} SET ${column} = $1 WHERE id = $2`, [v, id]);
  await write(value);
  try {
    return await fn();
  } finally {
    await write(before);
  }
}
/** The books as each case needs them: as they are, or with the one datum the schema refuses. */
const BOOKS = {
  'as posted': <T>(fn: () => Promise<T>) => fn(),
  'account 6100 renamed': <T>(fn: () => Promise<T>) => withValue('accounts', 'name', f.cuentas['6100'], NAME_150, fn),
  'entity RFC with month 99': <T>(fn: () => Promise<T>) => withValue('legal_entities', 'tax_id', f.entityId, RFC_MONTH_99, fn),
};

/** Runs `fn` on a PATH with no xmllint, and puts the PATH back. */
async function withoutXmllint<T>(fn: () => Promise<T>): Promise<T> {
  const path = process.env.PATH;
  process.env.PATH = '/mne-001-667-no-such-directory';
  try {
    return await fn();
  } finally {
    process.env.PATH = path;
  }
}

const entry = (month: number, concept: string, line: string, debit: string) =>
  createJournalEntry(
    f.entityId,
    fechaEnPeriodo(month, 10),
    JournalEntryType.STANDARD,
    concept,
    [
      { account_id: debit, debit_amount: '7000.0000', credit_amount: null, description: line },
      { account_id: f.cuentas['4100'], debit_amount: null, credit_amount: '7000.0000', description: 'Venta' },
    ],
    f.userId,
    { autoPost: true }
  );

beforeAll(async () => {
  f = await crearInquilino('MNE-001-667 XSD gate');
  // January: a bill approved with its CFDI UUID (#318), so the folio auxiliary has a voucher to relate.
  const vendorId = uuidv4();
  const billId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,'V-667','Aceros del Norte','CCC030303CC3','rfc','MXN',$3)`,
    [vendorId, f.entityId, f.userId]
  );
  await query(
    `INSERT INTO bills (
       id, entity_id, bill_number, vendor_id, vendor_invoice_number,
       subtotal, tax_amount, total_amount, amount_due, amount_paid,
       currency_code, bill_date, due_date, status, created_by, terms, cfdi_uuid
     ) VALUES ($1,$2,'BILL-667',$3,'CFDI-667',1000,160,1160,1160,0,'MXN',$4,$4,'draft',$5,'PPD',$6)`,
    [billId, f.entityId, vendorId, fechaEnPeriodo(1), f.userId, uuidv4()]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Steel',1,1000,1000,160,1160)`,
    [uuidv4(), billId, f.cuentas['6100']]
  );
  await approveBill(billId, f.userId, { entityId: f.entityId });
  await entry(2, CONCEPT_320, 'Venta', f.cuentas['1140']);
  await entry(3, 'Venta de marzo', LINE_250, f.cuentas['1140']);
  await entry(4, CONCEPT_320, 'Venta', f.roles.banco);
}, 180_000);

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('a file its own official XSD rejects is not deliverable', () => {
  it.each([
    ['vouchers', 2, 'as posted', 'PolizasPeriodo_1_3.xsd', /Poliza', attribute 'Concepto'.*'320'.*'300'/, `Concepto="${CONCEPT_320}"`],
    ['vouchers', 3, 'as posted', 'PolizasPeriodo_1_3.xsd', /Transaccion', attribute 'Concepto'.*'250'.*'200'/, `Concepto="${LINE_250}"`],
    ['accounts', 3, 'as posted', 'AuxiliarCtas_1_3.xsd', /DetalleAux', attribute 'Concepto'.*'250'.*'200'/, `Concepto="${LINE_250}"`],
    ['vouchers', 1, 'account 6100 renamed', 'PolizasPeriodo_1_3.xsd', /Transaccion', attribute 'DesCta'.*'150'.*'100'/, `DesCta="${NAME_150}"`],
    ['accounts', 1, 'account 6100 renamed', 'AuxiliarCtas_1_3.xsd', /Cuenta', attribute 'DesCta'.*'150'.*'100'/, `DesCta="${NAME_150}"`],
    ['vouchers', 1, 'entity RFC with month 99', 'PolizasPeriodo_1_3.xsd', /Polizas', attribute 'RFC'/, `RFC="${RFC_MONTH_99}"`],
    ['accounts', 1, 'entity RFC with month 99', 'AuxiliarCtas_1_3.xsd', /AuxiliarCtas', attribute 'RFC'/, `RFC="${RFC_MONTH_99}"`],
    ['folios', 1, 'entity RFC with month 99', 'AuxiliarFolios_1_3.xsd', /RepAuxFol', attribute 'RFC'/, `RFC="${RFC_MONTH_99}"`],
  ] as const)('%s of month %i, %s: one blocking finding with the line of %s, nothing cut, nothing archived', async (file, month, books, schema, line, whole) => {
    const r = await BOOKS[books](() => generate(file, month));
    expect(shape(r.findings)).toEqual([REJECTED]);
    expect(r.findings[0].detalle).toContain(`The SAT XSD (${schema}) does not accept this file`);
    expect(r.findings[0].detalle).toMatch(line);
    expect([r.deliverable, r.artifact]).toEqual([false, null]);
    expect(r.xml).toContain(whole);
    expect(await archived()).toBe(0);
  });

  it('vouchers the hand-written checks block keep their finding, and the XSD verdict comes after it', async () => {
    const r = await generate('vouchers', 4);
    expect(r.findings.map((h) => [h.check, h.severity, h.referencia !== ''])).toEqual([
      ['poliza-con-dinero-sin-rastro', 'blocking', true],
      ['xsd', 'blocking', false],
    ]);
    expect(r.deliverable).toBe(false);
  });
});

describe('a file that could not be validated is not deliverable either', () => {
  it.each(['vouchers', 'accounts', 'folios'] as const)('%s without xmllint: the finding says so, nothing archived', async (file) => {
    const r = await withoutXmllint(() => generate(file, 1));
    expect(shape(r.findings)).toEqual([NOT_VALIDATED]);
    expect([r.deliverable, r.artifact]).toEqual([false, null]);
    expect(await archived()).toBe(0);
  });
});

describe('the three files their schemas accept', () => {
  it('are deliverable with no finding, and archived: the vouchers and both auxiliaries of January', async () => {
    for (const file of ['vouchers', 'accounts', 'folios'] as const) {
      const r = await generate(file, 1);
      expect([file, r.findings, r.deliverable, r.artifact === null]).toEqual([file, [], true, false]);
    }
    expect(await archived()).toBe(3);
  });
});
