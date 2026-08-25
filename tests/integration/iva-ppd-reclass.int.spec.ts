import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, saldoDe, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { censarIvaPpd, reclasificarIvaPpd } from '../../src/services/accounting/iva-ppd-reclass.js';
import { JournalEntryType } from '../../src/types/index.js';

/**
 * LA REPARACIÓN DEL IVA YA MAL ACREDITADO.
 *
 * Fabrica el daño exactamente como lo producía la ruta vieja —una factura
 * PPD cuyo IVA fue a «IVA Acreditable»— y comprueba que el censo lo
 * encuentra, que la reclasificación lo mueve a «IVA Pendiente de
 * Acreditar», y que correrla dos veces no duplica nada.
 */

let f: Fixture;
let cuentaAcreditable: string;
let cuentaPendiente: string;
/** El periodo en que caen los asientos de prueba, leído del propio asiento. */
let periodo: string;

async function cuentaPorCodigo(code: string): Promise<string> {
  const r = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE entity_id = $1 AND code = $2`,
    [f.entityId, code]
  );
  if (r.rows.length === 0) throw new Error(`La entidad no tiene la cuenta ${code}`);
  return r.rows[0].id;
}

beforeAll(async () => {
  f = await crearInquilino('Reclasificación IVA');
  cuentaAcreditable = await cuentaPorCodigo('1130');
  cuentaPendiente = await cuentaPorCodigo('1135');
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

/**
 * Reproduce el daño: un CFDI PPD, su factura, y el asiento con el IVA en la
 * cuenta equivocada. Es la forma que tenían los registros antes del arreglo.
 */
async function facturaPpdMalAcreditada(
  subtotal = '1000.00',
  iva = '160.00',
  metodoPago = 'PPD'
): Promise<{ entryId: string; uuid: string; periodId: string }> {
  const cfdiUuid = uuidv4().toUpperCase();
  const xmlId = uuidv4();
  const billId = uuidv4();
  const total = (Number(subtotal) + Number(iva)).toFixed(2);
  const fecha = fechaEnPeriodo();

  await query(
    `INSERT INTO xml_documents (
       id, entity_id, document_type, cfdi_uuid, cfdi_version, cfdi_fecha,
       emisor_rfc, receptor_rfc, import_source,
       subtotal, total, metodo_pago, xml_content, xml_hash, processing_status
     ) VALUES ($1,$2,'cfdi_ingreso',$3,'4.0',$4,'AAA010101AAA','XAXX010101000','manual_upload',$5,$6,$7,'<xml/>',$8,'completed')`,
    [xmlId, f.entityId, cfdiUuid, fecha, subtotal, total, metodoPago, uuidv4().replace(/-/g, '')]
  );

  const proveedor = await query<{ id: string }>(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,'Proveedor PPD','AAA010101AAA','rfc','MXN',$4)
     ON CONFLICT DO NOTHING RETURNING id`,
    [uuidv4(), f.entityId, `V-${cfdiUuid.slice(0, 8)}`, f.userId]
  );
  const vendorId =
    proveedor.rows[0]?.id ??
    (await query<{ id: string }>(`SELECT id FROM vendors WHERE entity_id = $1 LIMIT 1`, [f.entityId]))
      .rows[0].id;

  await query(
    `INSERT INTO bills (
       id, entity_id, bill_number, vendor_id, vendor_invoice_number,
       subtotal, tax_amount, total_amount, amount_due,
       currency_code, bill_date, due_date, status, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,'MXN',$9,$9,'posted',$10)`,
    [billId, f.entityId, `BILL-${cfdiUuid.slice(0, 8)}`, vendorId, cfdiUuid,
     subtotal, iva, total, fecha, f.userId]
  );

  await query(
    `INSERT INTO pre_registrations (
       id, entity_id, xml_document_id, source_type, document_type, vendor_id, bill_id,
       external_reference, document_date, subtotal, tax_amount, total_amount,
       lines, status, created_by
     ) VALUES ($1,$2,$3,'xml_cfdi','bill',$4,$5,$6,$7,$8,$9,$10,'[]'::jsonb,'completed',$11)`,
    [uuidv4(), f.entityId, xmlId, vendorId, billId, cfdiUuid, fecha,
     subtotal, iva, total, f.userId]
  );

  // El asiento tal como lo producía la ruta vieja: TODO el IVA a 1130.
  const asiento = await createJournalEntry(
    f.entityId, fecha, JournalEntryType.AUTO_INVOICE,
    `Bill ${cfdiUuid.slice(0, 8)} (ruta vieja)`,
    [
      { account_id: f.roles.gasto ?? (await cuentaPorCodigo('6100')), debit_amount: subtotal, credit_amount: null, description: 'Gasto' },
      { account_id: cuentaAcreditable, debit_amount: iva, credit_amount: null, description: 'IVA Acreditable' },
      { account_id: await cuentaPorCodigo('2110'), debit_amount: null, credit_amount: total, description: 'Proveedores' },
    ],
    f.userId,
    { autoPost: true, sourceType: 'bill', sourceId: billId }
  );

  return { entryId: asiento.id, uuid: cfdiUuid, periodId: asiento.fiscal_period_id };
}

