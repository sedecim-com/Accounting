import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase, withTransaction } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { olvidarAlcances, entityScope } from '../../src/database/scope.js';
import { createJournalEntry } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import {
  previsualizarCotejo,
  correrCotejo,
  crearGrupoDeCotejo,
} from '../../src/services/banking/match-service.js';
import { listarPartidasDeLibros } from '../../src/services/banking/book-items.js';

// ============================================================
// F05b · LOS TRES AGUJEROS QUE LA VERIFICACIÓN ADVERSARIAL ENCONTRÓ
//
// Ninguno de los tres se ve mirando una pareja: los tres se ven mirando el
// CONJUNTO —los otros candidatos, la cuenta de mayor, la cuenta del grupo—, y
// por eso ninguna prueba de función pura los alcanza. Van aquí, contra una
// base de verdad, porque lo que se prueba es lo que las consultas devuelven.
// ============================================================

let f: Fixture;
let cuenta: string;
let otraCuenta: string;
let glBanco: string;

const unaCuentaDe = (x: Fixture): string => Object.values(x.cuentas)[0];

async function cuentaBancaria(nombre: string, gl: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, is_active)
     VALUES ($1, $2, $3, 'Banco de prueba', $4, 'MXN', true)`,
    [id, f.entityId, nombre, gl]
  );
  return id;
}

async function movimiento(
  cuentaId: string, fecha: string, importe: string, descripcion: string
): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount,
      transaction_type, description, is_matched)
     VALUES ($1,$2,$3::date,$4::numeric,'credit',$5,false)`,
    [id, cuentaId, fecha, importe, descripcion]
  );
  return id;
}

async function cliente(): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, created_by)
     VALUES ($1,$2,$3,'Cliente prueba',$4)`,
    [id, f.entityId, `C-${id.slice(0, 8)}`, f.userId]
  );
  return id;
}

/** Una factura con saldo propio: `amount_due` es lo que el banco puede cubrir. */
async function factura(
  custId: string, fecha: string, total: string, saldo: string, descripcion: string
): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount,
      total_amount, currency_code, invoice_date, due_date, status, amount_paid, amount_due,
      description, created_by)
     VALUES ($1,$2,$3,$4,$5,'0',$5,'MXN',$6::date,$6::date,'partially_paid',
             ($5::numeric - $7::numeric),$7,$8,$9)`,
    [id, f.entityId, `F-${id.slice(0, 8)}`, custId, total, fecha, saldo, descripcion, f.userId]
  );
  return id;
}

beforeAll(async () => {
  olvidarAlcances();
  f = await crearInquilino('F05b cotejo adversarial');
  glBanco = f.roles.banco ?? unaCuentaDe(f);
  cuenta = await cuentaBancaria('Operativa', glBanco);
  otraCuenta = await cuentaBancaria('Segunda', f.cuentas['1010'] ?? unaCuentaDe(f));
}, 180_000);

afterAll(async () => {
  await closeDatabase();
});

describe('la factura pagada a medias, que antes no podía cotejar jamás', () => {
  it('el SALDO de 500 sobre un total de 1160 casa con el depósito de 500', async () => {
    const c = await cliente();
    const inv = await factura(c, '2026-03-10', '1160.0000', '500.0000', 'Factura parcial ACME');
    const tx = await movimiento(cuenta, '2026-03-10', '500.0000', 'Deposito ACME');

    const [previsto] = await previsualizarCotejo(entityScope(f.tenantId, f.entityId), { txId: tx });

    expect(previsto.propuesta?.id).toBe(inv);
    // El importe que se compara es el saldo, no el total: proyectar
    // `total_amount` después de filtrar por `amount_due` hacía que 500 nunca
    // pudiera casar contra 1160.
    expect(previsto.propuesta?.importe).toBe('500.0000');
    expect(previsto.senales?.importeExacto).toBe(true);
    expect(previsto.aplicable).toBe(true);
  });
});

