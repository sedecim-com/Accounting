import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import {
  crearInquilino,
  crearEntidadHermana,
  fechaEnPeriodo,
  type Fixture,
} from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe } from './helpers/servidor.js';
import { olvidarAlcances } from '../../src/database/scope.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import bankReconciliationRouter from '../../src/api/rest/routes/bank-reconciliation.js';

/**
 * LAS RUTAS HERMANAS DE `auto-match`, CONTRA LA FRONTERA DE ENTIDAD.
 *
 * `frontera-caminos` (camino 1) cerró `auto-match` y no barrió el resto del
 * archivo. Ejecutado, el mismo ataque seguía funcionando por cuatro rutas más.
 * Lo que sigue es lo que se midió ANTES del arreglo, con dos entidades del
 * mismo inquilino y por HTTP contra el router real:
 *
 *   POST /:account_id/import              → 200, el extracto ajeno pasó de 1 a 2 filas
 *   GET  /:account_id/transactions/unmatched → 200, devolvió los 2 movimientos de la víctima
 *   POST /transactions/:id/match          → 200, quedó un cotejo sobre su movimiento
 *   POST /:account_id/reconciliations     → 201, se le abrió sesión de conciliación
 *
 * La última es la más grave: `period-close.ts` lee el estado de la sesión como
 * evidencia de que la cuenta fue verificada, así que abrir sesiones en los
 * libros de otro es escribir en SU cierre.
 *
 * Dos de esas rutas parecían acotadas y no lo estaban: filtraban con
 * `WHERE entity_id = (SELECT entity_id FROM bank_accounts WHERE id = $1)`, que
 * deduce la entidad de la cuenta QUE PIDE EL ATACANTE y por tanto siempre casa.
 * La entidad tiene que venir del token.
 *
 * Se prueba con dos entidades del MISMO inquilino a propósito: es el par sobre
 * el que RLS no acota nada, así que lo que aquí se demuestra es la frontera del
 * CÓDIGO y no la de la base.
 */

let a: Fixture;
let b: Fixture;

const unaCuentaDe = (f: Fixture): string => Object.values(f.cuentas)[0];

