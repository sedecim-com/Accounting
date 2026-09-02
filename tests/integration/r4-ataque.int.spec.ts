import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import {
  createJournalEntry,
  reverseJournalEntry,
  drainAttestations,
} from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { postInvoiceEntry } from '../../src/services/accounting/ar-ap-posting.js';
import { withTransaction } from '../../src/database/connection.js';
import type { Invoice, InvoiceLine } from '../../src/types/index.js';
import { recordVendorPayment } from '../../src/services/payments/payment-service.js';
import { exigirPar, fijarTipo } from '../../src/services/fx/rate-service.js';
import { JournalEntryType } from '../../src/types/index.js';
import { ConflictError } from '../../src/utils/errors.js';

/**
 * ATAQUE ADVERSARIAL A R4. El objetivo es UNO: hacer que un asiento PIERDA su
 * origen o MIENTA su conversión — que un dólar entre al mayor sin decir que
 * era un dólar, que el importe funcional no salga de foreign × rate, que la
 * diferencia cambiaria caiga en la cuenta equivocada o descuadre el asiento,
 * o que la conversión tome «el tipo que haya» en vez del que la política
 * fiscal eligió.
 *
 * Corre como superusuario a propósito: RLS queda inerte y lo que se prueba es
 * la frontera del CÓDIGO, no la de la base (ver frontera-entidad-ten).
 */

let f: Fixture;
let B: Fixture; // otro inquilino: para la escritura de la tabla GLOBAL

interface LineaLeida {
  account_id: string;
  debit_amount: string | null;
  credit_amount: string | null;
  currency_code: string | null;
  foreign_debit: string | null;
  foreign_credit: string | null;
  exchange_rate: string | null;
  description: string;
}

const lineasDe = async (entryId: string): Promise<LineaLeida[]> =>
  (
    await query<LineaLeida>(
      `SELECT account_id, debit_amount::text, credit_amount::text, currency_code,
              foreign_debit::text, foreign_credit::text, exchange_rate::text, description
         FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY line_number`,
      [entryId]
    )
  ).rows;

/** El asiento cuadra: SUM(debit) = SUM(credit) > 0, leído del mayor. */
async function cuadra(entryId: string): Promise<void> {
  const r = await query<{ d: string; c: string }>(
    `SELECT COALESCE(SUM(debit_amount),0)::text AS d, COALESCE(SUM(credit_amount),0)::text AS c
       FROM journal_entry_lines WHERE journal_entry_id = $1`,
    [entryId]
  );
  expect(new Decimal(r.rows[0].d).equals(r.rows[0].c), `descuadre: DR ${r.rows[0].d} vs CR ${r.rows[0].c}`).toBe(true);
  expect(new Decimal(r.rows[0].d).greaterThan(0)).toBe(true);
}

/**
 * Y ADEMÁS cada línea FX del mayor se re-verifica AQUÍ, con aritmética
 * independiente del motor: funcional = foreign × rate, half-up, 4 decimales.
 */
async function origenVerificado(entryId: string): Promise<void> {
  for (const l of await lineasDe(entryId)) {
    if (l.currency_code === null) continue;
    const extranjero = l.foreign_debit ?? l.foreign_credit;
    const funcional = l.debit_amount ?? l.credit_amount;
    expect(extranjero, `línea "${l.description}" con moneda y sin importe de origen`).not.toBeNull();
    expect(l.exchange_rate, `línea "${l.description}" con moneda y sin tipo`).not.toBeNull();
    const esperado = new Decimal(extranjero as string)
      .times(l.exchange_rate as string)
      .toFixed(4, Decimal.ROUND_HALF_UP);
    expect(
      new Decimal(funcional as string).equals(esperado),
      `línea "${l.description}": ${extranjero} × ${l.exchange_rate} = ${esperado}, el mayor dice ${funcional}`
    ).toBe(true);
  }
}