describe('censo del IVA PPD acreditado antes de tiempo', () => {
  it('encuentra la factura PPD y no la PUE', async () => {
    const ppd = await facturaPpdMalAcreditada();
    periodo = ppd.periodId;
    await facturaPpdMalAcreditada('500.00', '80.00', 'PUE');

    const hallazgos = await censarIvaPpd(f.tenantId, f.entityId);
    const ids = hallazgos.map((h) => h.entry_id);
    expect(ids).toContain(ppd.entryId);
    // La PUE está bien registrada: acreditar su IVA al recibir la factura
    // es lo correcto y no debe aparecer en el censo.
    expect(hallazgos).toHaveLength(1);
    expect(hallazgos[0].importe).toBe('160.0000');
    expect(hallazgos[0].cuenta_acreditable_code).toBe('1130');
    expect(hallazgos[0].cuenta_pendiente_code).toBe('1135');
  });

  it('el censo no escribe nada', async () => {
    const antes = await query<{ n: string }>(
      `SELECT count(*) AS n FROM journal_entries WHERE entity_id = $1`, [f.entityId]
    );
    await censarIvaPpd(f.tenantId, f.entityId);
    const despues = await query<{ n: string }>(
      `SELECT count(*) AS n FROM journal_entries WHERE entity_id = $1`, [f.entityId]
    );
    expect(despues.rows[0].n).toBe(antes.rows[0].n);
  });
});

