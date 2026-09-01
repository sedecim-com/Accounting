import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearInquilino, fechaEnPeriodo, saldoDe, type Fixture } from './helpers/tenant-fixture.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import {
  createJournalEntry,
  postJournalEntry,
  reverseJournalEntry,
  voidJournalEntry,
  drainAttestations,
} from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';

/**
 * Porta scripts/e2e-reversal.ts. Diferencia: el inquilino es desechable, la
 * base es efímera y nadie repara saldos a mano al terminar.
 */
let f: Fixture;

beforeAll(async () => {
  f = await crearInquilino('Reversas');
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

function lineas(monto: string) {
  return [
    { account_id: f.roles.banco, debit_amount: monto, credit_amount: null, description: 'cargo' },
    { account_id: f.roles.cxc, debit_amount: null, credit_amount: monto, description: 'abono' },
  ];
}

async function asientoPosteado(monto = '100.00') {
  return createJournalEntry(
    f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'Asiento de integración',
    lineas(monto), f.userId, { autoPost: true }
  );
}

describe('reversa y anulación contra Postgres real', () => {
  it('un borrador no se puede reversar: nunca afectó saldos', async () => {
    const draft = await createJournalEntry(
      f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'Borrador', lineas('50.00'), f.userId
    );
    await expect(reverseJournalEntry(draft.id, f.userId)).rejects.toThrow(/ENTRY_NOT_POSTED|never touched/);
  });

  it('reversar un posteado deja el original posteado y enlaza el espejo', async () => {
    const original = await asientoPosteado('250.00');
    const espejo = await reverseJournalEntry(original.id, f.userId, { reason: 'error de captura' });

    expect(espejo.is_reversal).toBe(true);
    expect(espejo.reverses_entry_id).toBe(original.id);

    const { rows } = await query<{ status: string; reversed_by_entry_id: string }>(
      'SELECT status, reversed_by_entry_id FROM journal_entries WHERE id = $1', [original.id]
    );
    expect(rows[0].status).toBe('posted');
    expect(rows[0].reversed_by_entry_id).toBe(espejo.id);
  });

  it('la segunda reversa se rechaza', async () => {
    const original = await asientoPosteado('300.00');
    await reverseJournalEntry(original.id, f.userId);
    await expect(reverseJournalEntry(original.id, f.userId)).rejects.toThrow(/ALREADY_REVERSED|already has a reversal/);
  });

  it('original + espejo dejan el saldo neto en cero DENTRO DEL MISMO PERIODO', async () => {
    // La fecha del espejo se PIDE. Sin ella el motor usa la de hoy, y entonces
    // esta prueba sólo pasaba mientras «hoy» cayera en el periodo del asiento:
    // el 1 de septiembre de 2026 empezó a fallar por 777 sin que nada del
    // motor cambiara. Una prueba con fecha implícita es una bomba de frontera
    // de mes; la aritmética del espejo se mide fijando el periodo.
    const antes = await saldoDe(f.roles.banco, f.periodos[8]);
    const original = await asientoPosteado('777.00');
    expect(await saldoDe(f.roles.banco, f.periodos[8])).toBeCloseTo(antes + 777, 4);

    await reverseJournalEntry(original.id, f.userId, { reversalDate: fechaEnPeriodo() });
    expect(await saldoDe(f.roles.banco, f.periodos[8])).toBeCloseTo(antes, 4);
  });

  it('sin fecha, el espejo se fecha HOY: el periodo del original no se toca', async () => {
    // La semántica que la prueba anterior daba por supuesta y nadie afirmaba.
    // Es la correcta: una reversa capturada hoy pertenece a hoy —el periodo
    // del original puede estar cerrado— y quien quiera lo contrario lo dice
    // con `entry reverse --date`.
    const netoDeLaCuenta = async (): Promise<number> => {
      const r = await query<{ s: string }>(
        `SELECT COALESCE(SUM(debit_total - credit_total), 0)::text AS s
           FROM account_balances WHERE account_id = $1`,
        [f.roles.banco]
      );
      return Number(r.rows[0].s);
    };

    const antesPeriodo = await saldoDe(f.roles.banco, f.periodos[8]);
    const antesNeto = await netoDeLaCuenta();
    const original = await asientoPosteado('45.00');
    const espejo = await reverseJournalEntry(original.id, f.userId);

    // En el periodo del original queda el cargo si el espejo se fue a otro mes.
    const mismoPeriodo = espejo.fiscal_period_id === original.fiscal_period_id;
    expect(await saldoDe(f.roles.banco, f.periodos[8])).toBeCloseTo(
      mismoPeriodo ? antesPeriodo : antesPeriodo + 45,
      4
    );
    // Y el neto de por VIDA de la cuenta cierra siempre, caiga donde caiga.
    expect(await netoDeLaCuenta()).toBeCloseTo(antesNeto, 4);
  });

  it('anular un posteado NO cambia su estado: le enlaza un espejo', async () => {
    const original = await asientoPosteado('120.00');
    const r = await voidJournalEntry(original.id, f.userId, 'anulada');
    expect(r.status).toBe('posted');
    expect(r.reversed_by_entry_id).toBeTruthy();
  });

  it('anular un borrador sí lo pasa a void, sin espejo', async () => {
    const draft = await createJournalEntry(
      f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'Cancelable', lineas('60.00'), f.userId
    );
    const r = await voidJournalEntry(draft.id, f.userId, 'capturado por error');
    expect(r.status).toBe('void');
    expect(r.reversed_by_entry_id).toBeNull();
  });

  it("la BD acepta el tipo 'payroll': el CHECK se amplió", async () => {
    const je = await createJournalEntry(
      f.entityId, fechaEnPeriodo(), JournalEntryType.PAYROLL, 'Nómina', lineas('10.00'), f.userId
    );
    expect(je.entry_type).toBe('payroll');
  });

  it('postear dos veces el mismo asiento se rechaza', async () => {
    const draft = await createJournalEntry(
      f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'Doble posteo', lineas('15.00'), f.userId
    );
    await postJournalEntry(draft.id, f.userId);
    await expect(postJournalEntry(draft.id, f.userId)).rejects.toThrow(/already posted/i);
  });

  it('un asiento desbalanceado no llega a saldos', async () => {
    await expect(
      createJournalEntry(f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'Desbalanceado', [
        { account_id: f.roles.banco, debit_amount: '100.00', credit_amount: null, description: 'x' },
        { account_id: f.roles.cxc, debit_amount: null, credit_amount: '99.99', description: 'y' },
      ], f.userId, { autoPost: true })
    ).rejects.toThrow(/Validation failed/);
  });
});

describe('numeración concurrente', () => {
  it('cinco asientos simultáneos obtienen cinco folios distintos', async () => {
    const asientos = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        createJournalEntry(
          f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, `Concurrente ${i}`,
          lineas('10.00'), f.userId
        )
      )
    );
    const folios = new Set(asientos.map((a) => a.entry_number));
    expect(folios.size).toBe(5);
  });
});

