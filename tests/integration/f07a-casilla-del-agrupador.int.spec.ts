import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import {
  getPeriodCloseStatus,
  type PeriodCloseChecklistItem,
} from '../../src/services/accounting/period-close.js';
import { explainCloseCheck } from '../../src/services/accounting/close-explain.js';
import { createJournalEntry, postJournalEntry } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import { setAccountMapping } from '../../src/services/accounting/account-service.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';

// ============================================================
// F07a · LA CASILLA QUE FALTABA EN TODAS LAS TARJETAS.
//
// El CFF art. 28 fr. IV exige entregar el catálogo de cuentas con su código
// agrupador, y hasta este tramo el cierre no preguntaba por él ni una vez: el
// mes se firmaba «limpio» y la presentación era imposible — cosa que se
// descubría al armar el XML, con el plazo ya corriendo.
//
// Contra Postgres de verdad, porque lo que hay que demostrar es justo lo que
// un doble no puede: qué cuentas salen y cuáles no, y que la acumulación
// hasta el corte es la población correcta.
// ============================================================

let f: Fixture;

const CASILLA = 'sat-agrupador-missing';

async function casilla(mes: number): Promise<{
  item: PeriodCloseChecklistItem;
  can_close: boolean;
  warnings: string[];
  blocking: string[];
}> {
  const st = await getPeriodCloseStatus(f.periodos[mes], f.entityId);
  const item = st.checklist.find((c) => c.codigo === CASILLA);
  if (!item) throw new Error('la casilla del agrupador no está en el checklist');
  return {
    item,
    can_close: st.can_close,
    warnings: st.warnings,
    blocking: st.blocking_issues,
  };
}

/** Un asiento posteado que mueve dos cuentas en el mes dado. */
async function postear(mes: number, debe: string, haber: string, importe = '1000.0000'): Promise<void> {
  const asiento = await createJournalEntry(
    f.entityId,
    new Date(`2026-${String(mes).padStart(2, '0')}-15T00:00:00Z`),
    JournalEntryType.STANDARD,
    `movimiento de prueba mes ${mes}`,
    [
      { account_id: debe, debit_amount: importe, credit_amount: null, description: 'cargo' },
      { account_id: haber, debit_amount: null, credit_amount: importe, description: 'abono' },
    ],
    f.userId
  );
  await postJournalEntry(asiento.id, f.userId);
}

beforeAll(async () => {
  f = await crearInquilino('F07a · la casilla del agrupador');
});

afterAll(async () => {
  await closeDatabase();
});

describe('la casilla existe y distingue nada-que-revisar de revisado-y-bien', () => {
  it('VACUIDAD: sin un solo movimiento posteado no da verde, y dice por qué', async () => {
    const { item, can_close, warnings } = await casilla(1);
    expect(item.item).toBe('Accounts with movement have their SAT grouping code');
    expect(item.is_complete).toBe(false);
    expect(item.details).toMatch(/^0 cuentas con movimiento posteado hasta 2026-01-31: no se pudo comprobar$/);
    // Y no bloquea ni ensucia los avisos: no tener movimientos no es un hallazgo.
    expect(can_close).toBe(true);
    expect(warnings.some((w) => /agrupador/.test(w))).toBe(false);
  });

  it('el detalle cita el CORTE del periodo, no el reloj', async () => {
    const { item } = await casilla(3);
    expect(item.details).toContain('2026-03-31');
  });
});

