import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { apartarCatalogos } from './helpers/catalogos-globales.js';
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
import { issueInvoice } from '../../src/services/ar/invoice-service.js';
import {
  recordCustomerPayment,
  recordVendorPayment,
  unapplyCustomerPayment,
} from '../../src/services/payments/payment-service.js';
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

// `exchange_rates` es GLOBAL —sin tenant_id ni entity_id—, así que la comparte
// toda la corrida, y este archivo escribe tipos de cambio.
// Se apunta cómo estaba y se devuelve igual: lo que un archivo deja sembrado en
// una tabla global hace fallar a OTRO, en OTRA corrida, por un motivo que no es
// suyo. El porqué entero, en helpers/catalogos-globales.ts.
apartarCatalogos('exchange_rates');

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

describe('MNE-001-081 · a USD invoice posts, converted at the rate of the fuente_tipo_cambio source', () => {
  // Until this task the same invoice refused with FX_AR_NOT_WIRED: the only
  // alternative was posting USD 1 000 as MXN 1 000. Now it converts at birth,
  // like the bill, at the rate the firm's source (DOF by default) published
  // for the invoice date, and every line keeps its dollars.
  const INVOICE_DAY = '2026-08-20';
  beforeAll(async () => {
    await fijarTipo({
      par: exigirPar('USD/MXN'), fecha: INVOICE_DAY, tasa: '17.5000', fuente: 'dof', creadoPor: f.userId,
    });
  });

  async function usdInvoice(
    exchangeRate = '1.0000000000',
    day = INVOICE_DAY
  ): Promise<{ invId: string; custId: string }> {
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
       VALUES ($1,$2,$3,$4,1000,160,1160,1160,'USD',$5,$6,$6,'draft',$7)`,
      [invId, f.entityId, `INV-USD-${marca}`, custId, exchangeRate, day, f.userId]
    );
    await query(
      `INSERT INTO invoice_lines (id, invoice_id, line_number, description, quantity, unit_price,
        revenue_account_id, tax_amount, line_amount, total_amount)
       VALUES ($1,$2,1,'Servicio exportado',1,1000,$3,160,1000,1160)`,
      [uuidv4(), invId, f.cuentas['4100']]
    );
    return { invId, custId };
  }

  it('with no DOF rate for the invoice date, issuing fails closed and leaves no half entry', async () => {
    const { invId } = await usdInvoice('1.0000000000', '2026-08-21');
    await expect(issueInvoice(invId, f.userId, { entityId: f.entityId })).rejects.toThrow(
      /No hay tipo de cambio USD→MXN de la fuente 'dof' para 2026-08-21/
    );
    const inv = await query<{ journal_entry_id: string | null; status: string }>(
      'SELECT journal_entry_id, status FROM invoices WHERE id = $1', [invId]
    );
    expect(inv.rows[0].journal_entry_id).toBeNull();
    expect(inv.rows[0].status).toBe('draft');
  });

  it('USD 1 000 at 17.50 posts 17 500 of revenue, keeps the dollars, and writes the rate back to the invoice', async () => {
    const { invId } = await usdInvoice();
    const issued = await issueInvoice(invId, f.userId, { entityId: f.entityId });
    const entryId = issued.entry?.id as string;
    expect(entryId, 'issuing the USD invoice must post an entry').toBeTruthy();

    const lines = await lineasDe(entryId);
    const revenue = lines.find((l) => l.account_id === f.cuentas['4100']);
    expect(revenue?.credit_amount).toBe('17500.0000');
    expect(revenue?.currency_code).toBe('USD');
    expect(revenue?.foreign_credit).toBe('1000.0000');
    expect(new Decimal(revenue?.exchange_rate as string).equals('17.5')).toBe(true);

    const cxc = lines.find((l) => l.account_id === f.roles.cxc);
    expect(cxc?.debit_amount).toBe('20300.0000');
    expect(cxc?.foreign_debit).toBe('1160.0000');
    await cuadra(entryId);
    await origenVerificado(entryId);

    const inv = await query<{ exchange_rate: string; journal_entry_id: string }>(
      'SELECT exchange_rate::text, journal_entry_id FROM invoices WHERE id = $1', [invId]
    );
    expect(new Decimal(inv.rows[0].exchange_rate).equals('17.5')).toBe(true);
    expect(inv.rows[0].journal_entry_id).toBe(entryId);
  });

  it('a captured rate that disagrees with the DOF is refused instead of being silently replaced', async () => {
    const { invId } = await usdInvoice('17.2000000000');
    await expect(issueInvoice(invId, f.userId, { entityId: f.entityId })).rejects.toThrow(/No elijo uno en silencio/);
    const inv = await query<{ journal_entry_id: string | null }>(
      'SELECT journal_entry_id FROM invoices WHERE id = $1', [invId]
    );
    expect(inv.rows[0].journal_entry_id).toBeNull();
  });
});

describe('MNE-001-082 · collecting a USD invoice recognises the realised exchange difference', () => {
  // The receivable was born at 17.50 (the rate MNE-001-081 wrote back to the
  // invoice). The collection converts the cash at the rate of ITS day, from the
  // same `fuente_tipo_cambio` source, and the gap is realised (NIF B-15).
  const INVOICE_DAY = '2026-08-20';
  const COLLECTION_DAY = '2026-08-27';
  beforeAll(async () => {
    // The MNE-001-081 block above already published the invoice day's rate.
    await fijarTipo({
      par: exigirPar('USD/MXN'), fecha: COLLECTION_DAY, tasa: '18.0000', fuente: 'dof', creadoPor: f.userId,
    });
  });

  /** An issued USD invoice: an export of services with no IVA unless `tax` says otherwise. */
  async function issuedUsdInvoice(
    opts: { tax?: string; terms?: string; exchangeRate?: string; status?: 'draft' | 'sent' } = {}
  ): Promise<{ invId: string; custId: string }> {
    const tax = opts.tax ?? '0';
    const total = new Decimal(1000).plus(tax).toFixed(2);
    const custId = uuidv4();
    const invId = uuidv4();
    const tag = uuidv4().slice(0, 8);
    await query(
      `INSERT INTO customers (id, entity_id, customer_number, company_name, tax_id, tax_id_type, currency_code, created_by)
       VALUES ($1,$2,$3,'Cliente USD','XEXX010101000','rfc','USD',$4)`,
      [custId, f.entityId, `CR-${tag}`, f.userId]
    );
    await query(
      `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount,
        total_amount, amount_due, currency_code, exchange_rate, invoice_date, due_date, status, terms, created_by)
       VALUES ($1,$2,$3,$4,1000,$5,$6,$6,'USD',$7,$8,$8,$9,$10,$11)`,
      [invId, f.entityId, `INV-RX-${tag}`, custId, tax, total, opts.exchangeRate ?? '1.0000000000',
       INVOICE_DAY, opts.status ?? 'draft', opts.terms ?? null, f.userId]
    );
    await query(
      `INSERT INTO invoice_lines (id, invoice_id, line_number, description, quantity, unit_price,
        revenue_account_id, tax_amount, line_amount, total_amount)
       VALUES ($1,$2,1,'Servicio exportado',1,1000,$3,$4,1000,$5)`,
      [uuidv4(), invId, f.cuentas['4100'], tax, total]
    );
    if ((opts.status ?? 'draft') === 'draft') {
      await issueInvoice(invId, f.userId, { entityId: f.entityId });
    }
    return { invId, custId };
  }

  const collect = (invId: string, custId: string, amount: string) =>
    recordCustomerPayment(
      {
        entityId: f.entityId,
        counterpartyId: custId,
        paymentAmount: amount,
        currencyCode: 'USD',
        paymentDate: new Date(`${COLLECTION_DAY}T12:00:00Z`),
        paymentMethod: 'spei',
        applications: [{ documentId: invId, amountApplied: amount }],
      },
      f.userId
    );

  it('USD 1 000 invoiced at 17.50 and collected at 18.00 realises 500 of gain in 4320', async () => {
    const { invId, custId } = await issuedUsdInvoice();
    const r = await collect(invId, custId, '1000.00');
    const entryId = r.journalEntry?.id as string;
    expect(entryId, 'the USD collection must post an entry').toBeTruthy();
    await cuadra(entryId);
    await origenVerificado(entryId);

    const lines = await lineasDe(entryId);
    const gain = lines.filter((l) => l.account_id === f.cuentas['4320']);
    expect(gain).toHaveLength(1);
    expect(gain[0].credit_amount).toBe('500.0000');
    expect(gain[0].currency_code).toBeNull();
    expect(f.roles.utilidad_cambiaria).toBe(f.cuentas['4320']);

    const bank = lines.find((l) => l.account_id === f.roles.banco);
    expect(bank?.debit_amount).toBe('18000.0000');
    expect(bank?.foreign_debit).toBe('1000.0000');
    const receivable = lines.find((l) => l.account_id === f.roles.cxc);
    expect(receivable?.credit_amount).toBe('17500.0000');
    expect(receivable?.foreign_credit).toBe('1000.0000');

    expect(r.diferenciaCambiaria?.tipo).toBe('utilidad');
    expect(r.diferenciaCambiaria?.montoFuncional).toBe('500.0000');
    expect(r.diferenciaCambiaria?.fuente).toBe('dof');

    // The invoice's receivable is extinguished in pesos too: issue + collection net to zero.
    const net = await query<{ s: string }>(
      `SELECT COALESCE(SUM(COALESCE(debit_amount,0) - COALESCE(credit_amount,0)),0)::text AS s
         FROM journal_entry_lines
        WHERE account_id = $1
          AND journal_entry_id IN ((SELECT journal_entry_id FROM invoices WHERE id = $2), $3::uuid)`,
      [f.roles.cxc, invId, entryId]
    );
    expect(new Decimal(net.rows[0].s).isZero()).toBe(true);

    const stored = await query<{ exchange_rate: string; status: string }>(
      `SELECT cp.exchange_rate::text AS exchange_rate, i.status
         FROM customer_payments cp, invoices i
        WHERE cp.id = $1 AND i.id = $2`,
      [r.paymentId, invId]
    );
    expect(new Decimal(stored.rows[0].exchange_rate).equals('18')).toBe(true);
    expect(stored.rows[0].status).toBe('paid');
  });

  it('a partial collection of a PPD invoice releases 2125 at the parked rate and causes 2120 at the collection rate', async () => {
    const { invId, custId } = await issuedUsdInvoice({ tax: '160', terms: 'PPD' });
    const r = await collect(invId, custId, '580.00');
    const entryId = r.journalEntry?.id as string;
    await cuadra(entryId);
    await origenVerificado(entryId);
    const lines = await lineasDe(entryId);
    expect(lines.find((l) => l.account_id === f.roles.cxc)?.credit_amount).toBe('10150.0000'); // 580 × 17.50
    // 80 USD of IVA (half of 160) leaves 2125 at 17.50, the rate it was parked at: 1 400.
    const released = lines.find((l) => l.account_id === f.roles.iva_trasladado_no_cobrado);
    expect(released?.debit_amount).toBe('1400.0000');
    expect(released?.foreign_debit).toBe('80.0000');
    // And it is caused at the collection day's rate (LIVA 1-B/11, art. 20 CFF):
    // 80 × 18.00 = 1 440, the figure the SAT is owed and the REP reports.
    const caused = lines.find((l) => l.account_id === f.roles.iva_trasladado);
    expect(caused?.credit_amount).toBe('1440.0000');
    expect(caused?.foreign_credit).toBe('80.0000');
    expect(caused?.exchange_rate).toBe('18.0000000000');
    // 580 × 0.50 = 290 on the receivable, less the 40 more IVA owed than was parked.
    expect(lines.find((l) => l.account_id === f.cuentas['4320'])?.credit_amount).toBe('250.0000');
    expect(r.diferenciaCambiaria?.montoFuncional).toBe('250.0000');
  });

  it('cash left on account in dollars is refused, because applying or unapplying it later does not convert', async () => {
    const { invId, custId } = await issuedUsdInvoice();
    await expect(
      recordCustomerPayment(
        {
          entityId: f.entityId,
          counterpartyId: custId,
          paymentAmount: '1200.00',
          currencyCode: 'USD',
          paymentDate: new Date(`${COLLECTION_DAY}T12:00:00Z`),
          paymentMethod: 'spei',
          onAccount: true,
          applications: [{ documentId: invId, amountApplied: '1000.00' }],
        },
        f.userId
      )
    ).rejects.toThrow(/a cuenta del cliente/);
    const inv = await query<{ amount_due: string }>('SELECT amount_due::text FROM invoices WHERE id = $1', [invId]);
    expect(new Decimal(inv.rows[0].amount_due).equals('1000')).toBe(true);
  });

  it('unapplying a USD collection is refused instead of moving dollars between AR and advances as pesos', async () => {
    const { invId, custId } = await issuedUsdInvoice();
    const r = await collect(invId, custId, '1000.00');
    await expect(
      unapplyCustomerPayment(f.entityId, r.paymentId, { invoiceId: invId, reason: 'wrong invoice' }, f.userId)
    ).rejects.toThrow(/USD/);
  });

  it('a USD invoice carrying the 1.0 capture default was never converted, so its collection is refused', async () => {
    const { invId, custId } = await issuedUsdInvoice({ status: 'sent' });
    await expect(collect(invId, custId, '1000.00')).rejects.toThrow(/default de captura|sin convertir/);
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
    // 1160 × 0.50 = 580 on the cash, less 160 × 0.50 = 80 of IVA that becomes
    // creditable at 17.50 while it was parked at 17.00 (LIVA 5-III, art. 20 CFF).
    expect(new Decimal(perdida[0].debit_amount as string).equals('500.0000')).toBe(true);
    // Y a la 6320 de verdad, no a la 6300 de gastos financieros ni a la 4300.
    expect(f.roles.perdida_cambiaria).toBe(f.cuentas['6320']);
    expect(lineas.some((l) => l.account_id === f.cuentas['6300'])).toBe(false);

    const banco = lineas.find((l) => l.account_id === f.roles.banco);
    expect(new Decimal(banco!.credit_amount as string).equals('20300.0000')).toBe(true); // 1160 × 17.50
    const cxp = lineas.find((l) => l.account_id === f.roles.cxp);
    expect(new Decimal(cxp!.debit_amount as string).equals('19720.0000')).toBe(true); // 1160 × 17.00

    expect(r.diferenciaCambiaria?.tipo).toBe('perdida');
    expect(r.diferenciaCambiaria?.montoFuncional).toBe('500.0000');
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
    // 1160 × 0.60 = 696 on the cash, less 160 × 0.60 = 96 of IVA that becomes
    // creditable at 16.40 while it was parked at 17.00.
    expect(new Decimal(utilidad[0].credit_amount as string).equals('600.0000')).toBe(true);
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
    // The parked IVA leaves 1135 at the bill's rate (80 USD × 17.00), and the
    // creditable IVA is the one actually paid at the payment day's rate
    // (LIVA art. 5-III, art. 20 CFF): 80 × 17.50 = 1 400.
    const liberado = lineas.find((l) => l.account_id === f.roles.iva_pendiente_acreditar);
    expect(new Decimal(liberado!.credit_amount as string).equals('1360.0000')).toBe(true);
    const creditable = lineas.find((l) => l.account_id === f.roles.iva_acreditable);
    expect(new Decimal(creditable!.debit_amount as string).equals('1400.0000')).toBe(true);
    expect(new Decimal(creditable!.foreign_debit as string).equals('80.0000')).toBe(true);
    // 580 × 0.50 = 290 of loss on the cash, less the 40 of extra creditable IVA.
    const perdida = lineas.find((l) => l.account_id === f.cuentas['6320']);
    expect(new Decimal(perdida!.debit_amount as string).equals('250.0000')).toBe(true);

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
    const lines2 = await lineasDe(p2.journalEntry!.id);
    const iva2 = lines2.find((l) => l.account_id === f.roles.iva_pendiente_acreditar);
    // Segundo pago: el telescopio dice 0.4923 − 0.2462 = 0.2461, y como
    // ningún origen honesto reproduce esa cifra, la línea va sin columnas FX.
    expect(new Decimal(iva2!.credit_amount as string).equals('0.2461')).toBe(true);
    expect(iva2!.currency_code).toBeNull();
    // The creditable side is this payment's own tax figure, 0.0135 × 18.2345,
    // with its origin; the ten-thousandth between them is realised difference.
    const creditable2 = lines2.find((l) => l.account_id === f.roles.iva_acreditable);
    expect(new Decimal(creditable2!.debit_amount as string).equals('0.2462')).toBe(true);
    expect(creditable2!.currency_code).toBe('USD');

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