/** Un gasto USD aprobado (pasivo en el mayor, IVA aparcado a la tasa del documento). */
async function gastoUsd(
  fixture: Fixture,
  opts: { subtotal: string; iva: string; tasa: string; fecha?: Date }
): Promise<{ billId: string; numero: string; total: string; entryId: string }> {
  const total = new Decimal(opts.subtotal).plus(opts.iva).toFixed(4);
  const fecha = opts.fecha ?? fechaEnPeriodo();
  const billId = uuidv4();
  const vendorId = uuidv4();
  const marca = uuidv4().slice(0, 8);
  const cuenta6100 = fixture.cuentas['6100'];

  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,'Proveedor en dólares','CCC030303CC3','rfc','USD',$4)`,
    [vendorId, fixture.entityId, `VU-${marca}`, fixture.userId]
  );
  await query(
    `INSERT INTO bills (
       id, entity_id, bill_number, vendor_id, vendor_invoice_number,
       subtotal, tax_amount, total_amount, amount_due, amount_paid,
       currency_code, exchange_rate, bill_date, due_date, status, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,0,'USD',$9,$10,$10,'draft',$11)`,
    [billId, fixture.entityId, `BILL-USD-${marca}`, vendorId, `INV-${marca}`,
     opts.subtotal, opts.iva, total, opts.tasa, fecha, fixture.userId]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Servicio en USD',1,$4,$4,$5,$6)`,
    [uuidv4(), billId, cuenta6100, opts.subtotal, opts.iva, total]
  );

  const aprobado = await approveBill(billId, fixture.userId, { entityId: fixture.entityId });
  const entryId = (aprobado as { entry?: { id: string } }).entry?.id as string;
  expect(entryId, 'la aprobación del gasto USD debe generar asiento').toBeTruthy();
  return { billId, numero: `BILL-USD-${marca}`, total, entryId };
}