async function cuentaBancaria(f: Fixture): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code)
     VALUES ($1, $2, 'Cuenta operativa', 'Banco de prueba', $3, 'MXN')`,
    [id, f.entityId, f.roles.banco ?? unaCuentaDe(f)]
  );
  return id;
}

let cuentaDeB: string;
let txDeB: string;

beforeAll(async () => {
  olvidarAlcances();
  a = await crearInquilino('Frontera banco A');
  b = await crearEntidadHermana(a, 'Frontera banco B');
  cuentaDeB = await cuentaBancaria(b);
  txDeB = uuidv4();
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, bank_transaction_id, transaction_date,
       amount, transaction_type, description)
     VALUES ($1, $2, $3, $4, 1160.00, 'credit', 'Depósito de B')`,
    [txDeB, cuentaDeB, `TX-${uuidv4().slice(0, 8)}`, fechaEnPeriodo()]
  );
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('la frontera de entidad en las rutas hermanas de auto-match', () => {
  it('import: ¿se pueden meter movimientos en el extracto de otra entidad?', async () => {
    const antes = await query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM bank_transactions WHERE bank_account_id = $1',
      [cuentaDeB]
    );
    const s = await levantar([['/v1/bank-accounts', bankReconciliationRouter]], sesionDe(a));
    let status = 0;
    try {
      const r = await pedir(s, 'POST', `/v1/bank-accounts/${cuentaDeB}/import`, {
        transactions: [
          {
            bank_transaction_id: `INTRUSO-${uuidv4().slice(0, 8)}`,
            transaction_date: '2026-08-15',
            amount: '999.99',
            transaction_type: 'debit',
            description: 'INYECTADO POR A EN EL EXTRACTO DE B',
          },
        ],
      });
      status = r.status;
    } finally {
      await s.cerrar();
    }
    const despues = await query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM bank_transactions WHERE bank_account_id = $1',
      [cuentaDeB]
    );
    // 404 y no 403: quien no es dueño no distingue la cuenta ajena de la inexistente.
    expect(status, 'la ruta rechaza la cuenta ajena').toBe(404);
    expect(despues.rows[0].n, 'y el extracto ajeno no creció').toBe(antes.rows[0].n);
  });

  it('transactions/unmatched: ¿se lee el extracto ajeno?', async () => {
    const s = await levantar([['/v1/bank-accounts', bankReconciliationRouter]], sesionDe(a));
    let status = 0;
    let n = -1;
    try {
      const r = await pedir(s, 'GET', `/v1/bank-accounts/${cuentaDeB}/transactions/unmatched`);
      status = r.status;
      n = Array.isArray(r.body?.data) ? r.body.data.length : -1;
    } finally {
      await s.cerrar();
    }
    expect(status, 'la ruta rechaza la cuenta ajena').toBe(404);
    expect(n, 'y no devuelve ni un movimiento suyo').toBeLessThanOrEqual(0);
  });

  it('transactions/:id/match: ¿se puede cotejar un movimiento ajeno?', async () => {
    const facturaDeB = uuidv4();
    const clienteId = uuidv4();
    const marca = uuidv4().slice(0, 8);
    await query(
      `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
       VALUES ($1,$2,$3,'Cliente B','MXN',$4)`,
      [clienteId, b.entityId, `C-${marca}`, b.userId]
    );
    await query(
      `INSERT INTO invoices (
         id, entity_id, invoice_number, customer_id, invoice_date, due_date,
         subtotal, tax_amount, total_amount, amount_due, amount_paid,
         currency_code, status, created_by
       ) VALUES ($1,$2,$3,$4,$5,$5,1000,160,1160,1160,0,'MXN','sent',$6)`,
      [facturaDeB, b.entityId, `INV-${marca}`, clienteId, fechaEnPeriodo(), b.userId]
    );

    const s = await levantar([['/v1/bank-accounts', bankReconciliationRouter]], sesionDe(a));
    let status = 0;
    try {
      const r = await pedir(s, 'POST', `/v1/bank-accounts/transactions/${txDeB}/match`, {
        matched_entity_type: 'invoice',
        matched_entity_id: facturaDeB,
        matched_amount: '1160.00',
      });
      status = r.status;
    } finally {
      await s.cerrar();
    }
    const marcas = await query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM reconciliation_matches WHERE bank_transaction_id = $1',
      [txDeB]
    );
    expect(status, 'la ruta rechaza el movimiento ajeno').toBe(404);
    expect(marcas.rows[0].n, 'y no queda cotejo sobre él').toBe('0');
  });

  it('reconciliations: ¿se abre sesión sobre la cuenta ajena?', async () => {
    const s = await levantar([['/v1/bank-accounts', bankReconciliationRouter]], sesionDe(a));
    let status = 0;
    try {
      const r = await pedir(s, 'POST', `/v1/bank-accounts/${cuentaDeB}/reconciliations`, {
        start_date: '2026-08-01',
        end_date: '2026-08-31',
        ending_balance_per_bank: '1160.00',
      });
      status = r.status;
    } finally {
      await s.cerrar();
    }
    const ses = await query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM reconciliation_sessions WHERE bank_account_id = $1',
      [cuentaDeB]
    );
    // La más grave de las cuatro: period-close.ts lee el estado de la sesión
    // como evidencia de que la cuenta fue verificada.
    expect(status, 'la ruta rechaza la cuenta ajena').toBe(404);
    expect(ses.rows[0].n, 'y no le queda sesión abierta a la víctima').toBe('0');
  });

  // ============================================================
  // Y LA OTRA MITAD: ACOTAR NO PUEDE SIGNIFICAR NO DEVOLVER NADA.
  //
  // Las cuatro pruebas de arriba dicen que la ruta ajena se rechaza. Ninguna
  // dice que la PROPIA funcione, y en `suggestions` esa mitad se rompió sin
  // ruido: la consulta de facturas pasó a `entity_id = $1` con la entidad del
  // token, y la de gastos conservó `entity_id = (SELECT entity_id FROM
  // bank_accounts WHERE id = $1)` mientras $1 cambiaba de significado. Una
  // entidad nunca es un `bank_accounts.id`, así que la subconsulta devolvía
  // NULL y `entity_id = NULL` no es cierto para ninguna fila: las sugerencias
  // de gastos salían VACÍAS siempre, con 200 y sin decir nada.
  //
  // Una prueba que sólo comprueba 404 no distingue «acotado» de «roto». Ésta
  // es la que faltaba.
  // ============================================================
  it('suggestions: la cuenta PROPIA sí devuelve la factura y el gasto de su entidad', async () => {
    const cuentaDeA = await cuentaBancaria(a);
    const txDeA = uuidv4();
    await query(
      `INSERT INTO bank_transactions (id, bank_account_id, bank_transaction_id, transaction_date,
         amount, transaction_type, description)
       VALUES ($1, $2, $3, $4, 1160.00, 'debit', 'Pago a proveedor')`,
      [txDeA, cuentaDeA, `TX-${uuidv4().slice(0, 8)}`, fechaEnPeriodo()]
    );

    // Un gasto de A por el MISMO importe: es lo que la ruta debe sugerir.
    const proveedor = uuidv4();
    const gasto = uuidv4();
    const marca = uuidv4().slice(0, 8);
    await query(
      `INSERT INTO vendors (id, entity_id, vendor_number, company_name, currency_code, created_by)
       VALUES ($1, $2, $3, 'Proveedor de prueba', 'MXN', $4)`,
      [proveedor, a.entityId, `V-${marca}`, a.userId]
    );
    await query(
      `INSERT INTO bills (id, entity_id, vendor_id, bill_number, bill_date, due_date,
         subtotal, tax_amount, total_amount, amount_due, currency_code, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $5, 1000.00, 160.00, 1160.00, 1160.00, 'MXN', 'approved', $6)`,
      [gasto, a.entityId, proveedor, `B-${marca}`, fechaEnPeriodo(), a.userId]
    );

    const s = await levantar([['/v1/bank-accounts', bankReconciliationRouter]], sesionDe(a));
    let status = 0;
    let tipos: string[] = [];
    let referencias: string[] = [];
    try {
      const r = await pedir(s, 'GET', `/v1/bank-accounts/transactions/${txDeA}/suggestions`);
      status = r.status;
      const filas = Array.isArray(r.body?.data) ? (r.body.data as Array<Record<string, unknown>>) : [];
      tipos = filas.map((f) => String(f.type));
      referencias = filas.map((f) => String(f.reference));
    } finally {
      await s.cerrar();
    }

    expect(status).toBe(200);
    // La aserción que importa: el gasto de la MISMA entidad aparece. Sin ella,
    // la consulta rota pasaba con 200 y una lista vacía.
    expect(tipos, 'la sugerencia de gasto tiene que llegar').toContain('bill');
    expect(referencias).toContain(`B-${marca}`);
  }, 60_000);

});
