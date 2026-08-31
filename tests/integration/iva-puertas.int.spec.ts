import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';

/**
 * LAS PUERTAS POR LAS QUE ENTRA UN GASTO, Y LA CUENTA EN QUE CAE SU IVA.
 *
 * El IVA es sobre base de flujo (LIVA art. 5-III): el de una factura a
 * crédito no es acreditable hasta pagarla. Había tres puertas de entrada y
 * sólo una aplicaba la regla:
 *
 *   1. Ingesta CON CFDI → el clasificador decide por MetodoPago. Correcta.
 *   2. Ingesta SIN CFDI → resolvía por los códigos literales '2110' y '1130'
 *      y mandaba TODO el IVA a acreditable sin mirar el método.
 *   3. El prompt del agente → le enseñaba al modelo la regla contraria.
 *
 * Esta prueba cubre la puerta 2 contra Postgres real. La 1 está en
 * tests/xml-ingestion/cfdi-posting-plan.spec.ts y la 3 en
 * tests/ai/ingest-service.spec.ts.
 */

let f: Fixture;
const servicio = new PreRegistrationService();

async function cuentaPorCodigo(code: string): Promise<string> {
  const r = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE entity_id = $1 AND code = $2`,
    [f.entityId, code]
  );
  if (r.rows.length === 0) throw new Error(`La entidad no tiene la cuenta ${code}`);
  return r.rows[0].id;
}

beforeAll(async () => {
  f = await crearInquilino('Puertas del IVA');
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

/**
 * Un pre-registro SIN documento XML: es la puerta 2, la de alta manual o
 * importación, donde no hay MetodoPago que leer.
 */
async function preRegistroSinCfdi(
  subtotal = '1000.00',
  iva = '160.00',
  notes: string | null = null
): Promise<Record<string, unknown>> {
  const total = (Number(subtotal) + Number(iva)).toFixed(2);
  const fecha = fechaEnPeriodo();
  const ref = `MAN-${uuidv4().slice(0, 8)}`;

  const vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,'Proveedor sin CFDI','BBB020202BB2','rfc','MXN',$4)`,
    [vendorId, f.entityId, `V-${ref}`, f.userId]
  );

  const lines = [
    {
      line_number: 1,
      clave_prod_serv: '01010101',
      clave_unidad: 'E48',
      descripcion: 'Servicio capturado a mano',
      cantidad: 1,
      valor_unitario: Number(subtotal),
      importe: Number(subtotal),
      suggested_account_id: await cuentaPorCodigo('6100'),
      suggested_account_confidence: 1,
      suggestion_reason: 'prueba',
    },
  ];

  const id = uuidv4();
  await query(
    `INSERT INTO pre_registrations (
       id, entity_id, source_type, document_type, vendor_id,
       external_reference, document_date, due_date, currency_code,
       subtotal, tax_amount, total_amount, lines, notes, status, created_by
     ) VALUES ($1,$2,'manual','bill',$3,$4,$5,$5,'MXN',$6,$7,$8,$9::jsonb,$10,'ready',$11)`,
    [id, f.entityId, vendorId, ref, fecha, subtotal, iva, total,
     JSON.stringify(lines), notes, f.userId]
  );

  return {
    id, entity_id: f.entityId, document_type: 'bill', vendor_id: vendorId,
    xml_document_id: null, external_reference: ref,
    document_date: fecha, due_date: fecha, currency_code: 'MXN', exchange_rate: 1,
    subtotal, tax_amount: iva, total_amount: total, lines, notes,
    default_account_id: await cuentaPorCodigo('6100'),
  };
}

/** El renglón de IVA del asiento que generó ese pre-registro. */
async function ivaDelAsiento(entryId: string): Promise<{ code: string; debit: string }> {
  const r = await query<{ code: string; debit: string }>(
    `SELECT a.code, jel.debit_amount::text AS debit
       FROM journal_entry_lines jel
       JOIN accounts a ON a.id = jel.account_id
      WHERE jel.journal_entry_id = $1 AND a.code IN ('1130','1135')`,
    [entryId]
  );
  expect(r.rows, 'el asiento debe tener exactamente un renglón de IVA').toHaveLength(1);
  return r.rows[0];
}

/**
 * El id del asiento que el servicio dice haber posteado.
 *
 * `processToAccounting` declara `journalEntry?`, así que TypeScript exige
 * comprobarlo. Se afirma en vez de silenciarlo con `!`: si algún día el
 * servicio deja de postear, estas pruebas deben fallar diciendo ESO y no
 * reventar leyendo `id` de undefined tres líneas más abajo.
 */
function asientoDe(r: { journalEntry?: Record<string, unknown> | null }): string {
  expect(r.journalEntry, 'el servicio no posteó ningún asiento').toBeTruthy();
  return (r.journalEntry as Record<string, unknown>).id as string;
}

describe('puerta 2 · alta sin CFDI', () => {
  it('sin método declarado, el IVA NO se acredita: va a pendiente (1135)', async () => {
    const preReg = await preRegistroSinCfdi();
    const r = await servicio.processToAccounting(preReg, f.userId);

    const iva = await ivaDelAsiento(asientoDe(r));
    // Éste es el defecto que se corrige: antes caía en 1130 siempre.
    expect(iva.code, 'un gasto sin método declarado se trata como PPD').toBe('1135');
    expect(Number(iva.debit)).toBeCloseTo(160, 2);
  });

  it('el supuesto queda escrito en el renglón, no sólo en el código', async () => {
    const preReg = await preRegistroSinCfdi('500.00', '80.00');
    const r = await servicio.processToAccounting(preReg, f.userId);

    const linea = await query<{ description: string }>(
      `SELECT jel.description
         FROM journal_entry_lines jel
         JOIN accounts a ON a.id = jel.account_id
        WHERE jel.journal_entry_id = $1 AND a.code = '1135'`,
      [asientoDe(r)]
    );
    expect(linea.rows[0].description).toMatch(/not yet creditable/i);
    expect(linea.rows[0].description, 'debe decir que el método se asumió').toMatch(/assumed/i);
  });

  it('si las condiciones del documento dicen que se pagó, el IVA sí se acredita', async () => {
    // La misma cascada de señales que usa AR/AP: el texto del documento es
    // una señal legítima cuando no hay CFDI que leer.
    const preReg = await preRegistroSinCfdi('2000.00', '320.00', 'Pago en una sola exhibición (PUE)');
    const r = await servicio.processToAccounting(preReg, f.userId);

    const iva = await ivaDelAsiento(asientoDe(r));
    expect(iva.code).toBe('1130');
    expect(Number(iva.debit)).toBeCloseTo(320, 2);
  });

  it('el asiento cuadra en los tres casos', async () => {
    const r = await query<{ n: string }>(
      `SELECT count(*) AS n FROM journal_entries je
        WHERE je.entity_id = $1 AND je.source_type = 'bill'
          AND (SELECT COALESCE(SUM(debit_amount),0) - COALESCE(SUM(credit_amount),0)
                 FROM journal_entry_lines WHERE journal_entry_id = je.id) <> 0`,
      [f.entityId]
    );
    expect(Number(r.rows[0].n), 'ningún asiento de gasto puede quedar descuadrado').toBe(0);
  });
});