beforeAll(async () => {
  f = await crearInquilino('R4 ataque');
  B = await crearInquilino('R4 ataque · otro inquilino');
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

// ============================================================
// 1 · EL ASIENTO QUE MIENTE SU CONVERSIÓN
// ============================================================

describe('la conversión no se afirma: se verifica', () => {
  const asiento = (lineas: Array<Record<string, unknown>>) =>
    createJournalEntry(
      f.entityId,
      fechaEnPeriodo(),
      JournalEntryType.STANDARD,
      'Ataque R4',
      lineas as never,
      f.userId
    );

  it('un centavo de más se rechaza CON LOS TRES NÚMEROS y el recibido', async () => {
    // 100.00 × 17.1234 = 1712.3400. El atacante afirma 1712.3500: un centavo
    // que, aceptado, saldría del mayor sin haber entrado por ningún banco.
    await expect(
      asiento([
        {
          account_id: f.roles.banco, debit_amount: '1712.3500', credit_amount: null,
          description: 'cargo', currency_code: 'USD', foreign_debit: '100.00', exchange_rate: '17.1234',
        },
        {
          account_id: f.roles.cxc, debit_amount: null, credit_amount: '1712.3500',
          description: 'abono', currency_code: 'USD', foreign_credit: '100.00', exchange_rate: '17.1234',
        },
      ])
    ).rejects.toThrow(/100\.00[\s\S]*17\.1234[\s\S]*1712\.3400[\s\S]*1712\.3500/);
  });

  it('half-up y truncar difieren en 0.03 × 18.3350 y el motor exige el DOCUMENTADO (half-up)', async () => {
    // 0.03 × 18.3350 = 0.550050: truncado da 0.5500, half-up da 0.5501.
    // El valor truncado se rechaza…
    await expect(
      asiento([
        {
          account_id: f.roles.banco, debit_amount: '0.5500', credit_amount: null,
          description: 'truncado', currency_code: 'USD', foreign_debit: '0.03', exchange_rate: '18.3350',
        },
        {
          account_id: f.roles.cxc, debit_amount: null, credit_amount: '0.5500',
          description: 'truncado', currency_code: 'USD', foreign_credit: '0.03', exchange_rate: '18.3350',
        },
      ])
    ).rejects.toThrow(/0\.5501/);

    // …y el half-up entra y se guarda tal cual.
    const e = await asiento([
      {
        account_id: f.roles.banco, debit_amount: '0.5501', credit_amount: null,
        description: 'half-up', currency_code: 'USD', foreign_debit: '0.03', exchange_rate: '18.3350',
      },
      {
        account_id: f.roles.cxc, debit_amount: null, credit_amount: '0.5501',
        description: 'half-up', currency_code: 'USD', foreign_credit: '0.03', exchange_rate: '18.3350',
      },
    ]);
    await origenVerificado(e.id);
  });

  it('las cuatro a medias: moneda+tasa sin importes, e importes+tasa sin moneda, nombrando lo que falta', async () => {
    await expect(
      asiento([
        {
          account_id: f.roles.banco, debit_amount: '100.0000', credit_amount: null,
          description: 'a medias', currency_code: 'USD', exchange_rate: '17.0000',
        },
        { account_id: f.roles.cxc, debit_amount: null, credit_amount: '100.0000', description: 'x' },
      ])
    ).rejects.toThrow(/foreign_debit o foreign_credit/);

    await expect(
      asiento([
        {
          account_id: f.roles.banco, debit_amount: '1700.0000', credit_amount: null,
          description: 'sin moneda', foreign_debit: '100.00', exchange_rate: '17.0000',
        },
        { account_id: f.roles.cxc, debit_amount: null, credit_amount: '1700.0000', description: 'x' },
      ])
    ).rejects.toThrow(/currency_code/);
  });

  it('el CHECK de la 001 es la última red para moneda sin origen… y es UNIDIRECCIONAL', async () => {
    // Un borrador aparte para no ensuciar ningún asiento contabilizado.
    const borrador = await createJournalEntry(
      f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'borrador para CHECK',
      [
        { account_id: f.roles.banco, debit_amount: '10.0000', credit_amount: null, description: 'd' },
        { account_id: f.roles.cxc, debit_amount: null, credit_amount: '10.0000', description: 'c' },
      ] as never,
      f.userId
    );

    // currency_code sin tipo ni importes: el CHECK lo tumba (23514).
    await expect(
      query(
        `INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id,
           debit_amount, credit_amount, description, currency_code)
         VALUES ($1,$2,97,$3,'5.0000',NULL,'ataque directo','USD')`,
        [uuidv4(), borrador.id, f.roles.banco]
      )
    ).rejects.toThrow(/check|viol/i);

    // Pero el CHECK NO exige la moneda: foreign_debit + exchange_rate SIN
    // currency_code pasan la base. La única cerca contra el origen sin
    // moneda es verificarOrigenFx — por eso todo escritor de líneas tiene
    // que entrar por createJournalEntry (documentado; ver informe R4).
    const idHueco = uuidv4();
    await query(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id,
         debit_amount, credit_amount, description, foreign_debit, exchange_rate)
       VALUES ($1,$2,98,$3,'5.0000',NULL,'hueco del CHECK','0.29','17.2413793103')`,
      [idHueco, borrador.id, f.roles.banco]
    );
    await query(`DELETE FROM journal_entry_lines WHERE id = $1`, [idHueco]);
  });
});

// ============================================================
// 2 · EL GASTO USD NACE CON SU ORIGEN, EXACTO Y SIN FLOAT
// ============================================================

describe('el bill en USD posteado conserva su origen', () => {
  it('cada línea lleva las cuatro columnas, el importe original sobrevive EXACTO y el cxp es la suma de lo asentado', async () => {
    // Tasa de DIEZ decimales: si alguien la pasara por float o por
    // DECIMAL(19,4) el producto se movería. 1000.00 × 17.0987654321 =
    // 17098.7654321 → 17098.7654; 160.00 × tasa = 2735.802469136 → 2735.8025.
    const g = await gastoUsd(f, { subtotal: '1000.00', iva: '160.00', tasa: '17.0987654321' });
    const lineas = await lineasDe(g.entryId);
    await cuadra(g.entryId);
    await origenVerificado(g.entryId);

    const cxp = lineas.find((l) => l.credit_amount !== null && /Bill/.test(l.description));
    const gasto = lineas.find((l) => l.debit_amount !== null && /Servicio en USD/.test(l.description));
    const iva = lineas.find((l) => l.debit_amount !== null && /IVA|Creditable/.test(l.description));
    expect(cxp && gasto && iva, 'faltan líneas del asiento del gasto').toBeTruthy();

    // El importe ORIGINAL, como texto del mayor, sin pasar por float.
    expect(new Decimal(gasto!.foreign_debit as string).equals('1000.00')).toBe(true);
    expect(new Decimal(gasto!.debit_amount as string).equals('17098.7654')).toBe(true);
    expect(new Decimal(iva!.foreign_debit as string).equals('160.00')).toBe(true);
    expect(new Decimal(iva!.debit_amount as string).equals('2735.8025')).toBe(true);
    // La tasa conserva sus DIEZ decimales en el viaje de ida y vuelta.
    expect(new Decimal(cxp!.exchange_rate as string).equals('17.0987654321')).toBe(true);
    expect(new Decimal(cxp!.foreign_credit as string).equals('1160.00')).toBe(true);
    // El abono a cxp es la SUMA de los cargos ya redondeados, no total × tasa
    // recalculado aparte: así el asiento cuadra por construcción.
    expect(new Decimal(cxp!.credit_amount as string).equals('19834.5679')).toBe(true);
  });

  it('un bill USD con exchange_rate 1.0 (el default de captura) NO se postea: se acusa', async () => {
    const billId = uuidv4();
    const vendorId = uuidv4();
    const marca = uuidv4().slice(0, 8);
    await query(
      `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
       VALUES ($1,$2,$3,'Sin tasa','CCC030303CC3','rfc','USD',$4)`,
      [vendorId, f.entityId, `VS-${marca}`, f.userId]
    );
    await query(
      `INSERT INTO bills (
         id, entity_id, bill_number, vendor_id, subtotal, tax_amount, total_amount, amount_due,
         amount_paid, currency_code, bill_date, due_date, status, created_by
       ) VALUES ($1,$2,$3,$4,100,16,116,116,0,'USD',$5,$5,'draft',$6)`,
      [billId, f.entityId, `BILL-SIN-${marca}`, vendorId, '2026-08-15', f.userId]
    );
    await query(
      `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
       VALUES ($1,$2,1,$3,'x',1,100,100,16,116)`,
      [uuidv4(), billId, f.cuentas['6100']]
    );
    await expect(approveBill(billId, f.userId, { entityId: f.entityId })).rejects.toThrow(
      /default de captura|perdería su origen/
    );
  });
});

describe('el lado AR no miente mientras no convierte', () => {
  // El cableado FX de cobros es fase 2; la REGLA de R4 no espera. Antes de
  // la guarda, esta misma factura posteaba USD 1000 como MXN 1000 con
  // veredicto limpio — el pecado original vivo en el lado que factura.
  it('una factura USD se NIEGA a postearse nombrando lo que falta, en vez de asentar dólares como pesos', async () => {
    const custId = uuidv4();
    const invId = uuidv4();
    const marca = uuidv4().slice(0, 8);
    await query(
      `INSERT INTO customers (id, entity_id, customer_number, company_name, tax_id, tax_id_type, currency_code, created_by)
       VALUES ($1,$2,$3,'Cliente USD','XEXX010101000','rfc','USD',$4)`,
      [custId, f.entityId, `CU-${marca}`, f.userId]
    );
    await query(
      `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount,
        total_amount, amount_due, currency_code, exchange_rate, invoice_date, due_date, status, created_by)
       VALUES ($1,$2,$3,$4,1000,160,1160,1160,'USD','17.5000000000',$5,$5,'sent',$6)`,
      [invId, f.entityId, `INV-USD-${marca}`, custId, fechaEnPeriodo(), f.userId]
    );
    await query(
      `INSERT INTO invoice_lines (id, invoice_id, line_number, description, quantity, unit_price,
        revenue_account_id, tax_amount, line_amount, total_amount)
       VALUES ($1,$2,1,'Servicio exportado',1,1000,$3,160,1000,1160)`,
      [uuidv4(), invId, f.cuentas['4100']]
    );
    await expect(
      withTransaction(async (client) => {
        const inv = (await client.query<Invoice>('SELECT * FROM invoices WHERE id = $1', [invId])).rows[0];
        const lineas = (await client.query<InvoiceLine>('SELECT * FROM invoice_lines WHERE invoice_id = $1', [invId])).rows;
        return postInvoiceEntry(client, inv, lineas, f.userId);
      })
    ).rejects.toThrow(/fase 2 de R4|sin rastro del importe/);
    // Y el rechazo no dejó medio asiento: la factura sigue sin journal_entry_id.
    const inv = await query<{ journal_entry_id: string | null }>(
      'SELECT journal_entry_id FROM invoices WHERE id = $1', [invId]
    );
    expect(inv.rows[0].journal_entry_id).toBeNull();
  });
});

// ============================================================
// 3 · PAGAR EN USD: LA DIFERENCIA VA A 4320/6320 Y EL ASIENTO CUADRA
// ============================================================

describe('la diferencia cambiaria realizada', () => {
  it('PÉRDIDA: registrado a 17.00, pagado a 17.50 — 580 a la 6320 y el asiento cuadra', async () => {
    const g = await gastoUsd(f, { subtotal: '1000.00', iva: '160.00', tasa: '17.00' });
    const r = await recordVendorPayment(
      {
        entityId: f.entityId,
        paymentAmount: '1160.00',
        paymentDate: fechaEnPeriodo(),
        paymentMethod: 'spei',
        exchangeRate: '17.50',
        applications: [{ documentId: g.billId, amountApplied: '1160.00' }],
      },
      f.userId
    );
    expect(r.journalEntry).not.toBeNull();
    await cuadra(r.journalEntry!.id);
    await origenVerificado(r.journalEntry!.id);

    const lineas = await lineasDe(r.journalEntry!.id);
    const perdida = lineas.filter((l) => l.account_id === f.cuentas['6320']);
    expect(perdida).toHaveLength(1);
    expect(new Decimal(perdida[0].debit_amount as string).equals('580.0000')).toBe(true);
    // Y a la 6320 de verdad, no a la 6300 de gastos financieros ni a la 4300.
    expect(f.roles.perdida_cambiaria).toBe(f.cuentas['6320']);
    expect(lineas.some((l) => l.account_id === f.cuentas['6300'])).toBe(false);

    const banco = lineas.find((l) => l.account_id === f.roles.banco);
    expect(new Decimal(banco!.credit_amount as string).equals('20300.0000')).toBe(true); // 1160 × 17.50
    const cxp = lineas.find((l) => l.account_id === f.roles.cxp);
    expect(new Decimal(cxp!.debit_amount as string).equals('19720.0000')).toBe(true); // 1160 × 17.00

    expect(r.diferenciaCambiaria?.tipo).toBe('perdida');
    expect(r.diferenciaCambiaria?.montoFuncional).toBe('580.0000');
  });

  it('UTILIDAD: registrado a 17.00, pagado a 16.40 — 696 a la 4320, no fundida en la 4300', async () => {
    const g = await gastoUsd(f, { subtotal: '1000.00', iva: '160.00', tasa: '17.00' });
    const r = await recordVendorPayment(
      {
        entityId: f.entityId,
        paymentAmount: '1160.00',
        paymentDate: fechaEnPeriodo(),
        paymentMethod: 'spei',
        exchangeRate: '16.40',
        applications: [{ documentId: g.billId, amountApplied: '1160.00' }],
      },
      f.userId
    );
    await cuadra(r.journalEntry!.id);
    await origenVerificado(r.journalEntry!.id);
    const lineas = await lineasDe(r.journalEntry!.id);
    const utilidad = lineas.filter((l) => l.account_id === f.cuentas['4320']);
    expect(utilidad).toHaveLength(1);
    expect(new Decimal(utilidad[0].credit_amount as string).equals('696.0000')).toBe(true);
    // B-15 exige IDENTIFICAR la fluctuación: la 4300 (otros ingresos) queda fuera.
    expect(lineas.some((l) => l.account_id === f.cuentas['4300'])).toBe(false);
    expect(r.diferenciaCambiaria?.tipo).toBe('utilidad');
  });

  it('PAGO PARCIAL: la mitad del pasivo se extingue a su tasa, el IVA se libera pro-rata y la diferencia es la del tramo', async () => {
    const g = await gastoUsd(f, { subtotal: '1000.00', iva: '160.00', tasa: '17.00' });
    const r = await recordVendorPayment(
      {
        entityId: f.entityId,
        paymentAmount: '580.00',
        paymentDate: fechaEnPeriodo(),
        paymentMethod: 'spei',
        exchangeRate: '17.50',
        applications: [{ documentId: g.billId, amountApplied: '580.00' }],
      },
      f.userId
    );
    await cuadra(r.journalEntry!.id);
    await origenVerificado(r.journalEntry!.id);
    const lineas = await lineasDe(r.journalEntry!.id);
    const cxp = lineas.find((l) => l.account_id === f.roles.cxp);
    expect(new Decimal(cxp!.debit_amount as string).equals('9860.0000')).toBe(true); // 580 × 17.00
    const perdida = lineas.find((l) => l.account_id === f.cuentas['6320']);
    expect(new Decimal(perdida!.debit_amount as string).equals('290.0000')).toBe(true); // 580 × 0.50
    // El IVA liberado es el pro-rata A LA TASA HISTÓRICA: 80 USD × 17.00.
    const liberado = lineas.find((l) => l.debit_amount !== null && /IVA/.test(l.description));
    expect(new Decimal(liberado!.debit_amount as string).equals('1360.0000')).toBe(true);
    expect(new Decimal(liberado!.foreign_debit as string).equals('80.0000')).toBe(true);

    const bd = await query<{ amount_due: string; status: string }>(
      `SELECT amount_due::text, status FROM bills WHERE id = $1`, [g.billId]
    );
    expect(new Decimal(bd.rows[0].amount_due).equals('580.00')).toBe(true);
    expect(bd.rows[0].status).toBe('partially_paid');
  });

  it('EL TOPE DEL IVA RECORTADO POR REDONDEO no tumba el pago ni inventa un origen falso', async () => {
    // Construido para que half-up sume de más: IVA 0.0270 USD a 18.2345
    // aparca 0.4923 (0.4923315 ↓), pero cada mitad pro-rata (0.0135) libera
    // 0.2462 (0.24616575 ↑). El segundo pago topa en 0.2461: NINGÚN importe
    // original reproduce ese remanente, así que la línea va SIN columnas FX
    // — con ellas, el propio motor tumbaba el pago con FX_CONVERSION_NO_CASA.
    const g = await gastoUsd(f, { subtotal: '0.0270', iva: '0.0270', tasa: '18.2345' });

    // El propio NACIMIENTO de este bill es el otro caso raro: los cargos
    // suman 0.4923 + 0.4923 = 0.9846 pero 0.0540 × 18.2345 = 0.9847. El
    // abono a cxp nace por la suma (cuadra contra lo asentado) y SIN
    // columnas FX, porque ningún origen honesto reproduce la suma — con
    // ellas, el motor rechazaba el posteo entero del gasto legítimo.
    await cuadra(g.entryId);
    const cxpNace = (await lineasDe(g.entryId)).find((l) => l.credit_amount !== null);
    expect(new Decimal(cxpNace!.credit_amount as string).equals('0.9846')).toBe(true);
    expect(cxpNace!.currency_code).toBeNull();

    const pagar = () =>
      recordVendorPayment(
        {
          entityId: f.entityId,
          paymentAmount: '0.0270',
          paymentDate: fechaEnPeriodo(),
          paymentMethod: 'spei',
          exchangeRate: '18.2345',
          applications: [{ documentId: g.billId, amountApplied: '0.0270' }],
        },
        f.userId
      );

    const p1 = await pagar();
    await cuadra(p1.journalEntry!.id);
    await origenVerificado(p1.journalEntry!.id);
    const iva1 = (await lineasDe(p1.journalEntry!.id)).find(
      (l) => l.debit_amount !== null && /IVA/.test(l.description)
    );
    // Primer pago: sin recorte, el origen viaja completo.
    expect(new Decimal(iva1!.debit_amount as string).equals('0.2462')).toBe(true);
    expect(iva1!.currency_code).toBe('USD');

    const p2 = await pagar(); // antes del arreglo: reventaba aquí
    await cuadra(p2.journalEntry!.id);
    await origenVerificado(p2.journalEntry!.id);
    const iva2 = (await lineasDe(p2.journalEntry!.id)).find(
      (l) => l.debit_amount !== null && /IVA/.test(l.description)
    );
    // Segundo pago: el telescopio dice 0.4923 − 0.2462 = 0.2461, y como
    // ningún origen honesto reproduce esa cifra, la línea va sin columnas FX.
    expect(new Decimal(iva2!.debit_amount as string).equals('0.2461')).toBe(true);
    expect(iva2!.currency_code).toBeNull();

    // Y el aparcado del documento queda EXACTAMENTE en cero: 0.2462 + 0.2461
    // = 0.4923 — ni un diezmilésimo varado en la 1135, ni la 1135 en negativo
    // (que es lo que dejaba convertir cada tramo por separado).
    const r1135 = await query<{ saldo: string }>(
      `SELECT COALESCE(SUM(COALESCE(debit_amount,0) - COALESCE(credit_amount,0)),0)::text AS saldo
         FROM journal_entry_lines
        WHERE account_id = $1 AND journal_entry_id = ANY($2::uuid[])`,
      [f.roles.iva_pendiente_acreditar, [g.entryId, p1.journalEntry!.id, p2.journalEntry!.id]]
    );
    expect(new Decimal(r1135.rows[0].saldo).isZero(), `la 1135 quedó en ${r1135.rows[0].saldo}`).toBe(true);
  });

  it('un gasto USD viejo asentado con tasa 1.0 NO se paga por aquí: la «diferencia» sería la conversión que nunca ocurrió', async () => {
    const billId = uuidv4();
    const vendorId = uuidv4();
    const marca = uuidv4().slice(0, 8);
    await query(
      `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
       VALUES ($1,$2,$3,'Pre-R4','CCC030303CC3','rfc','USD',$4)`,
      [vendorId, f.entityId, `VP-${marca}`, f.userId]
    );
    // Un bill como los dejó el mundo pre-R4: posteado, USD, tasa default.
    await query(
      `INSERT INTO bills (
         id, entity_id, bill_number, vendor_id, subtotal, tax_amount, total_amount, amount_due,
         amount_paid, currency_code, bill_date, due_date, status, created_by
       ) VALUES ($1,$2,$3,$4,100,16,116,116,0,'USD',$5,$5,'posted',$6)`,
      [billId, f.entityId, `BILL-PRE-${marca}`, vendorId, '2026-08-10', f.userId]
    );
    await expect(
      recordVendorPayment(
        {
          entityId: f.entityId,
          paymentAmount: '116.00',
          paymentDate: fechaEnPeriodo(),
          paymentMethod: 'spei',
          exchangeRate: '17.50',
          applications: [{ documentId: billId, amountApplied: '116.00' }],
        },
        f.userId
      )
    ).rejects.toThrow(/sin convertir|default de captura/);
  });
});

// ============================================================
// 4 · EL TIPO DEL PAGO: DE LA FUENTE ELEGIDA O DE NINGUNA
// ============================================================

describe('la resolución del tipo falla cerrado', () => {
  it('sin tipo de la fuente de la política (dof) el pago SE DETIENE aunque el FIX exista', async () => {
    const g = await gastoUsd(f, { subtotal: '1000.00', iva: '160.00', tasa: '17.00' });
    const pagoDelDia = (sinTasa = true) =>
      recordVendorPayment(
        {
          entityId: f.entityId,
          paymentAmount: '1160.00',
          paymentDate: new Date('2026-09-07T12:00:00Z'),
          paymentMethod: 'spei',
          ...(sinTasa ? {} : {}),
          applications: [{ documentId: g.billId, amountApplied: '1160.00' }],
        },
        f.userId
      );

    // Nada publicado el 7 de septiembre: se detiene nombrando fuente y fecha.
    await expect(pagoDelDia()).rejects.toThrow(/dof[\s\S]*2026-09-07|2026-09-07[\s\S]*dof/);

    // El FIX del día EXISTE y aun así se detiene: «el que haya» no es criterio.
    await fijarTipo({
      par: exigirPar('USD/MXN'), fecha: '2026-09-07', tasa: '18.7000',
      fuente: 'banco_mexico', creadoPor: f.userId,
    });
    await expect(pagoDelDia()).rejects.toThrow(/dof/);

    // Con el DOF capturado, el pago sale y usa EXACTAMENTE ese número.
    await fijarTipo({
      par: exigirPar('USD/MXN'), fecha: '2026-09-07', tasa: '18.5000',
      fuente: 'dof', creadoPor: f.userId,
    });
    const r = await pagoDelDia();
    expect(r.diferenciaCambiaria?.fuente).toBe('dof');
    expect(new Decimal(r.diferenciaCambiaria!.tasaPago).equals('18.5')).toBe(true);
    const banco = (await lineasDe(r.journalEntry!.id)).find((l) => l.account_id === f.roles.banco);
    expect(new Decimal(banco!.credit_amount as string).equals('21460.0000')).toBe(true); // 1160 × 18.50
    await cuadra(r.journalEntry!.id);
  });

  it('una tasa explícita con ONCE decimales no llega al mayor: Postgres la recortaría en silencio', async () => {
    const g = await gastoUsd(f, { subtotal: '100.00', iva: '16.00', tasa: '17.00' });
    await expect(
      recordVendorPayment(
        {
          entityId: f.entityId,
          paymentAmount: '116.00',
          paymentDate: fechaEnPeriodo(),
          paymentMethod: 'spei',
          exchangeRate: '17.12345678901', // 11 decimales
          applications: [{ documentId: g.billId, amountApplied: '116.00' }],
        },
        f.userId
      )
    ).rejects.toThrow(/decimales/);
  });
});

// ============================================================
// 5 · LA REVERSA TAMBIÉN CONSERVA EL ORIGEN
// ============================================================

describe('el espejo espeja el origen', () => {
  it('reversar un asiento USD produce un espejo con los lados extranjeros cruzados y la misma tasa', async () => {
    const original = await createJournalEntry(
      f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'USD a reversar',
      [
        {
          account_id: f.roles.banco, debit_amount: '1712.3400', credit_amount: null,
          description: 'cargo', currency_code: 'USD', foreign_debit: '100.00', exchange_rate: '17.1234',
        },
        {
          account_id: f.roles.cxc, debit_amount: null, credit_amount: '1712.3400',
          description: 'abono', currency_code: 'USD', foreign_credit: '100.00', exchange_rate: '17.1234',
        },
      ] as never,
      f.userId,
      { autoPost: true }
    );

    const espejo = await reverseJournalEntry(original.id, f.userId, { reason: 'ataque R4' });
    await cuadra(espejo.id);
    await origenVerificado(espejo.id);

    const lineas = await lineasDe(espejo.id);
    const abono = lineas.find((l) => l.account_id === f.roles.banco);
    // El cargo original en USD se reversa como ABONO… también en USD.
    expect(abono!.currency_code).toBe('USD');
    expect(new Decimal(abono!.foreign_credit as string).equals('100.00')).toBe(true);
    expect(abono!.foreign_debit).toBeNull();
    expect(new Decimal(abono!.exchange_rate as string).equals('17.1234')).toBe(true);
  });
});

// ============================================================
// 6 · LA TABLA GLOBAL: LO QUE CONVIVE Y LO QUE SE PISA
// ============================================================

describe('exchange_rates es global: la frontera es de PERMISOS, no de filas', () => {
  const par = exigirPar('CAD/MXN');
  const fecha = '2026-09-11';

  it('el duplicado exacto (par+fecha+tipo+fuente) se rechaza tras la 057', async () => {
    await fijarTipo({ par, fecha, tasa: '13.1111', fuente: 'dof', creadoPor: f.userId });
    await expect(
      fijarTipo({ par, fecha, tasa: '13.9999', fuente: 'dof', creadoPor: f.userId })
    ).rejects.toThrow(ConflictError);
  });

  it('FUGA DOCUMENTADA: un usuario de OTRO inquilino fija el «dof» de una fecha y el nuestro queda bloqueado', async () => {
    // exchange_rates no tiene tenant_id (por diseño: el DOF es un hecho del
    // mundo) y fijarTipo no valida permisos por sí mismo — la cota vive en
    // la superficie (`fx rate set` declara escritura, agente ✗). Esta prueba
    // FIJA el comportamiento actual del código: el inquilino B escribe la
    // fila global de una fecha futura y, por el UNIQUE de la 057, el
    // inquilino A ya NO puede capturar el número verdadero — sólo `fx rate
    // correct` (fase 3) podrá enmendarlo. Ver el informe R4: para 'dof' es
    // el diseño asumido; para source='manual' es una fuga real de criterio
    // entre despachos.
    await fijarTipo({
      par: exigirPar('USD/MXN'), fecha: '2026-09-14', tasa: '99.0000',
      fuente: 'dof', creadoPor: B.userId,
    });
    await expect(
      fijarTipo({
        par: exigirPar('USD/MXN'), fecha: '2026-09-14', tasa: '18.9000',
        fuente: 'dof', creadoPor: f.userId,
      })
    ).rejects.toThrow(ConflictError);

    // Y la conversión del inquilino A LEE ese 99.0: mismo hecho global.
    const g = await gastoUsd(f, { subtotal: '10.00', iva: '1.60', tasa: '17.00' });
    const r = await recordVendorPayment(
      {
        entityId: f.entityId,
        paymentAmount: '11.60',
        paymentDate: new Date('2026-09-14T12:00:00Z'),
        paymentMethod: 'spei',
        applications: [{ documentId: g.billId, amountApplied: '11.60' }],
      },
      f.userId
    );
    expect(new Decimal(r.diferenciaCambiaria!.tasaPago).equals('99')).toBe(true);
  });
});
