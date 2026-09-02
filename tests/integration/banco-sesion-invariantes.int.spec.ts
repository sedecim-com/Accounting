import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { getPeriodCloseStatus } from '../../src/services/accounting/period-close.js';

let f: Fixture;
let cuenta: string;

beforeAll(async () => {
  f = await crearInquilino('Sonda 053');
  cuenta = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code)
     VALUES ($1,$2,'Operativa','Banco',$3,'MXN')`,
    [cuenta, f.entityId, f.roles.banco ?? Object.values(f.cuentas)[0]]
  );
}, 120_000);

afterAll(async () => {
  await closeDatabase();
});

/**
 * LOS INVARIANTES DE LA SESIÓN, EN LA BASE Y NO EN EL SERVICIO.
 *
 * El módulo bancario tiene un defecto histórico documentado en su propio
 * código: `POST /reconciliations/:id/complete` era un UPDATE poniendo
 * `status = 'balanced'` y nada más. Nunca calculó el saldo de libros, nunca lo
 * comparó con el del banco, nunca miró si quedaba un movimiento sin cotejar.
 * Las columnas conservaban su DEFAULT 0 y la sesión reportaba `variance 0`:
 * un cero que significa «nadie restó nada», mostrado como «la cuenta cuadra».
 * Y `period-close.ts:51` lee ese estado como la evidencia de que la cuenta se
 * verificó contra el banco.
 *
 * LO QUE SE PRUEBA AQUÍ es que ese UPDATE ya no es representable, y se prueba
 * contra la BASE y no contra el servicio a propósito: un guardia que vive sólo
 * en el servicio protege el camino que alguien recordó, no la tabla. Lo que
 * impidió el defecto durante un año fue nada; lo que lo impide ahora tiene que
 * ser algo que no dependa de por dónde se entre.
 *
 * Y el invariante NO es «variación cero». La variación valía cero —por
 * DEFAULT, que es justo lo contrario de haberla calculado—, así que un CHECK
 * sobre ella habría dejado pasar el defecto entero. Lo que se exige es que la
 * aritmética CONSTE.
 */
describe('los invariantes de la sesión viven en la base', () => {
  it('una sesión NO puede llegar a balanced sin que nadie haya hecho la aritmética', async () => {
    const id = uuidv4();
    await query(
      `INSERT INTO reconciliation_sessions
         (id, bank_account_id, entity_id, start_date, end_date, beginning_balance, ending_balance_per_bank)
       VALUES ($1,$2,$3,'2026-08-01','2026-08-31',0,1000)`,
      [id, cuenta, f.entityId]
    );
    // EL DEFECTO HISTÓRICO, literal: un UPDATE poniendo 'balanced' y nada más.
    // `variance` vale 0 por DEFAULT, así que un CHECK sobre la variación lo
    // habría dejado pasar. Lo que tiene que ser imposible es estar balanceada
    // sin que nadie haya calculado.
    await expect(
      query(`UPDATE reconciliation_sessions SET status = 'balanced' WHERE id = $1`, [id])
    ).rejects.toThrow(/sesion_balanceada_con_aritmetica/);

    const bd = await query<{ status: string }>(
      `SELECT status FROM reconciliation_sessions WHERE id = $1`, [id]
    );
    expect(bd.rows[0].status, 'la sesión sigue donde estaba').toBe('in_progress');
  });

  it('y sí puede cuando la aritmética consta', async () => {
    const id = uuidv4();
    await query(
      `INSERT INTO reconciliation_sessions
         (id, bank_account_id, entity_id, start_date, end_date, beginning_balance, ending_balance_per_bank)
       VALUES ($1,$2,$3,'2026-09-01','2026-09-30',0,1000)`,
      [id, cuenta, f.entityId]
    );
    const r = await query(
      `UPDATE reconciliation_sessions
          SET status = 'balanced', arithmetic_computed_at = NOW()
        WHERE id = $1`,
      [id]
    );
    expect(r.rowCount).toBe(1);
  });

  it('el importe de una partida no puede venir de los dos lados a la vez', async () => {
    const ses = uuidv4();
    await query(
      `INSERT INTO reconciliation_sessions
         (id, bank_account_id, entity_id, start_date, end_date, beginning_balance, ending_balance_per_bank)
       VALUES ($1,$2,$3,'2026-10-01','2026-10-31',0,0)`,
      [ses, cuenta, f.entityId]
    );
    const tx = uuidv4();
    await query(
      `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type, description)
       VALUES ($1,$2,'2026-10-05',100,'credit','X')`,
      [tx, cuenta]
    );
    const linea = await query<{ id: string }>(
      `SELECT id FROM journal_entry_lines LIMIT 1`
    );
    if (linea.rows.length === 0) return;
    await expect(
      query(
        `INSERT INTO reconciling_items
           (entity_id, reconciliation_session_id, tipo, bank_transaction_id, journal_entry_line_id, importe, fecha, created_by)
         VALUES ($1,$2,'cargo-del-banco',$3,$4,100,'2026-10-05',$5)`,
        [f.entityId, ses, tx, linea.rows[0].id, f.userId]
      )
    ).rejects.toThrow();
  });
});

/**
 * Y EL LECTOR DE ESA AFIRMACIÓN, QUE ES DE QUIÉN DEPENDE TODO.
 *
 * `period-close.ts` lee una sesión balanceada como la evidencia de que la
 * cuenta se verificó contra el banco. Su predicado era «alguna sesión
 * balanceada que TERMINE después del cierre del periodo», y con eso la sesión
 * de septiembre tildaba la casilla de agosto —30/09 es posterior a 31/08—
 * aunque agosto no se hubiera conciliado jamás.
 *
 * Hasta F05c la casilla mentía por su origen, porque `balanced` se ponía sin
 * aritmética. Ahora `balanced` se gana, así que lo único que puede estropearla
 * es leerla mal.
 */
describe('la casilla del cierre exige que la sesión CUBRA el periodo', () => {
  async function periodoDe(fixture: Fixture, mes: number): Promise<string> {
    return fixture.periodos[mes];
  }

  it('la sesión de septiembre no tilda la casilla de agosto', async () => {
    const otra = await crearInquilino('Cierre y banco');
    const cuentaOtra = uuidv4();
    await query(
      `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code)
       VALUES ($1,$2,'Operativa','Banco',$3,'MXN')`,
      [cuentaOtra, otra.entityId, otra.roles.banco ?? Object.values(otra.cuentas)[0]]
    );
    // Sólo septiembre, y bien ganada: con su aritmética hecha.
    await query(
      `INSERT INTO reconciliation_sessions
         (bank_account_id, entity_id, start_date, end_date, beginning_balance,
          ending_balance_per_bank, status, arithmetic_computed_at)
       VALUES ($1,$2,'2026-09-01','2026-09-30',0,0,'balanced',NOW())`,
      [cuentaOtra, otra.entityId]
    );

    // Se llama a la FUNCIÓN REAL, no a una copia del SQL: comprobar el
    // predicado por separado demostraría que la consulta que escribí está
    // bien, no que el cierre la use.
    const agosto = await getPeriodCloseStatus(await periodoDe(otra, 8), otra.entityId);
    const casillaAgosto = agosto.checklist.find((c) => c.item === 'Bank reconciliations complete');
    expect(
      casillaAgosto?.is_complete,
      'agosto no se concilió: su casilla no puede tildarse con la sesión de septiembre'
    ).toBe(false);

    // Y la de septiembre, que sí se concilió, sigue tildándose: el arreglo
    // tenía que estrechar el predicado, no romperlo.
    const septiembre = await getPeriodCloseStatus(await periodoDe(otra, 9), otra.entityId);
    const casillaSept = septiembre.checklist.find((c) => c.item === 'Bank reconciliations complete');
    expect(casillaSept?.is_complete, 'septiembre sí se concilió').toBe(true);
  }, 120_000);
});
