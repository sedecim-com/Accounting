import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createCustomer } from '../../src/services/ar/customer-service.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { createVendor } from '../../src/services/ap/vendor-service.js';
import { createBill, approveBill } from '../../src/services/ap/bill-service.js';
import { registerReceiptCommand } from '../../src/cli/receipt-command.js';
import { registerPaymentCommands } from '../../src/cli/payment-command.js';
import { ExitCode, exitCodeFor } from '../../src/cli/kernel/index.js';

// ============================================================
// T3 · LA LLAVE QUE SE ACEPTABA Y SE TIRABA, CONTRA POSTGRES.
//
// `declareRisk` inyecta `--idempotency-key` en toda hoja irreversible, y su
// ayuda promete con estas palabras que «a retry with the same key and payload
// returns the recorded result». `receipt record` y `payment create` la
// aceptaban y la TIRABAN. Medido sobre este mismo camino antes del arreglo:
//
//   receipt record INV --amount 5000 --idempotency-key k, dos veces
//     → 2 customer_payments, 2 payment_allocations, 2 asientos POSTEADOS,
//       amount_due 11,600 → 1,600 (debía quedar en 6,600), idempotency_keys VACÍA.
//   payment create BILL --amount 3000 --idempotency-key k, dos veces
//     → 2 vendor_payments, 2 payment_applications, amount_due 9,280 → 3,280.
//
// La unitaria no puede probar esto: la duplicación es una propiedad de las
// FILAS, y un doble de `query` sólo devuelve lo que el arnés escribió. Por eso
// esta prueba cuenta filas en el mayor y en el auxiliar, que es la única
// evidencia que un auditor acepta.
// ============================================================

let f: Fixture;
let clienteId: string;
let proveedorId: string;

const plain = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

/** Habla con la terminal de verdad y devuelve lo que escribió y con qué código. */
async function correr(argv: string[]): Promise<{ exitCode?: number; out: string; err: string }> {
  let exitCode: number | undefined;
  const out: string[] = [];
  const err: string[] = [];
  const stdoutOriginal = process.stdout.write.bind(process.stdout);
  const stderrOriginal = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    const p = new Command('mnemosine');
    const deps = {
      palette: plain,
      shutdown: (c: number) => { exitCode = c; },
      reportError: (e: unknown) => { err.push(`${(e as Error).message}\n`); },
    };
    registerReceiptCommand(p, deps);
    registerPaymentCommands(p, deps);
    try {
      await p.parseAsync(['node', 'mnemosine', ...argv, '-e', f.entityId, '-t', f.tenantId, '-y']);
    } catch (e) {
      // El mismo recogedor que la entrada real (mnemosine.ts): un error que
      // se escapa del PARSEO —el rechazo de una llave que la hoja no honra
      // ocurre ahí, antes de la acción— trae su código puesto.
      err.push(`${(e as Error).message}\n`);
      exitCode = exitCodeFor(e);
    }
  } finally {
    process.stdout.write = stdoutOriginal;
    process.stderr.write = stderrOriginal;
  }
  return { exitCode, out: out.join(''), err: err.join('') };
}

const contar = async (sql: string): Promise<number> =>
  Number((await query<{ n: string }>(sql, [f.entityId])).rows[0].n);

beforeAll(async () => {
  f = await crearInquilino('T3 · la llave que no deduplicaba');
  const cliente = await createCustomer({
    entity_id: f.entityId, company_name: 'Grupo Alameda SA de CV',
    tax_id: 'XAXX010101000', currency_code: 'MXN', created_by: f.userId,
  });
  clienteId = cliente.id as string;
  const proveedor = await createVendor({
    entity_id: f.entityId, company_name: 'Refacciones del Bajio SA',
    tax_id: 'XAXX010101000', currency_code: 'MXN', created_by: f.userId,
  });
  proveedorId = proveedor.id as string;
}, 60_000);

afterAll(async () => {
  await drainAttestations(5000).catch(() => undefined);
  await closeDatabase();
});