describe('la señal dura que no distingue', () => {
  it('con dos candidatos del mismo importe, el texto NO aplica el cotejo solo', async () => {
    const c = await cliente();
    const parecida = await factura(
      c, '2026-02-10', '500.0000', '500.0000', 'PAGO ACME SA DE CV FACTURA 991'
    );
    await factura(c, '2026-02-10', '500.0000', '500.0000', 'Anticipo obra civil zona norte');
    const tx = await movimiento(cuenta, '2026-02-10', '500.0000', 'PAGO ACME SA DE CV FACTURA 991');

    // La propuesta existe y nombra a la parecida: las reglas 1 y 2 se rehúsan
    // por ambiguas y la 3 desempata por descripción.
    const [previsto] = await previsualizarCotejo(entityScope(f.tenantId, f.entityId), { txId: tx });
    expect(previsto.propuesta?.id).toBe(parecida);
    // Y el importe ES exacto: mirando la pareja sola, la compuerta la dejaba
    // pasar. Lo que la cierra es el veto de la regla, que ve al otro candidato.
    expect(previsto.senales?.importeExacto).toBe(true);
    expect(previsto.aplicable).toBe(false);
    expect(previsto.motivo).toBe('solo-similitud');

    const r = await correrCotejo(
      entityScope(f.tenantId, f.entityId), { cuentaId: cuenta, txId: tx }, { userId: f.userId }
    );
    expect(r.aplicados).toEqual([]);
    expect(r.omitidos).toEqual([{ txId: tx, motivo: 'solo-similitud' }]);
  });
});

describe('la partida de libros es la de la cuenta de mayor del banco', () => {
  it('una línea de gasto del mismo importe no se propone ni se sella', async () => {
    // Póliza SIN ninguna línea contra el banco: dos gastos (300 y 200) contra
    // CxP 500. El único candidato posible de 300 es la línea de RENTA.
    const gasto = f.cuentas['6120'];
    const entry = await withTransaction((client) =>
      createJournalEntry(
        f.entityId, new Date(Date.UTC(2026, 1, 20)), JournalEntryType.STANDARD,
        'Gasto que no toca el banco',
        [
          { account_id: gasto, debit_amount: '300.0000', credit_amount: null, description: 'renta' },
          { account_id: gasto, debit_amount: '200.0000', credit_amount: null, description: 'cafe' },
          {
            account_id: f.roles.cxp ?? unaCuentaDe(f),
            debit_amount: null, credit_amount: '500.0000', description: 'proveedor',
          },
        ],
        f.userId, { autoPost: true, client }
      )
    );
    const linea = (await query<{ id: string }>(
      `SELECT id FROM journal_entry_lines WHERE journal_entry_id = $1 AND debit_amount = 300`,
      [entry.id]
    )).rows[0].id;
    const tx = await movimiento(cuenta, '2026-02-20', '300.0000', 'renta');

    // `bank book-item list` nunca la enseñó: une por `ba.gl_account_id`.
    const items = await listarPartidasDeLibros(f.entityId, cuenta);
    expect(items.some((i) => i.lineId === linea)).toBe(false);

    // El motor tampoco la propone ya, y por lo tanto `run` no la sella: una
    // renta marcada `is_reconciled` contra un banco que nunca la mostró queda
    // además inservible para la conciliación que sí le tocaba.
    const [previsto] = await previsualizarCotejo(entityScope(f.tenantId, f.entityId), { txId: tx });
    expect(previsto.propuesta).toBeNull();

    await correrCotejo(
      entityScope(f.tenantId, f.entityId), { cuentaId: cuenta, txId: tx }, { userId: f.userId }
    );
    const sello = await query<{ is_reconciled: boolean }>(
      `SELECT is_reconciled FROM journal_entry_lines WHERE id = $1`, [linea]
    );
    expect(sello.rows[0].is_reconciled).toBe(false);

    // Y el camino humano tampoco la admite: la hoja que produce los ids de
    // `--book-item` y la escritura que los acepta tienen que decir lo mismo.
    const txBanco = await movimiento(cuenta, '2026-02-21', '300.0000', 'otro');
    await expect(
      crearGrupoDeCotejo(
        entityScope(f.tenantId, f.entityId),
        { cuentaId: cuenta, banco: [txBanco], libros: [{ id: linea }] },
        { userId: f.userId }
      )
    ).rejects.toThrow(/journal_entry_line/i);
  });
});