/**
 * EL RASTRO, CONTRA POSTGRES DE VERDAD.
 *
 * En unitarias se comprueba que el motor emite el INSERT; aquí que la
 * tabla lo acepta —el CHECK de audit_log.action tiene un vocabulario
 * cerrado— y que el rastro es atómico con el hecho que describe.
 */
describe('rastro de auditoría del libro mayor', () => {
  async function rastroDe(entryId: string) {
    const r = await query<{ action: string; user_id: string; reason: string | null; new_values: Record<string, unknown> }>(
      `SELECT action, user_id, reason, new_values FROM audit_log
        WHERE entity_type = 'journal_entries' AND entity_id = $1
        ORDER BY timestamp, action`,
      [entryId]
    );
    return r.rows;
  }

  it('un asiento creado y posteado deja «create» y «post»', async () => {
    const asiento = await asientoPosteado('321.00');
    const r = await rastroDe(asiento.id);
    expect(r.map((x) => x.action).sort()).toEqual(['create', 'post']);
    expect(r.every((x) => x.user_id === f.userId)).toBe(true);
    const alta = r.find((x) => x.action === 'create')!;
    expect(alta.new_values).toMatchObject({ total_debit: '321.00', line_count: 2 });
  });

  it('una reversión deja rastro en el espejo y en el original', async () => {
    const original = await asientoPosteado('55.00');
    const espejo = await reverseJournalEntry(original.id, f.userId, { reason: 'cuenta equivocada' });

    const delOriginal = await rastroDe(original.id);
    const marca = delOriginal.find((x) => x.action === 'update');
    expect(marca, 'el original debe registrar que ya tiene espejo').toBeDefined();
    expect(marca!.reason).toMatch(/cuenta equivocada/);
    expect(marca!.new_values).toMatchObject({ reversed_by_entry_id: espejo.id });

    // NIF B-1: el original sigue contabilizado, no se anula.
    expect(delOriginal.some((x) => x.action === 'void')).toBe(false);
    expect((await rastroDe(espejo.id)).map((x) => x.action).sort()).toEqual(['create', 'post']);
  });

  it('si el asiento no se confirma, tampoco su rastro', async () => {
    const antes = await query<{ n: string }>(`SELECT count(*) AS n FROM audit_log`);

    // Hace falta un fallo POSTERIOR a la escritura del rastro, o la prueba
    // no probaría nada: un asiento desbalanceado con autoPost pasa por
    // INSERT del encabezado, de las líneas y del renglón «create», y
    // revienta después, al validar. Si la auditoría se escribiera con
    // query() —conexión aparte, transacción aparte— ese renglón habría
    // sobrevivido al ROLLBACK y este conteo subiría.
    await expect(
      createJournalEntry(
        f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'Desbalanceado a propósito',
        [
          { account_id: f.roles.banco, debit_amount: '10.00', credit_amount: null, description: 'cargo' },
          { account_id: f.roles.cxc, debit_amount: null, credit_amount: '5.00', description: 'abono corto' },
        ],
        f.userId, { autoPost: true }
      )
    ).rejects.toThrow();

    const despues = await query<{ n: string }>(`SELECT count(*) AS n FROM audit_log`);
    expect(Number(despues.rows[0].n)).toBe(Number(antes.rows[0].n));
  });
});