/** Una factura emitida (posteada) por 11,600.00 (10,000 + IVA). */
async function facturaEmitida(): Promise<string> {
  const draft = await createInvoice({
    entity_id: f.entityId, customer_id: clienteId, created_by: f.userId,
    invoice_date: '2026-07-15', due_date: '2026-08-15', currency_code: 'MXN',
    lines: [{
      description: 'Servicios', quantity: '1', unit_price: '10000.00',
      tax_rate: '16', revenue_account_id: f.cuentas['4100'],
    }],
  });
  await issueInvoice(draft.id, f.userId, { entityId: f.entityId });
  const r = await query<{ invoice_number: string }>(
    'SELECT invoice_number FROM invoices WHERE id = $1', [draft.id]
  );
  return r.rows[0].invoice_number;
}

/** Un gasto aprobado (pasivo reconocido) por 9,280.00 (8,000 + IVA). */
async function gastoAprobado(): Promise<string> {
  const bill = await createBill({
    entity_id: f.entityId, vendor_id: proveedorId, created_by: f.userId,
    bill_date: '2026-07-10', due_date: '2026-08-10', currency_code: 'MXN',
    lines: [{
      account_id: f.cuentas['6100'], description: 'Refacciones',
      quantity: '1', unit_price: '8000.00', tax_amount: '1280.00',
    }],
  });
  await approveBill(bill.id, f.userId, { entityId: f.entityId });
  return bill.bill_number;
}

