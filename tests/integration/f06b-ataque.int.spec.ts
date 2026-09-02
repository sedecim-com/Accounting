import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import {
  getPeriodCloseStatus,
  softClosePeriod,
} from '../../src/services/accounting/period-close.js';
import { explainCloseCheck } from '../../src/services/accounting/close-explain.js';
import {
  reopenClosedPeriod,
  restorePeriodStatus,
} from '../../src/services/accounting/fiscal-calendar-service.js';
import { JournalEntryType } from '../../src/types/index.js';
import { NotFoundError } from '../../src/utils/errors.js';

/**
 * ATAQUE ADVERSARIAL A F06b. El objetivo es UNO: hacer que el checklist del
 * cierre MIENTA — que tilde una casilla hablando de otro mes (el vicio de
 * F05c), que un descuadre inyectado a mano pase de largo, que un hueco de
 * secuencia dejado por `period reopen` sea invisible, o que la entidad A
 * obtenga un veredicto (fabricado y limpio) sobre un periodo de su hermana B.
 *
 * Corre como superusuario a propósito: RLS queda inerte y lo que se prueba es
 * la frontera del CÓDIGO, no la de la base (ver frontera-entidad-ten).
 */

let A: Fixture;
let B: Fixture;
let cuentaBancoA: string;

const buscar = (
  status: Awaited<ReturnType<typeof getPeriodCloseStatus>>,
  codigo: string
) => {
  const casilla = status.checklist.find((c) => c.codigo === codigo);
  expect(casilla, `el checklist perdió la casilla ${codigo}`).toBeDefined();
  return casilla!;
};

