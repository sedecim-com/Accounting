import { describe, it, expect, beforeAll, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, enterTenant, getClient } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { createJournalEntry } from '../../src/services/accounting/posting.js';
import { softClosePeriod } from '../../src/services/accounting/period-close.js';
import {
  conductClose,
  describeOpenRun,
  latestRunOf,
  openRunOf,
  CLOSING_STEPS,
  ClosingRunStateError,
  releaseLockConnection,
  abandonStaleRuns,
  claimRun,
  createConductorLease,
  liveRunOf,
  startRun,
  reportLostLock,
  RUN_HEARTBEAT_STALE_AFTER_SECONDS,
  startLockKeepalive,
  startRunHeartbeat,
  watchLockConnection,
} from '../../src/services/accounting/closing-conductor.js';

/**
 * Engine calls, observed without changing them. The lock-loss tests need to
 * act at an exact moment — while a step is in flight — and to prove that no
 * later engine, and no soft close, ran after it. Every wrapper calls the real
 * function; the `during*` hooks are armed by those tests only.
 */
const engineWatch = vi.hoisted(() => ({
  calls: [] as string[],
  duringProvisions: undefined as undefined | (() => Promise<void>),
  duringChecklist: undefined as undefined | (() => Promise<void>),
  /** Runs right after the record of the named step lands, before the next checkpoint. */
  afterRecordOf: undefined as undefined | { step: string; act: () => Promise<void> },
}));

vi.mock('../../src/database/connection.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/database/connection.js')>();
  return {
    ...real,
    query: async (...args: Parameters<typeof real.query>) => {
      const result = await real.query(...args);
      const hook = engineWatch.afterRecordOf;
      const [text, params] = args;
      if (hook && text.includes('INSERT INTO closing_run_steps') && params?.[2] === hook.step) {
        engineWatch.afterRecordOf = undefined;
        await hook.act();
      }
      return result;
    },
  };
});

vi.mock('../../src/ai/close-service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/ai/close-service.js')>();
  return {
    ...real,
    getCloseReadiness: async (...args: Parameters<typeof real.getCloseReadiness>) => {
      const armed = engineWatch.duringChecklist;
      engineWatch.duringChecklist = undefined;
      if (armed) await armed();
      return real.getCloseReadiness(...args);
    },
  };
});

vi.mock('../../src/services/accruals/provisions-run.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/accruals/provisions-run.js')>();
  return {
    ...real,
    runMonthlyProvisions: async (...args: Parameters<typeof real.runMonthlyProvisions>) => {
      engineWatch.calls.push('accrue-benefits');
      const armed = engineWatch.duringProvisions;
      engineWatch.duringProvisions = undefined;
      if (armed) await armed();
      return real.runMonthlyProvisions(...args);
    },
  };
});
vi.mock('../../src/services/accruals/amortization-run.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/accruals/amortization-run.js')>();
  return {
    ...real,
    runMonthlyAmortization: async (...args: Parameters<typeof real.runMonthlyAmortization>) => {
      engineWatch.calls.push('amortize-prepaids');
      return real.runMonthlyAmortization(...args);
    },
  };
});
vi.mock('../../src/services/assets/depreciation.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/assets/depreciation.js')>();
  return {
    ...real,
    runMonthlyDepreciation: async (...args: Parameters<typeof real.runMonthlyDepreciation>) => {
      engineWatch.calls.push('depreciate-assets');
      return real.runMonthlyDepreciation(...args);
    },
  };
});
vi.mock('../../src/services/accounting/period-close.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/accounting/period-close.js')>();
  return {
    ...real,
    softClosePeriod: async (...args: Parameters<typeof real.softClosePeriod>) => {
      engineWatch.calls.push('soft-close');
      return real.softClosePeriod(...args);
    },
  };
});
import {
  buildClosingPack,
  deriveSealedBody,
  latestClosedPeriodOf,
  parseClosingPack,
  sealOf,
  storeClosingPack,
  verdictFindings,
  verifyClosingPack,
} from '../../src/services/accounting/closing-pack.js';
import type { AgentContext } from '../../src/ai/context.js';
import type { ClosablePeriod } from '../../src/ai/close-service.js';

/**
 * A6 · EL CONDUCTOR DEL CIERRE Y SU EXPEDIENTE, CONTRA POSTGRES.
 *
 * La tarjeta de A6 nace con su prueba de aceptación puesta: **el expediente
 * que entrega tiene que poder volver a correrse por un tercero y dar las
 * mismas cifras**. Esa frase no se comprueba con un mock, así que todo corre
 * contra un mayor de verdad.
 *
 * La primera versión de esta suite pasó entera y una revisión adversaria le
 * encontró los huecos: una reanudación que cerraba sobre el checklist de ayer,
 * una subcuenta vacía que rompía todos los expedientes anteriores, un archivo
 * editado y vuelto a sellar que se daba por emitido, dos conductores sobre el
 * mismo mes. Cada uno tiene aquí su prueba, escrita para fallar contra el
 * código de entonces.
 *
 * EL CONTEXTO DEL INQUILINO SE FIJA EN CADA PRUEBA que crea su propio
 * inquilino: `enterTenant` es `AsyncLocalStorage.enterWith`, y llamado dentro
 * de una función awaitada no vuelve al contexto del llamador. Sin fijarlo, la
 * prueba corre bajo el inquilino del `beforeAll` y pasa por el motivo
 * equivocado —la suite es superusuario y RLS no la corrige—.
 */

let f: Fixture;
let hermana: Fixture;
let ctx: AgentContext;

const JULIO = 7;
const AGOSTO = 8;

const contextOf = (x: Fixture, name: string): AgentContext => ({
  entityId: x.entityId,
  entityName: name,
  tenantId: x.tenantId,
  currency: 'MXN',
  country: 'MX',
  accountingStandard: 'mx_nif',
  taxId: 'XAXX010101000',
});

async function periodOf(x: Fixture, month: number): Promise<ClosablePeriod> {
  const r = await query<ClosablePeriod>(
    `SELECT fp.id, fp.period_name, fp.period_number,
            fp.start_date::text, fp.end_date::text, fp.status,
            fy.year_number, false AS overdue
       FROM fiscal_periods fp
       JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
      WHERE fp.id = $1`,
    [x.periodos[month]]
  );
  return r.rows[0];
}

/** Un inquilino nuevo con su panel sembrado y su contexto FIJADO aquí. */
async function ownTenant(name: string): Promise<{ g: Fixture; ctxG: AgentContext }> {
  const g = await crearInquilino(name);
  await seedPolicies({ tenantId: g.tenantId, entityId: g.entityId });
  return { g, ctxG: contextOf(g, name) };
}

/** Un asiento cuadrado y posteado dentro del mes, para que haya cifras. */
async function postEntryOn(x: Fixture, date: string, amount: string): Promise<string> {
  const e = await createJournalEntry(
    x.entityId,
    new Date(date),
    'standard' as never,
    `Venta de ${amount}`,
    [
      { account_id: x.roles.banco, debit_amount: amount, credit_amount: null, description: 'cobro' },
      { account_id: x.roles.ingreso, debit_amount: null, credit_amount: amount, description: 'venta' },
    ] as never,
    x.userId,
    { autoPost: true }
  );
  return e.id;
}

async function addAssetTo(x: Fixture, assetNumber: string, acquiredOn: string): Promise<void> {
  const categoryId = uuidv4();
  await query(
    `INSERT INTO asset_categories (id, entity_id, name) VALUES ($1, $2, $3)`,
    [categoryId, x.entityId, `Equipo ${assetNumber}`]
  );
  await query(
    `INSERT INTO fixed_assets (id, entity_id, asset_number, asset_name, category_id,
       acquisition_date, acquisition_cost, salvage_value, useful_life_years, useful_life_months,
       depreciation_method, depreciation_start_date, current_book_value,
       asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id,
       status, created_by)
     VALUES ($1, $2, $3, 'Laptop', $4,
       $5, '36000.0000', '0', 3, 36,
       'straight_line', $5, '36000.0000',
       $6, $7, $8, 'active', $9)`,
    [uuidv4(), x.entityId, assetNumber, categoryId, acquiredOn, x.cuentas['1210'], x.cuentas['1290'], x.cuentas['6140'], x.userId]
  );
}

async function periodStatusOf(periodId: string): Promise<string> {
  const r = await query<{ status: string }>('SELECT status FROM fiscal_periods WHERE id = $1', [periodId]);
  return r.rows[0].status;
}

beforeAll(async () => {
  f = await crearInquilino('Conductor del cierre');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  hermana = await crearEntidadHermana(f, 'Hermana del conductor');
  ctx = contextOf(f, 'Conductor del cierre');
  await addAssetTo(f, 'AF-001', '2026-01-15');
  await postEntryOn(f, '2026-07-10', '1000.0000');
});