describe('receipt record honra la llave que acepta', () => {
  it('el reintento con la misma llave devuelve lo GRABADO: un cobro, no dos', async () => {
    const folio = await facturaEmitida();
    const antesPagos = await contar(`SELECT count(*) n FROM customer_payments WHERE entity_id = $1`);

    const primera = await correr(['receipt', 'record', folio, '--amount', '5000', '--idempotency-key', 'k-cobro']);
    expect(primera.exitCode, primera.err).toBe(0);

    const segunda = await correr(['receipt', 'record', folio, '--amount', '5000', '--idempotency-key', 'k-cobro']);
    expect(segunda.exitCode, segunda.err).toBe(0);
    expect(segunda.err, 'el reintento tiene que DECIR que es el resultado grabado').toContain(
      'Idempotency hit'
    );

    // UN cobro, UNA aplicación, UN asiento — y el saldo donde debe estar.
    expect(await contar(`SELECT count(*) n FROM customer_payments WHERE entity_id = $1`)).toBe(
      antesPagos + 1
    );
    const pago = await query<{ id: string }>(
      `SELECT id FROM customer_payments WHERE entity_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [f.entityId]
    );
    const aplic = await query<{ n: string }>(
      `SELECT count(*) n FROM payment_allocations WHERE payment_id = $1`, [pago.rows[0].id]
    );
    expect(aplic.rows[0].n).toBe('1');
    const asientos = await query<{ n: string }>(
      `SELECT count(*) n FROM journal_entries
       WHERE entity_id = $1 AND status = 'posted' AND description LIKE 'Customer payment%'`,
      [f.entityId]
    );
    expect(asientos.rows[0].n, 'dos asientos posteados serían el cobro contado dos veces').toBe('1');
    const saldo = await query<{ amount_due: string }>(
      `SELECT amount_due FROM invoices WHERE invoice_number = $1 AND entity_id = $2 AND status <> 'draft'`,
      [folio, f.entityId]
    );
    expect(saldo.rows[0].amount_due).toBe('6600.0000');

    // Y la llave quedó grabada bajo el ámbito que la hoja DECLARA.
    const llaves = await query<{ scope: string }>(
      `SELECT scope FROM idempotency_keys WHERE tenant_id = $1 AND clave = 'k-cobro'`,
      [f.tenantId]
    );
    expect(llaves.rows.map((r) => r.scope)).toEqual(['receipt record']);
  }, 60_000);

  it('y con --on-account tampoco se acusa a sí mismo: la carga es la ENTRADA, no un derivado', async () => {
    // EL DEFECTO QUE ESTE CASO FIJA. La carga de la llave incluía
    // `aplicar.toFixed(2)`, que no es lo que teclea el operador sino
    // `Decimal.min(monto, saldo)` — o sea, se DERIVA del saldo vivo de la
    // factura. Tras el primer cobro el saldo bajó, así que el reintento
    // idéntico calculaba otro `aplicar`, otro hash, y la llave se leía como
    // «usada con una carga DISTINTA»: el mismo comando con la misma llave
    // salía 6 acusándose de reuso en vez de devolver el resultado grabado.
    // Fallaba cerrado —no duplicaba dinero— pero rompía justo la promesa que
    // este tramo vino a hacer verdadera, y en el camino que la hoja anuncia.
    const folio = await facturaEmitida();
    const antesPagos = await contar(`SELECT count(*) n FROM customer_payments WHERE entity_id = $1`);

    const args = ['receipt', 'record', folio, '--amount', '5000', '--on-account', '--idempotency-key', 'k-cuenta'];
    const primera = await correr(args);
    expect(primera.exitCode, primera.err).toBe(0);

    const segunda = await correr(args);
    expect(segunda.exitCode, `el reintento idéntico NO puede acusarse de reuso: ${segunda.err}`).toBe(0);
    expect(segunda.err).toContain('Idempotency hit');

    expect(await contar(`SELECT count(*) n FROM customer_payments WHERE entity_id = $1`)).toBe(
      antesPagos + 1
    );
  }, 60_000);

  it('la misma llave con OTRA carga se acusa como reuso, y no cobra nada', async () => {
    const folio = await facturaEmitida();
    const antes = await contar(`SELECT count(*) n FROM customer_payments WHERE entity_id = $1`);
    const a = await correr(['receipt', 'record', folio, '--amount', '2000', '--idempotency-key', 'k-reuso']);
    expect(a.exitCode, a.err).toBe(0);
    // Mismo folio y misma llave, otro importe: es OTRO acto.
    const b = await correr(['receipt', 'record', folio, '--amount', '1000', '--idempotency-key', 'k-reuso']);
    expect(b.exitCode).toBe(ExitCode.CONFLICT);
    expect(b.err).toContain('carga DISTINTA');
    expect(await contar(`SELECT count(*) n FROM customer_payments WHERE entity_id = $1`)).toBe(antes + 1);
  }, 60_000);
});

describe('payment create honra la llave que acepta', () => {
  it('el reintento con la misma llave devuelve lo GRABADO: un pago, no dos', async () => {
    const folio = await gastoAprobado();
    const antes = await contar(`SELECT count(*) n FROM vendor_payments WHERE entity_id = $1`);

    const primera = await correr(['payment', 'create', folio, '--amount', '3000', '--idempotency-key', 'k-pago']);
    expect(primera.exitCode, primera.err).toBe(0);
    const segunda = await correr(['payment', 'create', folio, '--amount', '3000', '--idempotency-key', 'k-pago']);
    expect(segunda.exitCode, segunda.err).toBe(0);
    expect(segunda.err).toContain('Idempotency hit');

    expect(await contar(`SELECT count(*) n FROM vendor_payments WHERE entity_id = $1`)).toBe(antes + 1);
    const saldo = await query<{ amount_due: string }>(
      `SELECT amount_due FROM bills WHERE bill_number = $1 AND entity_id = $2`, [folio, f.entityId]
    );
    expect(saldo.rows[0].amount_due, 'dos pagos habrían dejado 3,280').toBe('6280.0000');
    const llaves = await query<{ scope: string }>(
      `SELECT scope FROM idempotency_keys WHERE tenant_id = $1 AND clave = 'k-pago'`, [f.tenantId]
    );
    expect(llaves.rows.map((r) => r.scope)).toEqual(['payment create']);
  }, 60_000);
});

describe('la hoja que TODAVÍA no la honra se niega, en vez de fingir', () => {
  it('pasar la llave a `receipt reverse` falla con USAGE y no escribe', async () => {
    // Mientras `receipt reverse` siga en DEUDA_DE_LLAVES, aceptar la llave y
    // postear los espejos otra vez es peor que fallar: quien la pasaba creía
    // estar protegido. El parser corre ANTES de la acción, así que el rechazo
    // ocurre antes de cualquier escritura.
    const antes = await contar(`SELECT count(*) n FROM journal_entries WHERE entity_id = $1`);
    const r = await correr([
      'receipt', 'reverse', 'PMT-2026-00001', '--reason', 'prueba', '--idempotency-key', 'k',
    ]);
    expect(r.exitCode).toBe(ExitCode.USAGE);
    expect(r.err).toContain('TODAVÍA NO LA HONRA');
    expect(await contar(`SELECT count(*) n FROM journal_entries WHERE entity_id = $1`)).toBe(antes);
  }, 60_000);
});