describe('con cuentas movidas y sin mapear', () => {
  beforeAll(async () => {
    await postear(1, f.roles.banco, f.roles.ingreso);
  });

  it('la casilla se pone en ROJO, nombra las cuentas y NO bloquea', async () => {
    const { item, can_close, warnings, blocking } = await casilla(1);
    expect(item.is_complete).toBe(false);
    expect(item.severity).toBe('warning');
    expect(item.details).toMatch(/^2 de 2 cuenta\(s\) con movimiento sin agrupador: /);
    // Los nombres, no un conteo: la lista es la que manda a mapear.
    const codigos = await query<{ code: string }>(
      'SELECT code FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY code',
      [[f.roles.banco, f.roles.ingreso]]
    );
    for (const { code } of codigos.rows) expect(item.details).toContain(code);
    expect(can_close).toBe(true);
    expect(blocking.some((b) => /agrupador/.test(b))).toBe(false);
    expect(warnings.some((w) => /no tienen código agrupador del SAT/.test(w))).toBe(true);
  });

  it('`closing explain` lista los renglones ofensores con su remedio', async () => {
    const exp = await explainCloseCheck(f.entityId, f.periodos[1], CASILLA);
    expect(exp.total).toBe(2);
    expect(exp.remedio).toContain('account map set');
    expect(exp.renglones[0]).toHaveProperty('lineas_posteadas');
  });

  it('LA ACUMULACIÓN: lo movido en enero sigue contando al cerrar febrero', async () => {
    // Una cuenta que se movió en enero y no en febrero sigue llevando SaldoIni
    // en la balanza de febrero, y el SAT la lee. Acotar la casilla al mes la
    // habría dejado pasar justo en el cierre donde hace falta.
    const { item } = await casilla(2);
    expect(item.details).toMatch(/^2 de 2 cuenta\(s\) con movimiento sin agrupador: /);
  });

  it('un periodo ANTERIOR al movimiento no lo cuenta: la acumulación va hacia atrás', async () => {
    // Enero es el primer periodo del ejercicio, así que el corte anterior al
    // asiento no existe dentro del año; se comprueba con el asiento de marzo.
    await postear(3, f.roles.cxc, f.roles.ingreso);
    const enFebrero = await casilla(2);
    const enMarzo = await casilla(3);
    expect(enFebrero.item.details).toMatch(/^2 de 2 /);
    expect(enMarzo.item.details).toMatch(/^3 de 3 /);
  });
});

describe('mapeadas, la casilla se pone verde DE VERDAD', () => {
  it('con todas las cuentas movidas mapeadas, está completa y sin detalle', async () => {
    const movidas = await query<{ id: string }>(
      `SELECT DISTINCT jel.account_id AS id
         FROM journal_entry_lines jel
         JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.entity_id = $1 AND je.status = 'posted'`,
      [f.entityId]
    );
    expect(movidas.rows.length).toBeGreaterThan(0);
    // Por el camino real: `setAccountMapping` con el esquema 'sat-agrupador'.
    // El catálogo c_CodAgrup no está sembrado en esta base, así que el
    // validador AVISA y guarda — que es exactamente lo que promete.
    for (const { id } of movidas.rows) {
      await setAccountMapping(id, 'sat-agrupador', '102.01', f.userId);
    }
    const { item, warnings } = await casilla(3);
    expect(item.is_complete).toBe(true);
    expect(item.details).toBeUndefined();
    expect(warnings.some((w) => /agrupador/.test(w))).toBe(false);
  });

  it('la mudanza de la 063 llegó: el valor está en codigo_agrupador_sat y mx_nif_code sigue libre', async () => {
    const r = await query<{ codigo_agrupador_sat: string | null; mx_nif_code: string | null }>(
      'SELECT codigo_agrupador_sat, mx_nif_code FROM accounts WHERE id = $1',
      [f.roles.banco]
    );
    expect(r.rows[0].codigo_agrupador_sat).toBe('102.01');
    // La casilla de PRESENTACIÓN no la toca el agrupador FISCAL: ése era el
    // cisma que la 063 cerró.
    expect(r.rows[0].mx_nif_code).toBeNull();
  });
});

describe("contestada 'bloquear', la misma casilla detiene el cierre", () => {
  it('el panel decide, y sólo su literal exacto bloquea', async () => {
    // Se desmapea una cuenta movida para que haya hueco que juzgar.
    await setAccountMapping(f.roles.cxc, 'sat-agrupador', null, f.userId);

    const antes = await casilla(3);
    expect(antes.item.severity).toBe('warning');
    expect(antes.can_close).toBe(true);

    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
    await resolvePolicy(
      { tenantId: f.tenantId, entityId: f.entityId },
      'agrupador_faltante_al_cierre',
      'bloquear',
      f.userId
    );

    const despues = await casilla(3);
    expect(despues.item.severity).toBe('blocking');
    expect(despues.item.is_complete).toBe(false);
    expect(despues.can_close).toBe(false);
    expect(despues.blocking.some((b) => /no tienen código agrupador del SAT/.test(b))).toBe(true);
  });
});