describe('la reclasificación mueve el saldo, no lo inventa', () => {
  it('el IVA sale de acreditable y entra en pendiente, por el mismo importe', async () => {
    const acreditableAntes = await saldoDe(cuentaAcreditable, periodo);
    const pendienteAntes = await saldoDe(cuentaPendiente, periodo);

    const hallazgos = await censarIvaPpd(f.tenantId, f.entityId);
    const r = await reclasificarIvaPpd(hallazgos, f.userId);

    expect(r.fallos).toEqual([]);
    expect(r.reclasificados).toBe(hallazgos.length);
    expect(r.montoReclasificado).toBeCloseTo(160, 2);

    const acreditableDespues = await saldoDe(cuentaAcreditable, periodo);
    const pendienteDespues = await saldoDe(cuentaPendiente, periodo);

    expect(acreditableDespues).toBeCloseTo(acreditableAntes - 160, 2);
    expect(pendienteDespues).toBeCloseTo(pendienteAntes + 160, 2);
    // El total no cambia: es una reclasificación, no un ajuste.
    expect(acreditableDespues + pendienteDespues).toBeCloseTo(
      acreditableAntes + pendienteAntes, 2
    );
  });

  it('el asiento de corrección queda unido al que corrige', async () => {
    const r = await query<{ source_id: string; entry_type: string; status: string }>(
      `SELECT source_id, entry_type, status FROM journal_entries
        WHERE entity_id = $1 AND source_type = 'iva_reclass'`,
      [f.entityId]
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].entry_type).toBe('correction');
    expect(r.rows[0].status).toBe('posted');

    const original = await query<{ entry_number: string }>(
      `SELECT entry_number FROM journal_entries WHERE id = $1`, [r.rows[0].source_id]
    );
    expect(original.rows).toHaveLength(1);
  });

  it('correrlo dos veces no duplica: el censo ya no lo lista', async () => {
    const hallazgos = await censarIvaPpd(f.tenantId, f.entityId);
    expect(hallazgos).toEqual([]);

    const r = await reclasificarIvaPpd(hallazgos, f.userId);
    expect(r.reclasificados).toBe(0);

    const correcciones = await query<{ n: string }>(
      `SELECT count(*) AS n FROM journal_entries WHERE entity_id = $1 AND source_type = 'iva_reclass'`,
      [f.entityId]
    );
    expect(correcciones.rows[0].n).toBe('1');
  });
});

describe('periodos cerrados', () => {
  it('sin --reabrir se omite, y dice por qué', async () => {
    const nuevo = await facturaPpdMalAcreditada('2000.00', '320.00');
    await query(`UPDATE fiscal_periods SET status = 'soft_close' WHERE id = $1`, [periodo]);

    const hallazgos = await censarIvaPpd(f.tenantId, f.entityId);
    expect(hallazgos.map((h) => h.entry_id)).toContain(nuevo.entryId);

    const r = await reclasificarIvaPpd(hallazgos, f.userId);
    expect(r.reclasificados).toBe(0);
    expect(r.omitidos).toHaveLength(hallazgos.length);
    expect([...r.motivosOmision.values()][0]).toMatch(/soft_close.*no se pidió reabrir/);
  });

  it('con reabrir se corrige y el periodo vuelve a quedar cerrado', async () => {
    const hallazgos = await censarIvaPpd(f.tenantId, f.entityId);
    const r = await reclasificarIvaPpd(hallazgos, f.userId, { reabrirCerrados: true });

    expect(r.fallos).toEqual([]);
    expect(r.reclasificados).toBe(hallazgos.length);

    const estado = await query<{ status: string }>(
      `SELECT status FROM fiscal_periods WHERE id = $1`, [periodo]
    );
    expect(estado.rows[0].status, 'el periodo debe volver al cierre del que se le sacó')
      .toBe('soft_close');

    // La reapertura y el recierre quedan en el rastro, con motivo.
    const rastro = await query<{ action: string; reason: string }>(
      `SELECT action, reason FROM audit_log
        WHERE entity_type = 'fiscal_period' AND entity_id = $1
        ORDER BY timestamp`,
      [periodo]
    );
    expect(rastro.rows.map((x) => x.action)).toContain('reopen');
    expect(rastro.rows.find((x) => x.action === 'reopen')?.reason).toMatch(/PPD/);
  });

  it("un periodo 'locked' no se reabre por ningún camino", async () => {
    await facturaPpdMalAcreditada('700.00', '112.00');
    await query(`UPDATE fiscal_periods SET status = 'locked' WHERE id = $1`, [periodo]);

    const hallazgos = await censarIvaPpd(f.tenantId, f.entityId);
    const r = await reclasificarIvaPpd(hallazgos, f.userId, { reabrirCerrados: true });

    expect(r.reclasificados).toBe(0);
    expect([...r.motivosOmision.values()][0]).toMatch(/locked/);

    const estado = await query<{ status: string }>(
      `SELECT status FROM fiscal_periods WHERE id = $1`, [periodo]
    );
    expect(estado.rows[0].status).toBe('locked');
  });
});