/** Un REP aparcado (needs_review) fechado donde diga la prueba. */
async function repAparcado(fx: Fixture, fecha: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO pre_registrations (
       id, entity_id, source_type, document_type, external_reference,
       document_date, currency_code, subtotal, tax_amount, total_amount,
       lines, status, validation_status, created_by
     ) VALUES ($1,$2,'manual','payment',$3,$4,'MXN',1000,160,1160,
       '[]'::jsonb,'ready','needs_review',$5)`,
    [id, fx.entityId, `REP-${id.slice(0, 8)}`, fecha, fx.userId]
  );
  return id;
}

async function postearEn(fx: Fixture, mes: number, monto: string) {
  const cargo = fx.roles.cxc ?? Object.values(fx.cuentas)[0];
  const abono = fx.cuentas['4100'] ?? Object.values(fx.cuentas)[1];
  return createJournalEntry(
    fx.entityId,
    new Date(Date.UTC(2026, mes - 1, 12)),
    JournalEntryType.STANDARD,
    `Ataque F06b mes ${mes}`,
    [
      { account_id: cargo, debit_amount: monto, credit_amount: null, description: 'cargo' },
      { account_id: abono, debit_amount: null, credit_amount: monto, description: 'abono' },
    ],
    fx.userId,
    { autoPost: true }
  );
}

beforeAll(async () => {
  A = await crearInquilino('F06b ataque');
  B = await crearEntidadHermana(A, 'F06b hermana');
  // Un posteo real en agosto de A: varias casillas sólo pueden mentir si hay
  // datos de verdad que leer mal.
  await postearEn(A, 8, '5000.0000');
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

// ============================================================
// 1 · EL REP QUE HABLA DE OTRO MES (el vicio de F05c, forma pura)
// ============================================================

describe('rep-parked se acota al periodo que se cierra', () => {
  it('un REP de NOVIEMBRE aparcado NO ensucia el cierre de AGOSTO', async () => {
    await repAparcado(A, '2026-11-10');
    const status = await getPeriodCloseStatus(A.periodos[8], A.entityId);
    expect(buscar(status, 'rep-parked').is_complete).toBe(true);
    expect(status.warnings.join(' ')).not.toMatch(/aparcado/);

    const exp = await explainCloseCheck(A.entityId, A.periodos[8], 'rep-parked');
    expect(exp.total).toBe(0);
    expect(exp.renglones).toEqual([]);
  });

  it('un REP aparcado DEL PROPIO agosto sí aparece, con su renglón', async () => {
    await repAparcado(A, '2026-08-12');
    const status = await getPeriodCloseStatus(A.periodos[8], A.entityId);
    const casilla = buscar(status, 'rep-parked');
    expect(casilla.is_complete).toBe(false);
    expect(casilla.severity).toBe('warning');
    expect(status.warnings.some((w) => /aparcados en needs_review/.test(w))).toBe(true);

    // Y el espejo de `closing explain` lista EXACTAMENTE ese, no el de noviembre.
    const exp = await explainCloseCheck(A.entityId, A.periodos[8], 'rep-parked');
    expect(exp.total).toBe(1);
    expect(exp.renglones[0].document_date).toBe('2026-08-12');
  });
});

// ============================================================
// 2 · EL MAYOR DESCUADRADO A MANO
// ============================================================

describe('un descuadre inyectado por SQL no pasa de largo', () => {
  it('descuadre SIMÉTRICO (la caché miente igual en los dos lados): la balanza calla y ledger-integrity lo caza', async () => {
    // La balanza suma débitos contra créditos: inflar los dos lados de la
    // MISMA cuenta la deja en paz. Sólo el contraste caché-contra-líneas
    // (runLedgerChecks · balance) puede verlo.
    await query(
      `UPDATE account_balances SET debit_total = debit_total + 100, credit_total = credit_total + 100
        WHERE entity_id = $1 AND fiscal_period_id = $2
          AND account_id = (SELECT account_id FROM account_balances
                             WHERE entity_id = $1 AND fiscal_period_id = $2 LIMIT 1)`,
      [A.entityId, A.periodos[8]]
    );
    try {
      const status = await getPeriodCloseStatus(A.periodos[8], A.entityId);
      expect(buscar(status, 'trial-balance').is_complete).toBe(true); // la balanza NO lo ve
      const mayor = buscar(status, 'ledger-integrity');
      expect(mayor.is_complete).toBe(false);
      expect(mayor.severity).toBe('blocking');
      expect(status.blocking_issues.some((b) => /el mayor no pasa/.test(b))).toBe(true);
      expect(status.can_close).toBe(false);

      const exp = await explainCloseCheck(A.entityId, A.periodos[8], 'ledger-integrity');
      expect(exp.total).toBeGreaterThan(0);
      expect(exp.renglones[0].check).toBe('balance');
    } finally {
      await query(
        `UPDATE account_balances SET debit_total = debit_total - 100, credit_total = credit_total - 100
          WHERE entity_id = $1 AND fiscal_period_id = $2
            AND account_id = (SELECT account_id FROM account_balances
                               WHERE entity_id = $1 AND fiscal_period_id = $2 LIMIT 1)`,
        [A.entityId, A.periodos[8]]
      );
    }
  });

  it('descuadre ASIMÉTRICO: trial-balance bloquea y publica la diferencia con cuatro decimales', async () => {
    await query(
      `UPDATE account_balances SET debit_total = debit_total + 50.1234
        WHERE entity_id = $1 AND fiscal_period_id = $2
          AND account_id = (SELECT account_id FROM account_balances
                             WHERE entity_id = $1 AND fiscal_period_id = $2 LIMIT 1)`,
      [A.entityId, A.periodos[8]]
    );
    try {
      const status = await getPeriodCloseStatus(A.periodos[8], A.entityId);
      const balanza = buscar(status, 'trial-balance');
      expect(balanza.is_complete).toBe(false);
      expect(balanza.severity).toBe('blocking');
      // El dato viaja con los CUATRO decimales de la columna, sin recorte.
      expect(balanza.details).toMatch(/50\.1234/);
      expect(status.can_close).toBe(false);
    } finally {
      await query(
        `UPDATE account_balances SET debit_total = debit_total - 50.1234
          WHERE entity_id = $1 AND fiscal_period_id = $2
            AND account_id = (SELECT account_id FROM account_balances
                               WHERE entity_id = $1 AND fiscal_period_id = $2 LIMIT 1)`,
        [A.entityId, A.periodos[8]]
      );
    }
  });
});

// ============================================================
// 3 · LA SESIÓN BALANCEADA QUE AÚN DEBE
// ============================================================

describe('la sesión balanced no tapa lo que dejó pendiente', () => {
  beforeAll(async () => {
    cuentaBancoA = uuidv4();
    const gl = A.roles.banco ?? A.cuentas['1110'] ?? Object.values(A.cuentas)[0];
    await query(
      `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id,
         currency_code, account_type)
       VALUES ($1,$2,'Operativa ataque','Banco',$3,'MXN','checking')`,
      [cuentaBancoA, A.entityId, gl]
    );
  });

  it('balanced con partidas VENCIDAS: la casilla bank-items-overdue lo enseña', async () => {
    const sesion = uuidv4();
    await query(
      `INSERT INTO reconciliation_sessions
         (id, bank_account_id, entity_id, start_date, end_date, beginning_balance,
          ending_balance_per_bank, status, variance, arithmetic_computed_at)
       VALUES ($1,$2,$3,'2026-08-01','2026-08-31',0,0,'balanced',0,NOW())`,
      [sesion, cuentaBancoA, A.entityId]
    );
    // Una resuelta (no cuenta) y una vencida por calendario aunque su
    // `escalamiento` guardado diga 'ninguno': lo derivado gana a lo escrito.
    await query(
      `INSERT INTO reconciling_items
         (id, entity_id, reconciliation_session_id, tipo, importe, fecha,
          fecha_esperada, escalamiento, responsable, resuelta_at, created_by)
       VALUES
         ($1,$3,$4,'cheque-en-circulacion','-800.0000','2026-08-05','2026-08-15','ninguno','tesorería',NOW(),$5),
         ($2,$3,$4,'deposito-en-transito','123.4567','2026-08-10','2026-08-20','ninguno','tesorería',NULL,$5)`,
      [uuidv4(), uuidv4(), A.entityId, sesion, A.userId]
    );

    const status = await getPeriodCloseStatus(A.periodos[8], A.entityId);
    // La sesión cubre agosto: bank-reconciled queda tildada…
    expect(buscar(status, 'bank-reconciled').is_complete).toBe(true);
    // …pero la partida vencida NO desaparece bajo el 'balanced'.
    const vencidas = buscar(status, 'bank-items-overdue');
    expect(vencidas.is_complete).toBe(false);
    expect(vencidas.severity).toBe('warning');
    // La magnitud viaja con los cuatro decimales de la columna.
    expect(vencidas.details).toMatch(/123\.4567/);
    expect(status.warnings.some((w) => /pasaron su fecha esperada/.test(w))).toBe(true);

    const exp = await explainCloseCheck(A.entityId, A.periodos[8], 'bank-items-overdue');
    expect(exp.total).toBe(1);
    expect(exp.renglones[0].importe).toBe('123.4567');
  });

  it('una variación congelada distinta de cero AVISA con sus cuatro decimales', async () => {
    const sesion = uuidv4();
    await query(
      `INSERT INTO reconciliation_sessions
         (id, bank_account_id, entity_id, start_date, end_date, beginning_balance,
          ending_balance_per_bank, status, variance, arithmetic_computed_at)
       VALUES ($1,$2,$3,'2026-08-01','2026-08-31',0,0,'balanced',12.3456,NOW())`,
      [sesion, cuentaBancoA, A.entityId]
    );
    try {
      const status = await getPeriodCloseStatus(A.periodos[8], A.entityId);
      const casilla = buscar(status, 'bank-variance-frozen');
      expect(casilla.is_complete).toBe(false);
      expect(casilla.severity).toBe('warning');
      expect(casilla.details).toMatch(/12\.3456/);
      expect(status.warnings.some((w) => /variación congelada distinta de cero/.test(w))).toBe(true);
    } finally {
      await query(`DELETE FROM reconciliation_sessions WHERE id = $1`, [sesion]);
    }
  });

  it('una fila zombi pre-054 (balanced SIN aritmética) BLOQUEA: el cierre no cita evidencia que viole el CHECK', async () => {
    // El CHECK de la 054 impide crearla hoy; una fila anterior a la migración
    // (o un dump restaurado a mano) sí puede existir. La casilla no puede
    // delegar en el CHECK: se quita el candado, se inyecta y se comprueba que
    // el CIERRE la rechaza por su cuenta.
    const sesion = uuidv4();
    await query(
      `ALTER TABLE reconciliation_sessions DROP CONSTRAINT sesion_balanceada_con_aritmetica`
    );
    try {
      await query(
        `INSERT INTO reconciliation_sessions
           (id, bank_account_id, entity_id, start_date, end_date, beginning_balance,
            ending_balance_per_bank, status, variance)
         VALUES ($1,$2,$3,'2026-08-01','2026-08-31',0,0,'balanced',0)`,
        [sesion, cuentaBancoA, A.entityId]
      );
      const status = await getPeriodCloseStatus(A.periodos[8], A.entityId);
      const casilla = buscar(status, 'bank-variance-frozen');
      expect(casilla.is_complete).toBe(false);
      expect(casilla.severity).toBe('blocking');
      expect(casilla.details).toMatch(/sin aritmética/);
      expect(status.blocking_issues.some((b) => /cero por omisión/.test(b))).toBe(true);
      expect(status.can_close).toBe(false);
    } finally {
      await query(`DELETE FROM reconciliation_sessions WHERE id = $1`, [sesion]);
      await query(
        `ALTER TABLE reconciliation_sessions ADD CONSTRAINT sesion_balanceada_con_aritmetica
           CHECK (status NOT IN ('balanced', 'approved', 'posted') OR arithmetic_computed_at IS NOT NULL)`
      );
    }
  });
});

// ============================================================
// 4 · CERRAR FUERA DE ORDEN
// ============================================================

describe('la casilla de secuencia', () => {
  it('cerrar octubre con TODO lo anterior abierto: nombra al MÁS VIEJO sin cerrar, y avisa sin congelar', async () => {
    const status = await getPeriodCloseStatus(A.periodos[10], A.entityId);
    const casilla = buscar(status, 'previous-period-closed');
    expect(casilla.is_complete).toBe(false);
    expect(casilla.severity).toBe('warning');
    // El más viejo abierto es enero, no septiembre: un hueco de nueve meses
    // no se describe enseñando sólo el último.
    expect(casilla.details).toMatch(/Periodo 1\/2026/);
    expect(status.warnings.some((w) => /Periodo 1\/2026/.test(w))).toBe(true);
    // Es bifurcación de criterio sin política en el panel: avisa, no bloquea.
    expect(status.blocking_issues.every((b) => !/Periodo 1/.test(b))).toBe(true);
  });
});

// ============================================================
// 5 · PERIOD REOPEN: EL MOTIVO, LA BITÁCORA Y EL HUECO
// ============================================================

describe('period reopen deja rastro y el checklist ve el hueco que deja', () => {
  it('sin motivo se rechaza; con motivo la bitácora dice QUIÉN y POR QUÉ', async () => {
    await softClosePeriod(A.periodos[1], A.entityId, A.userId);

    await expect(
      reopenClosedPeriod(A.entityId, A.periodos[1], A.userId, '')
    ).rejects.toThrow(/motivo/);
    await expect(
      reopenClosedPeriod(A.entityId, A.periodos[1], A.userId, '   ')
    ).rejects.toThrow(/motivo/);

    const { period, previousStatus } = await reopenClosedPeriod(
      A.entityId,
      A.periodos[1],
      A.userId,
      'IVA de enero mal acreditado: la reclasificación pertenece a su mes'
    );
    expect(period.status).toBe('open');
    expect(previousStatus).toBe('soft_close');

    const rastro = await query<{ user_id: string; reason: string; old_values: { status: string } }>(
      `SELECT user_id, reason, old_values FROM audit_log
        WHERE entity_type = 'fiscal_period' AND entity_id = $1 AND action = 'reopen'
        ORDER BY timestamp DESC LIMIT 1`,
      [A.periodos[1]]
    );
    expect(rastro.rows.length).toBe(1);
    expect(rastro.rows[0].user_id).toBe(A.userId);
    expect(rastro.rows[0].reason).toMatch(/IVA de enero/);
    expect(rastro.rows[0].old_values.status).toBe('soft_close');
  });

  it('reabrir con el SIGUIENTE ya cerrado se permite — y la casilla de secuencia enseña el hueco al cierre siguiente', async () => {
    // enero quedó abierto en la prueba anterior: se vuelve a cerrar, se
    // cierra febrero, y se reabre enero DETRÁS de un febrero cerrado.
    await softClosePeriod(A.periodos[1], A.entityId, A.userId);
    await softClosePeriod(A.periodos[2], A.entityId, A.userId);
    const { period } = await reopenClosedPeriod(
      A.entityId,
      A.periodos[1],
      A.userId,
      'corrección que pertenece a enero'
    );
    // EL SERVICIO LO PERMITE EN SILENCIO (hallazgo reportado): ninguna
    // advertencia acompaña al acto. La red de seguridad es el CHECKLIST:
    expect(period.status).toBe('open');

    // Al preguntar por MARZO, el inmediato anterior (febrero) está cerrado.
    // Si la casilla sólo mirara al inmediato, el hueco de enero sería
    // invisible — que es exactamente la mentira que este tramo persigue.
    const status = await getPeriodCloseStatus(A.periodos[3], A.entityId);
    const casilla = buscar(status, 'previous-period-closed');
    expect(casilla.is_complete).toBe(false);
    expect(casilla.details).toMatch(/Periodo 1\/2026/);

    // Y el espejo de `closing explain` lista el hueco, no un «todo limpio».
    const exp = await explainCloseCheck(A.entityId, A.periodos[3], 'previous-period-closed');
    expect(exp.total).toBeGreaterThan(0);
    expect(exp.renglones.some((r) => r.period_name === 'Periodo 1/2026')).toBe(true);

    // El hueco se devuelve con el GEMELO documentado de la reapertura: un
    // periodo reabierto y nunca devuelto es exactamente lo que `doctor`
    // (checkReopenedPeriods) persigue GLOBALMENTE, y esta suite comparte base
    // en serie — el ataque no deja el charco que otro archivo pisaría.
    const devuelto = await restorePeriodStatus(
      A.entityId,
      A.periodos[1],
      'soft_close',
      A.userId,
      'devuelto a su cierre tras el ataque'
    );
    expect(devuelto.status).toBe('soft_close');
  });
});

// ============================================================
// 6 · FUGA ENTRE HERMANAS (serie TEN: 404 por pertenencia, nunca
//     un veredicto fabricado)
// ============================================================

describe('frontera de entidad: A no lee ni reabre lo de B', () => {
  it('el checklist de un periodo de B pedido como A es 404, no un can_close fabricado', async () => {
    await expect(getPeriodCloseStatus(B.periodos[8], A.entityId)).rejects.toThrow(NotFoundError);
  });

  it('un periodo inexistente también es 404: la ruta REST servía can_close: true sobre un UUID inventado', async () => {
    await expect(getPeriodCloseStatus(uuidv4(), A.entityId)).rejects.toThrow(NotFoundError);
  });

  it('closing explain tampoco fabrica un «limpio» sobre el periodo ajeno', async () => {
    await expect(
      explainCloseCheck(A.entityId, B.periodos[8], 'entries-posted')
    ).rejects.toThrow(NotFoundError);
  });

  it('A no puede reabrir el periodo cerrado de B, y B queda como estaba', async () => {
    await softClosePeriod(B.periodos[1], B.entityId, B.userId);
    await expect(
      reopenClosedPeriod(A.entityId, B.periodos[1], A.userId, 'motivo legítimo en apariencia')
    ).rejects.toThrow(NotFoundError);
    const fila = await query<{ status: string }>(
      `SELECT status FROM fiscal_periods WHERE id = $1`,
      [B.periodos[1]]
    );
    expect(fila.rows[0].status).toBe('soft_close');
  });
});