type LockKiller = Awaited<ReturnType<typeof getClient>>;

/** The backend holding a period's conductor lock, read from pg_locks (int8 key: high/low 32 bits). */
async function lockHolderOf(killer: LockKiller, lockKey: string): Promise<number | undefined> {
  const r = await killer.query<{ pid: number }>(
    `SELECT l.pid
       FROM pg_locks l, (SELECT hashtextextended($1, 0) AS h) k
      WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
        AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND l.classid::text::bigint = ((k.h >> 32) & 4294967295)
        AND l.objid::text::bigint = (k.h & 4294967295)`,
    [lockKey]
  );
  return r.rows[0]?.pid;
}

/** Terminates the lock's backend and waits until Postgres has released the lock. */
async function killLockOf(killer: LockKiller, lockKey: string): Promise<{ heldBy?: number; freed: boolean }> {
  const heldBy = await lockHolderOf(killer, lockKey);
  await killer.query('SELECT pg_terminate_backend($1)', [heldBy]);
  for (let i = 0; i < 100 && (await lockHolderOf(killer, lockKey)) !== undefined; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return { heldBy, freed: (await lockHolderOf(killer, lockKey)) === undefined };
}

describe('A6 · el conductor', () => {
  it('recorre los cinco pasos en su orden y deja el periodo en cierre suave', async () => {
    enterTenant(f.tenantId);
    const julio = await periodOf(f, JULIO);
    const r = await conductClose(ctx, julio, { userId: f.userId });

    expect(r.status, JSON.stringify(r.steps, null, 2)).toBe('completed');
    expect(r.steps.map((p) => p.step)).toEqual([...CLOSING_STEPS]);
    expect(r.haltedAtStep).toBeNull();

    // El paso de depreciación posteó de verdad, y su registro nombra el asiento
    // LEYÉNDOLO del mayor, no de lo que el motor devolvió.
    const dep = r.steps.find((p) => p.step === 'depreciate-assets');
    expect(dep?.status).toBe('done');
    expect(dep?.processed).toBe(1);
    expect(dep?.journalEntryIds).toHaveLength(1);

    expect(await periodStatusOf(julio.id)).toBe('soft_close');

    const steps = await query<{ step_key: string }>(
      `SELECT step_key FROM closing_run_steps WHERE run_id = $1 ORDER BY ordinal`,
      [r.runId]
    );
    expect(steps.rows.map((p) => p.step_key)).toEqual([...CLOSING_STEPS]);
  });

  it('un mes ya conducido no se vuelve a conducir: el conductor se niega, y el mayor no se mueve', async () => {
    enterTenant(f.tenantId);
    const agosto = await periodOf(f, AGOSTO);
    expect((await conductClose(ctx, agosto, { userId: f.userId })).status).toBe('completed');

    const lineCount = async () =>
      (
        await query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM journal_entry_lines jel
             JOIN journal_entries je ON je.id = jel.journal_entry_id
            WHERE je.entity_id = $1 AND je.fiscal_period_id = $2`,
          [f.entityId, agosto.id]
        )
      ).rows[0].n;
    const before = await lineCount();

    // LA REGLA ES DEL CONDUCTOR, no sólo de la hoja: llamado sin pasar por el
    // CLI, tampoco corre sus motores sobre un mes cerrado —ni en ensayo—.
    await expect(conductClose(ctx, await periodOf(f, AGOSTO), { userId: f.userId })).rejects.toMatchObject({
      code: 'PERIOD_NOT_OPEN_TO_CONDUCT',
      statusCode: 423,
    });
    await expect(
      conductClose(ctx, await periodOf(f, AGOSTO), { userId: f.userId, dryRun: true })
    ).rejects.toMatchObject({ code: 'PERIOD_NOT_OPEN_TO_CONDUCT' });
    expect(await lineCount()).toBe(before);
  });

  it('una corrida cuyo periodo se cerró por otro camino se abandona al reabrir, y no se funde con el segundo cierre', async () => {
    // La regresión que la tercera revisión construyó: `--stop-at soft-close`,
    // el operador cierra a mano con `close`, luego reabre. Antes, la corrida
    // del primer ciclo seguía abierta y el segundo cierre tenía que
    // «continuarla», sumando los dos ciclos en una sola corrida.
    const { g, ctxG } = await ownTenant('Ciclo cerrado a mano');
    enterTenant(g.tenantId);
    const may = await periodOf(g, 5);
    const firstCycle = await conductClose(ctxG, may, { userId: g.userId, stopAt: 'soft-close' });
    expect(firstCycle.status).toBe('stopped');

    await softClosePeriod(may.id, g.entityId, g.userId, 'cerrado a mano');
    expect(await openRunOf(g.entityId, may.id)).toBeNull();
    await query(`UPDATE fiscal_periods SET status = 'open' WHERE id = $1`, [may.id]);

    const secondCycle = await conductClose(ctxG, await periodOf(g, 5), { userId: g.userId });
    expect(secondCycle.status).toBe('completed');
    expect(secondCycle.runId).not.toBe(firstCycle.runId);
    const previousRun = await query<{ status: string }>('SELECT status FROM closing_runs WHERE id = $1', [firstCycle.runId]);
    expect(previousRun.rows[0].status).toBe('abandoned');
  });

  it('--stop-at para ANTES del paso nombrado; --resume lo termina en la MISMA corrida', async () => {
    const { g, ctxG } = await ownTenant('Cierre a medias');
    enterTenant(g.tenantId);
    const septiembre = await periodOf(g, 9);

    const r = await conductClose(ctxG, septiembre, { userId: g.userId, stopAt: 'soft-close' });
    expect(r.status).toBe('stopped');
    expect(r.haltedAtStep).toBe('soft-close');
    expect(r.steps.map((p) => p.step)).not.toContain('soft-close');
    expect(await periodStatusOf(septiembre.id)).toBe('open');

    const openRow = await openRunOf(g.entityId, septiembre.id);
    expect(openRow?.status).toBe('stopped');
    expect(openRow?.halted_at_step).toBe('soft-close');

    const seguir = await conductClose(ctxG, await periodOf(g, 9), { userId: g.userId, resume: true });
    expect(seguir.status).toBe('completed');
    expect(seguir.runId).toBe(r.runId);
    // El checklist se VOLVIÓ A EVALUAR: el paso consta de un intento anterior,
    // y aun así se corrió otra vez en éste.
    expect(seguir.steps.find((p) => p.step === 'verify-checklist')?.priorAttempt).toBe(true);
    expect(await openRunOf(g.entityId, septiembre.id)).toBeNull();
  });

  it('LA REANUDACIÓN NO CIERRA SOBRE EL CHECKLIST DE AYER: un borrador llegado después la detiene', async () => {
    // El caso que la revisión construyó paso a paso. El checklist quedó `done`
    // en el primer intento; al día siguiente llega un borrador de IA fechado
    // dentro del mes, y `softClosePeriod` NO cuenta borradores de IA. Si la
    // reanudación se fiara del veredicto anotado, el mes se cerraría con él.
    const { g, ctxG } = await ownTenant('Checklist caducado');
    enterTenant(g.tenantId);
    const noviembre = await periodOf(g, 11);

    const r = await conductClose(ctxG, noviembre, { userId: g.userId, stopAt: 'soft-close' });
    expect(r.steps.find((p) => p.step === 'verify-checklist')?.status).toBe('done');

    await query(
      `INSERT INTO ai_drafts (id, tenant_id, entity_id, draft_type, status, payload,
         ai_confidence, ai_reasoning, ai_model)
       VALUES ($1, $2, $3, 'journal_entry', 'pending_review',
         '{"entry_date":"2026-11-20","lines":[]}'::jsonb, 0.9, 'llegó después', 'claude-test')`,
      [uuidv4(), g.tenantId, g.entityId]
    );

    const seguir = await conductClose(ctxG, await periodOf(g, 11), { userId: g.userId, resume: true });
    expect(seguir.status).toBe('blocked');
    expect(seguir.haltedAtStep).toBe('verify-checklist');
    expect(seguir.steps.find((p) => p.step === 'verify-checklist')?.detail).toMatch(/AI draft/);
    expect(await periodStatusOf(noviembre.id)).toBe('open');
  });

  it('un paso que la primera vez no tenía qué hacer se corre al reanudar, y un `done` no se degrada', async () => {
    // El segundo caso de la revisión: el activo se da de alta DESPUÉS del
    // primer intento. Si «omitido» fuera permanente, el mes se cerraría sin
    // depreciar y ninguna casilla lo impediría (la de depreciación avisa, no
    // bloquea).
    const { g, ctxG } = await ownTenant('Activo tardío');
    enterTenant(g.tenantId);
    const marzo = await periodOf(g, 3);

    const first = await conductClose(ctxG, marzo, { userId: g.userId, stopAt: 'soft-close' });
    expect(first.steps.find((p) => p.step === 'depreciate-assets')?.status).toBe('skipped');

    await addAssetTo(g, 'AF-TARDE', '2026-01-15');

    const second = await conductClose(ctxG, await periodOf(g, 3), {
      userId: g.userId,
      resume: true,
      stopAt: 'soft-close',
    });
    const dep = second.steps.find((p) => p.step === 'depreciate-assets');
    expect(dep?.status).toBe('done');
    expect(dep?.processed).toBe(1);
    expect(dep?.journalEntryIds).toHaveLength(1);

    // Tercer intento: el motor ya no tiene nada que hacer. El registro NO
    // pasa a «omitido», no pierde el asiento ni lo que procesó.
    const third = await conductClose(ctxG, await periodOf(g, 3), {
      userId: g.userId,
      resume: true,
      stopAt: 'soft-close',
    });
    const dep3 = third.steps.find((p) => p.step === 'depreciate-assets');
    expect(dep3?.status).toBe('done');
    expect(dep3?.processed).toBe(1);
    expect(dep3?.journalEntryIds).toEqual(dep?.journalEntryIds);
  });

  it('un paso que falló después de hacer trabajo no se degrada a «omitido» cuando ya no queda nada', async () => {
    // El caso que la segunda revisión construyó con la depreciación: el primer
    // intento posteó cinco activos y tropezó con el sexto, cuyo renglón el
    // operador captura a mano; al reanudar, el motor ya no tiene nada que hacer.
    // El registro dice «hecho», con lo procesado antes, y no «0 depreciados».
    const { g, ctxG } = await ownTenant('Falló con trabajo');
    enterTenant(g.tenantId);
    const julio = await periodOf(g, 7);
    const firstAttempt = await conductClose(ctxG, julio, { userId: g.userId, stopAt: 'soft-close' });
    await query(
      `UPDATE closing_run_steps SET status = 'failed', processed = 5, detail = 'unit-of-production asset'
        WHERE run_id = $1 AND step_key = 'depreciate-assets'`,
      [firstAttempt.runId]
    );

    const secondAttempt = await conductClose(ctxG, await periodOf(g, 7), { userId: g.userId, resume: true, stopAt: 'soft-close' });
    const dep = secondAttempt.steps.find((p) => p.step === 'depreciate-assets');
    expect(dep?.status).toBe('done');
    expect(dep?.processed).toBe(5);
    expect(dep?.detail).toMatch(/earlier attempts/);
  });

  it('una casilla bloqueante detiene el cierre, y el periodo sigue abierto', async () => {
    const { g, ctxG } = await ownTenant('Cierre bloqueado');
    enterTenant(g.tenantId);
    const octubre = await periodOf(g, 10);

    // Un asiento SIN postear dentro del mes: «entries-posted» es bloqueante.
    await createJournalEntry(
      g.entityId,
      new Date('2026-10-10'),
      'standard' as never,
      'Borrador sin postear',
      [
        { account_id: g.roles.banco, debit_amount: '50.0000', credit_amount: null, description: 'a' },
        { account_id: g.roles.ingreso, debit_amount: null, credit_amount: '50.0000', description: 'b' },
      ] as never,
      g.userId
    );

    const r = await conductClose(ctxG, octubre, { userId: g.userId });
    expect(r.status).toBe('blocked');
    expect(r.haltedAtStep).toBe('verify-checklist');
    expect(r.steps.map((p) => p.step)).not.toContain('soft-close');
    expect(await periodStatusOf(octubre.id)).toBe('open');
    expect((await openRunOf(g.entityId, octubre.id))?.status).toBe('blocked');
  });

  it('el conductor se niega a continuar sin --resume, y a reanudar lo que no existe', async () => {
    const { g, ctxG } = await ownTenant('Corrida ajena');
    enterTenant(g.tenantId);
    const mayo = await periodOf(g, 5);

    await expect(conductClose(ctxG, mayo, { userId: g.userId, resume: true })).rejects.toMatchObject({
      code: 'CLOSING_RUN_NOTHING_TO_RESUME',
      statusCode: 423,
    });

    await conductClose(ctxG, mayo, { userId: g.userId, stopAt: 'verify-checklist' });
    // La regla vive en el conductor: quien lo llame sin pasar por la hoja
    // tampoco continúa en silencio la corrida de otro.
    const refusal = conductClose(ctxG, await periodOf(g, 5), { userId: g.userId });
    await expect(refusal).rejects.toBeInstanceOf(ClosingRunStateError);
    await expect(refusal).rejects.toMatchObject({ code: 'CLOSING_RUN_OPEN' });
  });

  it('dos conductores sobre el mismo periodo: el segundo se niega mientras el primero lo tiene', async () => {
    const { g, ctxG } = await ownTenant('Dos conductores');
    enterTenant(g.tenantId);
    const junio = await periodOf(g, 6);

    // Otra sesión toma el candado exactamente como lo toma el conductor.
    const otherSession = await getClient();
    try {
      await otherSession.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
        `closing-run:${g.entityId}:${junio.id}`,
      ]);
      await expect(conductClose(ctxG, junio, { userId: g.userId })).rejects.toMatchObject({
        code: 'CLOSING_RUN_IN_PROGRESS',
        statusCode: 423,
      });
      // Y la negativa no abrió ninguna corrida.
      expect(await openRunOf(g.entityId, junio.id)).toBeNull();
    } finally {
      await otherSession.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
        `closing-run:${g.entityId}:${junio.id}`,
      ]);
      otherSession.release();
    }
    expect((await conductClose(ctxG, await periodOf(g, 6), { userId: g.userId })).status).toBe('completed');
  });

  it('el latido del candado nota cuando su transacción muere, y la conexión rota no vuelve al pool', async () => {
    // Detrás de un pooler, o con un tiempo de inactividad en la base, la
    // transacción que sostiene el candado puede terminar a mitad de corrida.
    // Se reproduce matándole el backend desde otra sesión.
    const lockClient = await getClient();
    const killer = await getClient();
    // Sin esto, el backend muerto emite `error` sobre un cliente prestado y el
    // proceso entero cae: exactamente lo que el conductor tiene que evitar.
    const watch = watchLockConnection(lockClient);
    try {
      await lockClient.query('BEGIN');
      const pid = (await lockClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const healthy = startLockKeepalive(lockClient, 10);
      await new Promise((r) => setTimeout(r, 40));
      expect(healthy.lost()).toBeUndefined();
      expect(await healthy.stop()).toBeUndefined();

      const beat = startLockKeepalive(lockClient, 10);
      await killer.query('SELECT pg_terminate_backend($1)', [pid]);
      await new Promise((r) => setTimeout(r, 60));
      expect(beat.lost()).toBeInstanceOf(Error);
      const lost = await beat.stop();
      expect(lost).toBeInstanceOf(Error);
      expect(reportLostLock(lost, f.entityId, uuidv4())).toBe(true);
      expect(reportLostLock(undefined, f.entityId, uuidv4())).toBe(false);
      await new Promise((r) => setTimeout(r, 20));
      expect(watch.error()).toBeInstanceOf(Error);

      // COMMIT sobre el backend muerto falla: la conexión se DESTRUYE.
      let destroyed: boolean | undefined;
      const lockConnection = {
        query: (sql: string) => lockClient.query(sql),
        release: (destroy?: boolean) => {
          destroyed = destroy;
          lockClient.release(true);
        },
      };
      await releaseLockConnection(lockConnection);
      expect(destroyed).toBe(true);
    } finally {
      watch.stop();
      killer.release();
    }
  });

  it('a conductor whose lock connection dies mid-run stops: no later step, no soft close, and no second conductor on top of it', async () => {
    // Witness WIT-01. The first version noticed the dead lock only after the
    // run returned: the engines and the soft close, which use the shared pool,
    // went on while a second conductor could already take the lock.
    const { g, ctxG } = await ownTenant('Lost lock');
    enterTenant(g.tenantId);
    // Real work for a LATER step, so "nothing after the loss" is measured on
    // the ledger too and not only on the step records.
    await addAssetTo(g, 'AF-LOCK', '2026-01-15');
    const march = await periodOf(g, 3);
    const lockKey = `closing-run:${g.entityId}:${march.id}`;
    const killer = await getClient();
    const footprint = async (): Promise<unknown> =>
      (
        await killer.query(
          `SELECT (SELECT count(*) FROM journal_entries WHERE entity_id = $1)::int AS entries,
                  (SELECT count(*) FROM closing_runs WHERE entity_id = $1)::int AS runs,
                  (SELECT string_agg(status, ',') FROM closing_runs WHERE entity_id = $1) AS run_statuses,
                  (SELECT count(*) FROM closing_run_steps WHERE entity_id = $1)::int AS steps,
                  (SELECT status FROM fiscal_periods WHERE id = $2) AS period_status`,
          [g.entityId, march.id]
        )
      ).rows[0];
    const depreciationIn = async (periodId: string): Promise<number> =>
      (
        await query<{ n: number }>(
          `SELECT count(*)::int AS n FROM journal_entries
            WHERE entity_id = $1 AND fiscal_period_id = $2 AND source_type = 'depreciation'`,
          [g.entityId, periodId]
        )
      ).rows[0].n;

    let killed: { heldBy?: number; freed: boolean } = { freed: false };
    let refreshedByItsOwnBeat = false;
    let secondFresh: unknown;
    let secondResume: unknown;
    let before: unknown;
    let after: unknown;
    engineWatch.calls.length = 0;
    try {
      engineWatch.duringProvisions = async () => {
        killed = await killLockOf(killer, lockKey);
        // The heartbeat the INSERT wrote would keep the second conductor out
        // on its own. Age it past the window, so the refusal below can only
        // come from the first conductor's OWN beat, lock or no lock.
        await killer.query(
          `UPDATE closing_runs SET heartbeat_at = NOW() - make_interval(secs => $3)
            WHERE entity_id = $1 AND fiscal_period_id = $2`,
          [g.entityId, march.id, RUN_HEARTBEAT_STALE_AFTER_SECONDS + 1]
        );
        for (let i = 0; i < 400 && !refreshedByItsOwnBeat; i++) {
          const age = await killer.query<{ age: number }>(
            `SELECT EXTRACT(EPOCH FROM (NOW() - heartbeat_at))::int AS age
               FROM closing_runs WHERE entity_id = $1 AND fiscal_period_id = $2`,
            [g.entityId, march.id]
          );
          refreshedByItsOwnBeat = age.rows[0].age < RUN_HEARTBEAT_STALE_AFTER_SECONDS;
          if (!refreshedByItsOwnBeat) await new Promise((r) => setTimeout(r, 25));
        }
        // The lock is FREE now, and the first conductor is still inside its
        // first step. A second conductor takes the lock — and must still stay out.
        before = await footprint();
        secondFresh = await conductClose(ctxG, march, { userId: g.userId }).catch((e: unknown) => e);
        secondResume = await conductClose(ctxG, march, { userId: g.userId, resume: true }).catch((e: unknown) => e);
        after = await footprint();
      };

      const first = conductClose(ctxG, march, { userId: g.userId });
      await expect(first).rejects.toBeInstanceOf(ClosingRunStateError);
      await expect(first).rejects.toMatchObject({
        code: 'CLOSING_RUN_LOCK_LOST',
        statusCode: 423,
        details: { haltedAtStep: 'amortize-prepaids', stepRan: false, takenOver: false, stepsTaken: ['accrue-benefits'] },
      });
    } finally {
      engineWatch.duringProvisions = undefined;
      killer.release();
    }

    expect(killed.heldBy).toBeTypeOf('number');
    expect(killed.freed).toBe(true);
    expect(refreshedByItsOwnBeat).toBe(true);
    for (const refusal of [secondFresh, secondResume]) {
      expect(refusal).toBeInstanceOf(ClosingRunStateError);
      expect(refusal).toMatchObject({ code: 'CLOSING_RUN_IN_PROGRESS', statusCode: 423 });
    }
    // The refused conductors wrote nothing, not even an abandoned or a new run.
    expect(after).toEqual(before);

    // The step in flight finished; nothing started after it — not the other
    // engines, not the soft close (the refused conductors never reached one).
    expect(engineWatch.calls).toEqual(['accrue-benefits']);
    expect(await depreciationIn(march.id)).toBe(0);
    expect(await periodStatusOf(march.id)).toBe('open');
    const run = await query<{ id: string; status: string; halted_at_step: string }>(
      'SELECT id, status, halted_at_step FROM closing_runs WHERE entity_id = $1 AND fiscal_period_id = $2',
      [g.entityId, march.id]
    );
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0]).toMatchObject({ status: 'failed', halted_at_step: 'amortize-prepaids' });
    const recorded = await query<{ step_key: string }>(
      'SELECT step_key FROM closing_run_steps WHERE run_id = $1',
      [run.rows[0].id]
    );
    expect(recorded.rows.map((x) => x.step_key)).toEqual(['accrue-benefits']);

    // Once the first conductor has stopped, the run is resumable, and resuming
    // it is what depreciates and closes the month.
    const resumed = await conductClose(ctxG, await periodOf(g, 3), { userId: g.userId, resume: true });
    expect(resumed.runId).toBe(run.rows[0].id);
    expect(resumed.status).toBe('completed');
    expect(await depreciationIn(march.id)).toBeGreaterThan(0);
    expect(await periodStatusOf(march.id)).toBe('soft_close');
  });

  it('a lock lost while the checklist is judged stops the run at the door of the soft close', async () => {
    const { g, ctxG } = await ownTenant('Lost lock at the checklist');
    enterTenant(g.tenantId);
    const may = await periodOf(g, 5);
    const lockKey = `closing-run:${g.entityId}:${may.id}`;
    const killer = await getClient();
    let killed: { heldBy?: number; freed: boolean } = { freed: false };
    engineWatch.calls.length = 0;
    try {
      engineWatch.duringChecklist = async () => {
        killed = await killLockOf(killer, lockKey);
      };
      await expect(conductClose(ctxG, may, { userId: g.userId })).rejects.toMatchObject({
        code: 'CLOSING_RUN_LOCK_LOST',
        details: {
          haltedAtStep: 'soft-close',
          stepRan: false,
          stepsTaken: ['accrue-benefits', 'amortize-prepaids', 'depreciate-assets', 'verify-checklist'],
        },
      });
    } finally {
      engineWatch.duringChecklist = undefined;
      killer.release();
    }
    expect(killed.freed).toBe(true);
    expect(engineWatch.calls).not.toContain('soft-close');
    expect(await periodStatusOf(may.id)).toBe('open');
    expect((await openRunOf(g.entityId, may.id))).toMatchObject({ status: 'failed', halted_at_step: 'soft-close' });
  });

  it('a conductor taken over while its step was in flight writes nothing into the run its successor conducts', async () => {
    // Review of the WIT-01 fix: a conductor paused past the window (a stopped
    // process, a laptop asleep) can be taken over; when it wakes up, its step
    // record and its "failed" used to land on the successor's live run.
    const { g, ctxG } = await ownTenant('Taken over');
    enterTenant(g.tenantId);
    const june = await periodOf(g, 6);
    engineWatch.calls.length = 0;
    try {
      engineWatch.duringProvisions = async () => {
        // What the successor's claim leaves on the row: its own token, beating.
        await query(
          `UPDATE closing_runs SET conductor_token = uuid_generate_v4(), heartbeat_at = NOW()
            WHERE entity_id = $1 AND fiscal_period_id = $2`,
          [g.entityId, june.id]
        );
      };
      const refusal = (await conductClose(ctxG, june, { userId: g.userId }).catch((e: unknown) => e)) as ClosingRunStateError;
      expect(refusal).toMatchObject({
        code: 'CLOSING_RUN_LOCK_LOST',
        // The step RAN — its engine was called — and could not be recorded: not "not started".
        details: { haltedAtStep: 'accrue-benefits', stepRan: true, takenOver: true, stepsTaken: [] },
      });
      // And the run is another conductor's now: no advice to resume it.
      expect(refusal.message).toMatch(/after accrue-benefits ran, without its record/);
      expect(refusal.message).toMatch(/ended or taken over by another conductor/);
      expect(refusal.message).not.toMatch(/--resume/);
    } finally {
      engineWatch.duringProvisions = undefined;
    }
    const run = await query<{ id: string; status: string; ended_at: string | null }>(
      'SELECT id, status, ended_at FROM closing_runs WHERE entity_id = $1 AND fiscal_period_id = $2',
      [g.entityId, june.id]
    );
    // Still the successor's: running, not ended, and not one step recorded by the displaced conductor.
    expect(run.rows).toEqual([expect.objectContaining({ status: 'running', ended_at: null })]);
    const recorded = await query('SELECT 1 FROM closing_run_steps WHERE run_id = $1', [run.rows[0].id]);
    expect(recorded.rows).toHaveLength(0);
    expect(engineWatch.calls).toEqual(['accrue-benefits']);
  });

  it('a conductor taken over between two steps is not told to resume the run: its guarded close finds out', async () => {
    // Third review: the checkpoint stops on the dead lock or on silence and
    // cannot know the run was claimed meanwhile; the close it then attempts can.
    const { g, ctxG } = await ownTenant('Taken over between steps');
    enterTenant(g.tenantId);
    const august = await periodOf(g, 8);
    const lockKey = `closing-run:${g.entityId}:${august.id}`;
    const killer = await getClient();
    try {
      engineWatch.afterRecordOf = {
        step: 'accrue-benefits',
        act: async () => {
          await killLockOf(killer, lockKey);
          await killer.query(
            `UPDATE closing_runs SET conductor_token = uuid_generate_v4(), heartbeat_at = NOW()
              WHERE entity_id = $1 AND fiscal_period_id = $2`,
            [g.entityId, august.id]
          );
        },
      };
      const refusal = (await conductClose(ctxG, august, { userId: g.userId }).catch((e: unknown) => e)) as ClosingRunStateError;
      expect(refusal).toMatchObject({
        code: 'CLOSING_RUN_LOCK_LOST',
        details: {
          haltedAtStep: 'amortize-prepaids',
          stepRan: false,
          stepRecorded: false,
          takenOver: true,
          stepsTaken: ['accrue-benefits'],
        },
      });
      expect(refusal.message).toMatch(/before amortize-prepaids/);
      expect(refusal.message).not.toMatch(/--resume/);
    } finally {
      engineWatch.afterRecordOf = undefined;
      killer.release();
    }
    expect((await openRunOf(g.entityId, august.id))?.status).toBe('running');
  });

  it('a run whose last step was recorded, and then taken over before its close, says so', async () => {
    const { g, ctxG } = await ownTenant('Taken over at the close');
    enterTenant(g.tenantId);
    const october = await periodOf(g, 10);
    try {
      engineWatch.afterRecordOf = {
        step: 'soft-close',
        act: async () => {
          await query(
            `UPDATE closing_runs SET conductor_token = uuid_generate_v4(), heartbeat_at = NOW()
              WHERE entity_id = $1 AND fiscal_period_id = $2`,
            [g.entityId, october.id]
          );
        },
      };
      const refusal = (await conductClose(ctxG, october, { userId: g.userId }).catch((e: unknown) => e)) as ClosingRunStateError;
      expect(refusal).toMatchObject({
        code: 'CLOSING_RUN_LOCK_LOST',
        details: { haltedAtStep: 'soft-close', stepRan: true, stepRecorded: true, takenOver: true },
      });
      expect(refusal.message).toMatch(/after soft-close and its record, without closing the run, after 5 recorded step\(s\)/);
      expect(refusal.message).toMatch(/ended or taken over by another conductor/);
      expect(refusal.message).not.toMatch(/--resume/);
    } finally {
      engineWatch.afterRecordOf = undefined;
    }
    // The soft close did happen, and its record stands; the run was not this conductor's to close.
    expect(await periodStatusOf(october.id)).toBe('soft_close');
  });

  it('a close cycle ended by another path does not abandon a run whose conductor is still beating', async () => {
    // Fourth review: the refusal that reads before it is not what protects a
    // live run from `abandonStaleRuns` — its own write has to ask.
    const { g, ctxG } = await ownTenant('Abandon only the silent');
    enterTenant(g.tenantId);
    const november = await periodOf(g, 11);
    const stopped = await conductClose(ctxG, november, { userId: g.userId, stopAt: 'accrue-benefits' });
    // A close cycle ended by another path after the run started, the period open again.
    await query(`UPDATE fiscal_periods SET soft_close_date = NOW() + interval '1 minute' WHERE id = $1`, [november.id]);

    await query(`UPDATE closing_runs SET status = 'running', heartbeat_at = NOW() WHERE id = $1`, [stopped.runId]);
    await abandonStaleRuns(g.entityId, november.id);
    expect((await query<{ status: string }>('SELECT status FROM closing_runs WHERE id = $1', [stopped.runId])).rows[0].status).toBe('running');

    await query(`UPDATE closing_runs SET heartbeat_at = NOW() - interval '1 hour' WHERE id = $1`, [stopped.runId]);
    await abandonStaleRuns(g.entityId, november.id);
    expect((await query<{ status: string }>('SELECT status FROM closing_runs WHERE id = $1', [stopped.runId])).rows[0].status).toBe('abandoned');
  });

  it('a running run heard from recently is not resumed while its lock is free; one silent past the window is', async () => {
    const { g, ctxG } = await ownTenant('Live heartbeat');
    enterTenant(g.tenantId);
    const april = await periodOf(g, 4);
    const stopped = await conductClose(ctxG, april, { userId: g.userId, stopAt: 'depreciate-assets' });

    // What a conductor that lost its lock connection looks like from outside:
    // `running`, lock free, heartbeat fresh.
    await query(`UPDATE closing_runs SET status = 'running', heartbeat_at = NOW() WHERE id = $1`, [stopped.runId]);
    for (const opts of [{ resume: true }, {}]) {
      await expect(
        conductClose(ctxG, await periodOf(g, 4), { userId: g.userId, stopAt: 'soft-close', ...opts })
      ).rejects.toMatchObject({ code: 'CLOSING_RUN_IN_PROGRESS', details: { runId: stopped.runId } });
    }
    expect((await openRunOf(g.entityId, april.id))?.status).toBe('running');
    expect(await liveRunOf(g.entityId, april.id)).toMatchObject({ id: stopped.runId });

    // What a conductor that died looks like: silent for longer than the window.
    await query(
      `UPDATE closing_runs SET heartbeat_at = NOW() - make_interval(secs => $2) WHERE id = $1`,
      [stopped.runId, RUN_HEARTBEAT_STALE_AFTER_SECONDS + 1]
    );
    expect(await liveRunOf(g.entityId, april.id)).toBeNull();
    const resumed = await conductClose(ctxG, await periodOf(g, 4), { userId: g.userId, resume: true, stopAt: 'soft-close' });
    expect(resumed.runId).toBe(stopped.runId);
    expect(resumed.status).toBe('stopped');
  });

  it('the run heartbeat moves while the run is this conductor\'s, and stops the next step once another claims it', async () => {
    const { g, ctxG } = await ownTenant('Heartbeat');
    enterTenant(g.tenantId);
    const stopped = await conductClose(ctxG, await periodOf(g, 9), { userId: g.userId, stopAt: 'accrue-benefits' });
    const claim = { runId: stopped.runId as string, entityId: g.entityId, token: uuidv4() };
    await query(
      `UPDATE closing_runs SET status = 'running', conductor_token = $2, heartbeat_at = NOW() - interval '1 hour'
        WHERE id = $1`,
      [claim.runId, claim.token]
    );
    const heartbeatAge = async (): Promise<number> =>
      (
        await query<{ age: number }>(
          'SELECT EXTRACT(EPOCH FROM (NOW() - heartbeat_at))::int AS age FROM closing_runs WHERE id = $1',
          [claim.runId]
        )
      ).rows[0].age;
    /** Polls instead of sleeping a fixed time: a beat goes through the pool, and CI can be slow. */
    const eventually = async (condition: () => Promise<boolean> | boolean): Promise<boolean> => {
      for (let i = 0; i < 200; i++) {
        if (await condition()) return true;
        await new Promise((r) => setTimeout(r, 10));
      }
      return false;
    };
    const throws = (f: () => void): boolean => {
      try {
        f();
        return false;
      } catch {
        return true;
      }
    };

    const beating = startRunHeartbeat(claim, 10, 60_000);
    try {
      expect(await eventually(async () => (await heartbeatAge()) < 5)).toBe(true);
      expect(() => beating.assertBeating()).not.toThrow();

      // Another conductor claims the run: this one's beats match nothing now.
      await query('UPDATE closing_runs SET conductor_token = $2 WHERE id = $1', [claim.runId, uuidv4()]);
      expect(await eventually(() => throws(() => beating.assertBeating()))).toBe(true);
      expect(() => beating.assertBeating()).toThrow(ClosingRunStateError);
    } finally {
      await beating.stop();
    }

    // Silence alone stops the next step: nothing landed within the limit.
    const silent = startRunHeartbeat(claim, 60_000, 20);
    try {
      expect(() => silent.assertBeating()).not.toThrow();
      expect(await eventually(() => throws(() => silent.assertBeating()))).toBe(true);
    } finally {
      await silent.stop();
    }

    // Beats that FAIL are not a takeover — and they do not count as beats:
    // the silence grows until the limit stops the next step.
    const failing = startRunHeartbeat({ ...claim, runId: 'not-a-uuid' }, 10, 80);
    try {
      expect(() => failing.assertBeating()).not.toThrow();
      expect(await eventually(() => throws(() => failing.assertBeating()))).toBe(true);
      let stopped: unknown;
      try {
        failing.assertBeating();
      } catch (e) {
        stopped = e;
      }
      expect(stopped).toMatchObject({ code: 'CLOSING_RUN_LOCK_LOST', details: { takenOver: false } });
    } finally {
      await failing.stop();
    }
  });

  it('the claim re-asks in the write itself: nobody live, the run resumable, the period open', async () => {
    // Review of the WIT-01 fix: a conductor paused inside openRun, after its
    // reads and before its write, woke up after another conductor had closed
    // the month — and put the run that closed it back to running, then failed.
    const { g, ctxG } = await ownTenant('Claim');
    enterTenant(g.tenantId);
    const july = await periodOf(g, 7);
    const august = await periodOf(g, 8);
    const stopped = await conductClose(ctxG, july, { userId: g.userId, stopAt: 'accrue-benefits' });
    const runId = stopped.runId as string;
    const claimWith = (token: string) => ({ runId, entityId: g.entityId, token });

    // Somebody is live on it.
    await query(`UPDATE closing_runs SET status = 'running', heartbeat_at = NOW() WHERE id = $1`, [runId]);
    expect(await claimRun(claimWith(uuidv4()))).toBe(false);
    // Silent past the window: resumable, and the claim records who took it.
    await query(`UPDATE closing_runs SET heartbeat_at = NOW() - interval '1 hour' WHERE id = $1`, [runId]);
    const token = uuidv4();
    expect(await claimRun(claimWith(token))).toBe(true);
    expect((await query<{ t: string }>('SELECT conductor_token::text AS t FROM closing_runs WHERE id = $1', [runId])).rows[0].t).toBe(token);
    // A run that already completed is not taken back.
    await query(
      `UPDATE closing_runs SET status = 'completed', halted_at_step = NULL, ended_at = NOW() WHERE id = $1`,
      [runId]
    );
    expect(await claimRun(claimWith(uuidv4()))).toBe(false);
    // Nor a resumable run on a period that is no longer open — refused by the
    // period's STATUS alone: the run is made to look started after the close,
    // so the soft-close-date condition cannot be the one refusing.
    await query(`UPDATE closing_runs SET status = 'stopped', ended_at = NULL WHERE id = $1`, [runId]);
    await softClosePeriod(july.id, g.entityId, g.userId, 'closed by hand while a conductor slept');
    await query(`UPDATE closing_runs SET started_at = NOW() + interval '1 minute' WHERE id = $1`, [runId]);
    expect(await claimRun(claimWith(uuidv4()))).toBe(false);
    expect((await query<{ status: string }>('SELECT status FROM closing_runs WHERE id = $1', [runId])).rows[0].status).toBe('stopped');

    // A new run: not on a closed period — with no resumable run left there, so
    // only the period guard can refuse it —, and not next to another resumable run.
    await query(`UPDATE closing_runs SET status = 'completed', halted_at_step = NULL, ended_at = NOW() WHERE id = $1`, [runId]);
    expect(await startRun(g.entityId, july.id, g.userId, uuidv4())).toBeNull();
    const fresh = await startRun(g.entityId, august.id, g.userId, uuidv4());
    expect(fresh).toEqual(expect.any(String));
    expect(await startRun(g.entityId, august.id, g.userId, uuidv4())).toBeNull();
  });

  it('the lease probes the lock transaction when nothing was seen failing, and refuses on what was', async () => {
    const probed: string[] = [];
    const healthy = createConductorLease(
      { query: async (sql: string) => { probed.push(sql); return {}; } },
      () => undefined
    );
    await expect(healthy.assertHeld()).resolves.toBeUndefined();
    expect(probed).toEqual(['SELECT 1']);

    // The session ended without an `error` event reaching the watcher: only the probe can tell.
    const silentlyGone = createConductorLease(
      { query: async () => { throw new Error('the session ended'); } },
      () => undefined
    );
    await expect(silentlyGone.assertHeld()).rejects.toMatchObject({
      code: 'CLOSING_RUN_LOCK_LOST',
      details: { cause: 'Error: the session ended' },
    });

    const seen = createConductorLease(
      { query: async () => { throw new Error('must not be asked'); } },
      () => new Error('seen by the watcher')
    );
    await expect(seen.assertHeld()).rejects.toMatchObject({
      code: 'CLOSING_RUN_LOCK_LOST',
      details: { cause: 'Error: seen by the watcher' },
    });
  });

  it('el ensayo no escribe nada, y evalúa el checklist aunque haya un intento anterior', async () => {
    const { g, ctxG } = await ownTenant('Ensayo del conductor');
    enterTenant(g.tenantId);
    const febrero = await periodOf(g, 2);

    const r = await conductClose(ctxG, febrero, { userId: g.userId, dryRun: true });
    expect(r.status).toBe('previewed');
    expect(r.runId).toBeNull();
    expect(r.steps.find((p) => p.step === 'accrue-benefits')?.status).toBe('pending');
    expect(r.steps.find((p) => p.step === 'soft-close')?.status).toBe('pending');
    const checklist = r.steps.find((p) => p.step === 'verify-checklist');
    expect(checklist?.status).toBe('done');
    expect(checklist?.processed).toBeGreaterThan(0);

    const runCount = await query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM closing_runs WHERE entity_id = $1',
      [g.entityId]
    );
    expect(runCount.rows[0].n).toBe('0');
    expect(await periodStatusOf(febrero.id)).toBe('open');
  });

  it('el ensayo dice dónde se detendría: por --stop-at, o porque el checklist bloquearía', async () => {
    const { g, ctxG } = await ownTenant('Ensayo que se detiene');
    enterTenant(g.tenantId);
    const julio = await periodOf(g, 7);

    const parado = await conductClose(ctxG, julio, { userId: g.userId, dryRun: true, stopAt: 'depreciate-assets' });
    expect(parado.haltedAtStep).toBe('depreciate-assets');
    expect(parado.steps.map((p) => p.step)).toEqual(['accrue-benefits', 'amortize-prepaids']);

    await createJournalEntry(
      g.entityId,
      new Date('2026-07-10'),
      'standard' as never,
      'Borrador sin postear',
      [
        { account_id: g.roles.banco, debit_amount: '50.0000', credit_amount: null, description: 'a' },
        { account_id: g.roles.ingreso, debit_amount: null, credit_amount: '50.0000', description: 'b' },
      ] as never,
      g.userId
    );
    const blockedPreview = await conductClose(ctxG, await periodOf(g, 7), { userId: g.userId, dryRun: true });
    expect(blockedPreview.status).toBe('previewed');
    expect(blockedPreview.haltedAtStep).toBe('verify-checklist');
    expect(blockedPreview.steps.map((p) => p.step)).not.toContain('soft-close');
  });

  it('un paso inventado se niega antes de tocar nada', async () => {
    enterTenant(f.tenantId);
    await expect(
      conductClose(ctx, await periodOf(f, 9), { userId: f.userId, stopAt: 'hard-close' as never })
    ).rejects.toMatchObject({ code: 'UNKNOWN_CLOSING_STEP' });
    expect(await openRunOf(f.entityId, (await periodOf(f, 9)).id)).toBeNull();
  });

  it('las lecturas de la hoja: la última corrida, la corrida abierta descrita y el último mes cerrado', async () => {
    const { g, ctxG } = await ownTenant('Lecturas del conductor');
    enterTenant(g.tenantId);
    expect(await latestClosedPeriodOf(g.entityId)).toBeNull();

    const enero = await periodOf(g, 1);
    const parado = await conductClose(ctxG, enero, { userId: g.userId, stopAt: 'soft-close' });
    const openRow = await openRunOf(g.entityId, enero.id);
    expect(openRow).not.toBeNull();
    expect(describeOpenRun(openRow!)).toMatch(/^stopped at soft-close, started /);
    expect((await latestRunOf(g.entityId, enero.id))?.id).toBe(parado.runId);

    await conductClose(ctxG, await periodOf(g, 1), { userId: g.userId, resume: true });
    const febrero = await periodOf(g, 2);
    await conductClose(ctxG, febrero, { userId: g.userId });
    // El último cerrado es febrero, no el más viejo: el mes que se acaba de entregar.
    expect((await latestClosedPeriodOf(g.entityId))?.id).toBe(febrero.id);
  });

  it('un motor que revienta queda escrito con su causa, y la corrida se reanuda tras arreglarlo', async () => {
    const { g, ctxG } = await ownTenant('Motor que revienta');
    enterTenant(g.tenantId);
    const abril = await periodOf(g, 4);

    const torcida = await query(
      `UPDATE policy_decisions SET resolved_value = 'lo_que_sea', status = 'resolved'
        WHERE key = 'base_depreciacion' AND (entity_id = $1 OR entity_id IS NULL)`,
      [g.entityId]
    );
    expect(torcida.rowCount, 'la política no se torció: la prueba no probaría nada').toBeGreaterThan(0);

    const r = await conductClose(ctxG, abril, { userId: g.userId });
    expect(r.status).toBe('failed');
    expect(r.haltedAtStep).toBe('depreciate-assets');
    const step = r.steps.find((p) => p.step === 'depreciate-assets');
    expect(step?.status).toBe('failed');
    expect(step?.detail).toMatch(/base_depreciacion/);
    // La causa viaja —no se persiste— para que la hoja salga con el código
    // que el error merece: un ValidationError del panel es un 422.
    expect((step?.cause as { statusCode?: number } | undefined)?.statusCode).toBe(422);

    await query(
      `UPDATE policy_decisions SET resolved_value = 'vida_util_nif'
        WHERE key = 'base_depreciacion' AND (entity_id = $1 OR entity_id IS NULL)`,
      [g.entityId]
    );
    const seguir = await conductClose(ctxG, await periodOf(g, 4), { userId: g.userId, resume: true });
    expect(seguir.runId).toBe(r.runId);
    expect(seguir.status).toBe('completed');
  });

  it('nunca hay dos corridas abiertas del mismo periodo', async () => {
    const { g } = await ownTenant('Una sola corrida');
    enterTenant(g.tenantId);
    const december = await periodOf(g, 12);
    await query(
      `INSERT INTO closing_runs (entity_id, fiscal_period_id, status) VALUES ($1, $2, 'blocked')`,
      [g.entityId, december.id]
    );
    await expect(
      query(
        `INSERT INTO closing_runs (entity_id, fiscal_period_id, status) VALUES ($1, $2, 'running')`,
        [g.entityId, december.id]
      )
    ).rejects.toThrow(/uq_closing_run_open|duplicate key/);
  });

  it('un paso de OTRA entidad no se puede colgar de esta corrida', async () => {
    enterTenant(f.tenantId);
    // Una corrida SIN pasos, para que la única restricción que pueda hablar
    // sea la foránea compuesta y no la UNIQUE del paso.
    const december = await periodOf(f, 12);
    const run = await query<{ id: string }>(
      `INSERT INTO closing_runs (entity_id, fiscal_period_id, status)
       VALUES ($1, $2, 'running') RETURNING id`,
      [f.entityId, december.id]
    );
    await expect(
      query(
        `INSERT INTO closing_run_steps (entity_id, run_id, step_key, ordinal, status, detail)
         VALUES ($1, $2, 'soft-close', 5, 'done', 'colado')`,
        [hermana.entityId, run.rows[0].id]
      )
    ).rejects.toThrow(/fk_closing_step_run_entity|violates foreign key/);
    await expect(
      query(
        `INSERT INTO closing_run_steps (entity_id, run_id, step_key, ordinal, status, detail)
         VALUES ($1, $2, 'soft-close', 5, 'done', 'legítimo')`,
        [f.entityId, run.rows[0].id]
      )
    ).resolves.toBeDefined();
  });

  it('las tres tablas se aíslan por ENTIDAD-en-inquilino, no sólo por inquilino', async () => {
    // Con `tenant_id` propio, el bucle de rls-policies.sql generaba
    // `tenant_id = app_current_tenant()`, que no ata la entidad al inquilino:
    // un inquilino podía plantar una corrida abierta invisible sobre el periodo
    // de otro y bloquearle el cierre. Sin esa columna, la política pasa por
    // legal_entities. Se pregunta a la base qué política quedó puesta.
    const policies = await query<{ tablename: string; qual: string }>(
      `SELECT tablename, qual FROM pg_policies
        WHERE tablename IN ('closing_runs', 'closing_run_steps', 'closing_packs')
          AND policyname = 'tenant_isolation'
        ORDER BY tablename`
    );
    expect(policies.rows.map((p) => p.tablename)).toEqual([
      'closing_packs',
      'closing_run_steps',
      'closing_runs',
    ]);
    for (const p of policies.rows) expect(p.qual, p.tablename).toMatch(/legal_entities/);
  });
});

describe('A6 · el expediente, y la prueba de aceptación', () => {
  it('LA PRUEBA DE ACEPTACIÓN: dos sellados del mismo mes dan el MISMO sello', async () => {
    enterTenant(f.tenantId);
    const julio = await periodOf(f, JULIO);
    const first = await buildClosingPack(f.entityId, julio.id, { userId: f.userId, now: new Date('2026-08-01T10:00:00Z') });
    const second = await buildClosingPack(f.entityId, julio.id, { userId: f.userId, now: new Date('2026-08-01T10:05:00Z') });
    expect(second.envelope.generated_at).not.toBe(first.envelope.generated_at);
    expect(second.seal).toBe(first.seal);
    expect(second.sealed).toEqual(first.sealed);
  });

  it('el tercero vuelve a correr el ARCHIVO emitido y los libros lo sostienen', async () => {
    enterTenant(f.tenantId);
    const julio = await periodOf(f, JULIO);
    const pack = await buildClosingPack(f.entityId, julio.id, { userId: f.userId });
    await storeClosingPack(f.entityId, julio.id, pack);

    const fromFile = parseClosingPack(JSON.stringify(pack, null, 2));
    const v = await verifyClosingPack(fromFile);
    expect(v.sealIntact).toBe(true);
    expect(v.issued).toBe(true);
    expect(v.envelopeMatches).toBe(true);
    expect(v.figuresReproduce, JSON.stringify(v.differences)).toBe(true);
    expect(v.identityUnchanged).toBe(true);
    expect(verdictFindings(v)).toEqual({ blocking: 0, warning: 0 });
  });

  it('un expediente EDITADO Y VUELTO A SELLAR concuerda consigo mismo, y no fue emitido', async () => {
    // El caso de la revisión: se toma el expediente de julio, se le pegan las
    // cifras de hoy y se recalcula el SHA-256, que no lleva llave. Concuerda
    // consigo mismo y con los libros; lo único que lo delata es el registro.
    const { g } = await ownTenant('Expediente forjado');
    enterTenant(g.tenantId);
    const marzo = await periodOf(g, 3);
    await postEntryOn(g, '2026-03-10', '700.0000');
    const issuedPack = await buildClosingPack(g.entityId, marzo.id, { userId: g.userId });
    await storeClosingPack(g.entityId, marzo.id, issuedPack);

    await postEntryOn(g, '2026-03-20', '300.0000');
    const forjado = structuredClone(issuedPack);
    forjado.sealed = await deriveSealedBody(g.entityId, marzo.id);
    forjado.seal = sealOf(forjado.sealed);

    const v = await verifyClosingPack(forjado);
    expect(v.sealIntact).toBe(true);
    expect(v.figuresReproduce).toBe(true);
    expect(v.issued).toBe(false);
    expect(verdictFindings(v).blocking).toBe(1);
  });

  it('la fecha de corte es la del periodo, no el reloj', async () => {
    enterTenant(f.tenantId);
    const body = await deriveSealedBody(f.entityId, (await periodOf(f, JULIO)).id);
    expect(body.as_of).toBe('2026-07-31');
    expect(body.as_of).toBe(body.period.end_date);
  });

  it('un peso nuevo dentro del periodo rompe la comprobación, y la ruta nombra la cuenta por su código', async () => {
    const { g } = await ownTenant('Expediente que deriva');
    enterTenant(g.tenantId);
    const abril = await periodOf(g, 4);
    await postEntryOn(g, '2026-04-10', '700.0000');
    const pack = await buildClosingPack(g.entityId, abril.id, { userId: g.userId });
    await storeClosingPack(g.entityId, abril.id, pack);
    expect((await verifyClosingPack(pack)).figuresReproduce).toBe(true);

    await postEntryOn(g, '2026-04-20', '300.0000');
    const v = await verifyClosingPack(pack);
    expect(v.sealIntact).toBe(true);
    expect(v.issued).toBe(true);
    expect(v.figuresReproduce).toBe(false);
    const bankAccount = await query<{ code: string }>('SELECT code FROM accounts WHERE id = $1', [g.roles.banco]);
    const paths = v.differences.map((d) => d.path);
    expect(paths).toContain(`figures.trial_balance[${bankAccount.rows[0].code}].debit`);
    const total = v.differences.find((d) => d.path === 'figures.totals.debit');
    expect(total).toMatchObject({ kind: 'figure', expected: '700.0000', actual: '1000.0000' });
  });

  it('dar de alta una cuenta VACÍA después de sellar no rompe el expediente', async () => {
    // El hallazgo más caro de la revisión: la balanza conserva las cuentas sin
    // movimiento, y se comparaba por posición. Una subcuenta nueva en medio del
    // catálogo hacía que TODO expediente anterior fallara, acusando a cada
    // cuenta de después.
    const { g } = await ownTenant('Subcuenta nueva');
    enterTenant(g.tenantId);
    const mayo = await periodOf(g, 5);
    await postEntryOn(g, '2026-05-10', '400.0000');
    const pack = await buildClosingPack(g.entityId, mayo.id, { userId: g.userId });
    await storeClosingPack(g.entityId, mayo.id, pack);

    await query(
      `INSERT INTO accounts (id, code, name, account_type, fs_category, entity_id, normal_balance, created_by)
       VALUES ($1, '1105', 'Subcuenta nueva sin movimiento', 'asset', 'current_assets', $2, 'debit', $3)`,
      [uuidv4(), g.entityId, g.userId]
    );

    const v = await verifyClosingPack(pack);
    expect(v.figuresReproduce, JSON.stringify(v.differences)).toBe(true);
    expect(v.differences).toEqual([]);
  });

  it('cambiar el panel de informes después de sellar no mueve ninguna cifra', async () => {
    // La segunda revisión: sellar el VALOR del panel no bastaba, porque la
    // comprobación volvía a derivar bajo el panel de hoy. Con un asiento de
    // cierre dentro del corte y `informes_asientos_de_cierre` pasado a
    // `excluir_siempre`, la balanza del informe cambia; la de los libros, no.
    const { g } = await ownTenant('Panel que cambia');
    enterTenant(g.tenantId);
    const julio = await periodOf(g, 7);
    await postEntryOn(g, '2026-07-10', '500.0000');
    await createJournalEntry(
      g.entityId,
      new Date('2026-07-31'),
      'closing' as never,
      'Asiento de cierre de prueba',
      [
        { account_id: g.roles.ingreso, debit_amount: '500.0000', credit_amount: null, description: 'barrido' },
        { account_id: g.roles.banco, debit_amount: null, credit_amount: '500.0000', description: 'contra' },
      ] as never,
      g.userId,
      { autoPost: true, sourceType: 'period_close' }
    );
    const pack = await buildClosingPack(g.entityId, julio.id, { userId: g.userId });
    await storeClosingPack(g.entityId, julio.id, pack);

    const moved = await query(
      `UPDATE policy_decisions SET resolved_value = 'excluir_siempre', status = 'resolved'
        WHERE key = 'informes_asientos_de_cierre' AND (entity_id = $1 OR entity_id IS NULL)`,
      [g.entityId]
    );
    expect(moved.rowCount, 'el panel no se movió: la prueba no probaría nada').toBeGreaterThan(0);

    const v = await verifyClosingPack(pack);
    expect(v.figuresReproduce, JSON.stringify(v.differences)).toBe(true);
    expect(v.differences).toEqual([]);
  });

  it('un asiento en BORRADOR dentro del periodo no mueve el expediente', async () => {
    const { g } = await ownTenant('Borrador tras sellar');
    enterTenant(g.tenantId);
    const agosto = await periodOf(g, 8);
    await postEntryOn(g, '2026-08-10', '300.0000');
    const pack = await buildClosingPack(g.entityId, agosto.id, { userId: g.userId });
    await storeClosingPack(g.entityId, agosto.id, pack);

    await createJournalEntry(
      g.entityId,
      new Date('2026-08-15'),
      'standard' as never,
      'Borrador que nadie posteó',
      [
        { account_id: g.roles.banco, debit_amount: '999.0000', credit_amount: null, description: 'a' },
        { account_id: g.roles.ingreso, debit_amount: null, credit_amount: '999.0000', description: 'b' },
      ] as never,
      g.userId
    );
    const v = await verifyClosingPack(pack);
    expect(v.figuresReproduce, JSON.stringify(v.differences)).toBe(true);
  });

  it('un renombre de la entidad es un AVISO de identidad, no una cifra movida', async () => {
    const { g } = await ownTenant('Sociedad que se renombra');
    enterTenant(g.tenantId);
    const junio = await periodOf(g, 6);
    await postEntryOn(g, '2026-06-10', '250.0000');
    const pack = await buildClosingPack(g.entityId, junio.id, { userId: g.userId });
    await storeClosingPack(g.entityId, junio.id, pack);

    await query(`UPDATE legal_entities SET name = 'Sociedad Renombrada SA de CV' WHERE id = $1`, [g.entityId]);
    const v = await verifyClosingPack(pack);
    expect(v.sealIntact).toBe(true);
    expect(v.issued).toBe(true);
    expect(v.figuresReproduce).toBe(true);
    expect(v.identityUnchanged).toBe(false);
    expect(verdictFindings(v)).toEqual({ blocking: 0, warning: 1 });
  });

  it('un sobre reescrito sobre un expediente emitido se nota como aviso', async () => {
    enterTenant(f.tenantId);
    const julio = await periodOf(f, JULIO);
    const pack = await buildClosingPack(f.entityId, julio.id, { userId: f.userId });
    await storeClosingPack(f.entityId, julio.id, pack);

    const retocado = structuredClone(pack);
    retocado.envelope.generated_by = uuidv4();
    const v = await verifyClosingPack(retocado);
    expect(v.sealIntact).toBe(true);
    expect(v.issued).toBe(true);
    expect(v.envelopeMatches).toBe(false);
    expect(verdictFindings(v)).toEqual({ blocking: 0, warning: 1 });
  });

  it('un expediente cuyo periodo se editó es un hallazgo, no un «no encontrado»', async () => {
    enterTenant(f.tenantId);
    const julio = await periodOf(f, JULIO);
    const pack = await buildClosingPack(f.entityId, julio.id, { userId: f.userId });
    const editado = structuredClone(pack);
    editado.sealed.period.id = uuidv4();

    const v = await verifyClosingPack(editado);
    expect(v.sealIntact).toBe(false);
    expect(v.figuresReproduce).toBe(false);
    expect(v.differences.map((d) => d.path)).toContain('period.id');
    expect(verdictFindings(v).blocking).toBeGreaterThan(0);
  });

  it('el archivo del tercero se lee con desconfianza: lo que no es un expediente se niega antes de la base', async () => {
    enterTenant(f.tenantId);
    const pack = await buildClosingPack(f.entityId, (await periodOf(f, JULIO)).id, { userId: f.userId });
    const text = (x: unknown) => JSON.stringify(x);
    expect(() => parseClosingPack('{ no es json')).toThrow(/not valid JSON/);
    expect(() => parseClosingPack(text({ hello: 1 }))).toThrow(/version marker/);
    expect(() => parseClosingPack(text({ ...pack, mnemosine_closing_pack: 99 }))).toThrow(/understands up to/);
    expect(() => parseClosingPack(text({ ...pack, seal: 'abc' }))).toThrow(/not a SHA-256/);
    expect(() =>
      parseClosingPack(text({ ...pack, sealed: { ...pack.sealed, period: { ...pack.sealed.period, id: [pack.sealed.period.id] } } }))
    ).toThrow(/not a UUID/);
    expect(() => parseClosingPack(text({ ...pack, sealed: { ...pack.sealed, figures: undefined } }))).toThrow(/no figures/);
    expect(() => parseClosingPack(text({ ...pack, envelope: undefined }))).toThrow(/no envelope/);
    expect(parseClosingPack(text(pack)).seal).toBe(pack.seal);
  });

  it('el sello guardado en la base es el del cuerpo, y la tabla es de sólo agregar', async () => {
    enterTenant(f.tenantId);
    const julio = await periodOf(f, JULIO);
    const pack = await buildClosingPack(f.entityId, julio.id, { userId: f.userId });
    const id = await storeClosingPack(f.entityId, julio.id, pack);

    const row = await query<{ seal: string; body: { seal: string } }>(
      'SELECT seal, body FROM closing_packs WHERE id = $1',
      [id]
    );
    expect(row.rows[0].seal).toBe(sealOf(pack.sealed));
    expect(row.rows[0].body.seal).toBe(pack.seal);

    await expect(
      query('UPDATE closing_packs SET seal = $1 WHERE id = $2', ['0'.repeat(64), id])
    ).rejects.toThrow(/append-only/);
    await expect(query('DELETE FROM closing_packs WHERE id = $1', [id])).rejects.toThrow(/append-only/);
  });

  it('el expediente de una sociedad no se puede colgar del periodo de su hermana', async () => {
    enterTenant(f.tenantId);
    const julioHermana = await periodOf(hermana, JULIO);
    const pack = await buildClosingPack(hermana.entityId, julioHermana.id, { userId: hermana.userId });
    await expect(storeClosingPack(f.entityId, julioHermana.id, pack)).rejects.toThrow(
      /fk_closing_pack_period_entity|violates foreign key/
    );
  });
});