describe('el invariante 2 tiene dos lados', () => {
  /** Una póliza con una línea contra la cuenta de mayor del banco. */
  async function lineaDeBanco(importe: string, lado: 'debit' | 'credit'): Promise<string> {
    const contra = f.roles.cxc ?? unaCuentaDe(f);
    const e = await withTransaction((client) =>
      createJournalEntry(
        f.entityId, new Date(Date.UTC(2026, 7, 10)), JournalEntryType.STANDARD, `cobro ${importe}`,
        lado === 'debit'
          ? [
            { account_id: glBanco, debit_amount: importe, credit_amount: null, description: 'banco' },
            { account_id: contra, debit_amount: null, credit_amount: importe, description: 'contra' },
          ]
          : [
            { account_id: glBanco, debit_amount: null, credit_amount: importe, description: 'banco' },
            { account_id: contra, debit_amount: importe, credit_amount: null, description: 'contra' },
          ],
        f.userId, { autoPost: true, client }
      )
    );
    return (await query<{ id: string }>(
      `SELECT id FROM journal_entry_lines WHERE journal_entry_id = $1 AND account_id = $2`,
      [e.id, glBanco]
    )).rows[0].id;
  }

  it('una partida sin movimiento que la cubra NO queda sellada sin cotejo', async () => {
    const l500 = await lineaDeBanco('500.0000', 'debit');
    const l100 = await lineaDeBanco('100.0000', 'debit');
    const tx = await movimiento(cuenta, '2026-08-10', '400.0000', 'deposito neto');

    // La igualdad se cumple: 400 = 600 + (−200). El reparto voraz, en cambio,
    // da los 400 enteros a la primera partida y deja la de 100 sin cotejo —y
    // `sellarPartidas` la sellaba igual, dejándola invisible para siempre.
    await expect(
      crearGrupoDeCotejo(
        entityScope(f.tenantId, f.entityId),
        {
          cuentaId: cuenta,
          banco: [tx],
          libros: [{ id: l500 }, { id: l100 }],
          ajustes: [{ concepto: 'comision', importe: '-200.0000' }],
        },
        { userId: f.userId }
      )
    ).rejects.toThrow(/no recibe ningún movimiento de banco/);

    const sellos = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM journal_entry_lines
        WHERE id = ANY($1::uuid[]) AND is_reconciled = true`,
      [[l500, l100]]
    );
    expect(sellos.rows[0].n).toBe('0');
  });

  it('el pago corto por comisión —el caso que el ajuste existe para expresar— sigue pasando', async () => {
    const linea = await lineaDeBanco('500.0000', 'credit');
    const tx = uuidv4();
    await query(
      `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount,
        transaction_type, description, is_matched)
       VALUES ($1,$2,'2026-08-11'::date,'-480.0000','debit','pago con comision',false)`,
      [tx, cuenta]
    );

    // −480 (banco) = −500 (libros) + 20 (comisión). La partida SÍ recibe
    // asignación —parcial— y por eso el grupo se escribe.
    const g = await crearGrupoDeCotejo(
      entityScope(f.tenantId, f.entityId),
      {
        cuentaId: cuenta,
        banco: [tx],
        libros: [{ id: linea }],
        ajustes: [{ concepto: 'comision bancaria', importe: '20.0000' }],
      },
      { userId: f.userId }
    );
    expect(g.cuadre.cuadra).toBe(true);
    expect(g.cotejos).toHaveLength(1);
    expect(g.cotejos[0].parcial).toBe(true);
    expect(g.cotejos[0].importe).toBe('480.0000');
    expect(g.partidasSelladas).toEqual([linea]);
  });
});

describe('la cuenta del grupo y la del movimiento', () => {
  it('no queda un cotejo vivo sobre un movimiento que sigue sin marcar', async () => {
    const c = await cliente();
    await factura(c, '2026-07-14', '333.0000', '333.0000', 'COBRO CRUZADO 333');
    const tx = await movimiento(cuenta, '2026-07-14', '333.0000', 'COBRO CRUZADO 333');

    // `marcarMovimientos` ata su UPDATE a `bank_account_id`: con una cuenta que
    // no es la del movimiento, el UPDATE tocaba cero filas EN SILENCIO y el
    // cotejo quedaba escrito sobre un movimiento que decía «sin cotejar».
    await expect(
      correrCotejo(
        entityScope(f.tenantId, f.entityId), { cuentaId: otraCuenta, txId: tx }, { userId: f.userId }
      )
    ).rejects.toThrow(/otra cuenta bancaria/);

    const vivos = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM reconciliation_matches
        WHERE bank_transaction_id = $1 AND unapplied_at IS NULL`,
      [tx]
    );
    const mov = await query<{ is_matched: boolean }>(
      `SELECT is_matched FROM bank_transactions WHERE id = $1`, [tx]
    );
    expect(vivos.rows[0].c).toBe('0');
    expect(mov.rows[0].is_matched).toBe(false);
  });
});
