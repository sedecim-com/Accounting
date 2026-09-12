import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { createJournalEntry } from '../../src/services/accounting/posting.js';
import {
  conductClose,
  openRunOf,
  CLOSING_STEPS,
} from '../../src/services/accounting/closing-conductor.js';
import {
  buildClosingPack,
  deriveSealedBody,
  parseClosingPack,
  sealOf,
  storeClosingPack,
  verifyClosingPack,
} from '../../src/services/accounting/closing-pack.js';
import type { AgentContext } from '../../src/ai/context.js';
import type { ClosablePeriod } from '../../src/ai/close-service.js';

/**
 * A6 · EL CONDUCTOR DEL CIERRE Y SU EXPEDIENTE, CONTRA POSTGRES.
 *
 * La tarjeta de A6 nace con su prueba de aceptación puesta: **el expediente
 * que entrega tiene que poder volver a correrse por un tercero y dar las
 * mismas cifras**. Esa frase no se comprueba con un mock — un arnés que
 * simula la consulta comprueba que el programa se acuerda de lo que dijo, no
 * que los libros lo sostengan —, así que todo lo de aquí abajo corre contra un
 * mayor de verdad.
 *
 * Lo que estas pruebas tienen que demostrar:
 *
 *   1. Que el conductor recorra los cinco pasos EN SU ORDEN y deje el periodo
 *      en cierre suave.
 *   2. Que correrlo dos veces no postee dos veces, y que lo ya hecho vuelva
 *      marcado como reanudado en vez de repetirse.
 *   3. Que `--stop-at` pare ANTES del paso nombrado, que es lo que el registro
 *      de comandos define para todo orquestador del sistema.
 *   4. Que una casilla bloqueante DETENGA el cierre, y que el periodo siga
 *      abierto después.
 *   5. Que dos expedientes del mismo mes, sellados con minutos de diferencia,
 *      lleven EL MISMO SELLO — que es la prueba de aceptación, escrita como
 *      una igualdad.
 *   6. Que un peso nuevo dentro del periodo rompa la comprobación, y que la
 *      RUTA de la diferencia nombre la cuenta.
 *   7. Que editar el archivo se note aunque las cifras no se toquen.
 *   8. Que el expediente sea de sólo agregar en la base, no sólo por convenio.
 */

let f: Fixture;
let hermana: Fixture;
let ctx: AgentContext;

const JULIO = 7;
const AGOSTO = 8;

const contextoDe = (x: Fixture, nombre: string): AgentContext => ({
  entityId: x.entityId,
  entityName: nombre,
  tenantId: x.tenantId,
  currency: 'MXN',
  country: 'MX',
  accountingStandard: 'mx_nif',
  taxId: 'XAXX010101000',
});

async function periodoDe(x: Fixture, mes: number): Promise<ClosablePeriod> {
  const r = await query<ClosablePeriod>(
    `SELECT fp.id, fp.period_name, fp.period_number,
            fp.start_date::text, fp.end_date::text, fp.status,
            fy.year_number, false AS overdue
       FROM fiscal_periods fp
       JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
      WHERE fp.id = $1`,
    [x.periodos[mes]]
  );
  return r.rows[0];
}

/** Un asiento cuadrado y posteado dentro del mes, para que haya cifras. */
async function asientoEn(x: Fixture, fecha: string, importe: string): Promise<string> {
  const e = await createJournalEntry(
    x.entityId,
    new Date(fecha),
    'standard' as never,
    `Venta de ${importe}`,
    [
      { account_id: x.roles.banco, debit_amount: importe, credit_amount: null, description: 'cobro' },
      { account_id: x.roles.ingreso, debit_amount: null, credit_amount: importe, description: 'venta' },
    ] as never,
    x.userId,
    { autoPost: true }
  );
  return e.id;
}

beforeAll(async () => {
  f = await crearInquilino('Conductor del cierre');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  hermana = await crearEntidadHermana(f, 'Hermana del conductor');
  ctx = contextoDe(f, 'Conductor del cierre');

  // Un activo fijo, para que el paso de depreciación tenga algo que hacer y
  // el mes no salga entero en «nada que hacer»: un conductor probado sólo
  // sobre un mes vacío no demuestra que conduzca.
  const categoria = uuidv4();
  await query(
    `INSERT INTO asset_categories (id, entity_id, name) VALUES ($1, $2, 'Equipo de cómputo')`,
    [categoria, f.entityId]
  );
  await query(
    `INSERT INTO fixed_assets (id, entity_id, asset_number, asset_name, category_id,
       acquisition_date, acquisition_cost, salvage_value, useful_life_years, useful_life_months,
       depreciation_method, depreciation_start_date, current_book_value,
       asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id,
       status, created_by)
     VALUES ($1, $2, 'AF-001', 'Laptop', $3,
       '2026-01-15', '36000.0000', '0', 3, 36,
       'straight_line', '2026-01-15', '36000.0000',
       $4, $5, $6, 'active', $7)`,
    [uuidv4(), f.entityId, categoria, f.cuentas['1210'], f.cuentas['1290'], f.cuentas['6140'], f.userId]
  );

  await asientoEn(f, '2026-07-10', '1000.0000');
});

describe('A6 · el conductor', () => {
  it('recorre los cinco pasos en su orden y deja el periodo en cierre suave', async () => {
    const julio = await periodoDe(f, JULIO);
    const r = await conductClose(ctx, julio, { userId: f.userId });

    expect(r.status, JSON.stringify(r.steps, null, 2)).toBe('completed');
    expect(r.steps.map((p) => p.step)).toEqual([...CLOSING_STEPS]);
    expect(r.haltedAtStep).toBeNull();

    // El paso de depreciación posteó de verdad: 36 000 / 36 meses = 1 000.
    const dep = r.steps.find((p) => p.step === 'depreciate-assets');
    expect(dep?.status).toBe('done');
    expect(dep?.processed).toBe(1);

    const estado = await query<{ status: string }>(
      'SELECT status FROM fiscal_periods WHERE id = $1', [julio.id]
    );
    expect(estado.rows[0].status).toBe('soft_close');

    // Y lo que hizo quedó escrito, paso por paso y en orden.
    const pasos = await query<{ step_key: string; ordinal: number; status: string }>(
      `SELECT step_key, ordinal, status FROM closing_run_steps
        WHERE run_id = $1 ORDER BY ordinal`, [r.runId]
    );
    expect(pasos.rows.map((p) => p.step_key)).toEqual([...CLOSING_STEPS]);
  });

  it('correrlo otra vez NO vuelve a postear: lo hecho vuelve marcado como reanudado', async () => {
    const agosto = await periodoDe(f, AGOSTO);
    const primera = await conductClose(ctx, agosto, { userId: f.userId });
    expect(primera.status).toBe('completed');

    const lineasTrasLaPrimera = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM journal_entry_lines jel
         JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.entity_id = $1 AND je.fiscal_period_id = $2`,
      [f.entityId, agosto.id]
    );

    // La corrida se completó, así que la segunda abre una NUEVA: lo que no se
    // repite es el trabajo, y de eso se encargan los motores y el estado del
    // periodo, no la memoria del conductor.
    const segunda = await conductClose(ctx, await periodoDe(f, AGOSTO), { userId: f.userId });
    expect(segunda.steps.find((p) => p.step === 'depreciate-assets')?.status).toBe('skipped');
    expect(segunda.steps.find((p) => p.step === 'soft-close')?.detail).toContain('already');

    const lineasTrasLaSegunda = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM journal_entry_lines jel
         JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.entity_id = $1 AND je.fiscal_period_id = $2`,
      [f.entityId, agosto.id]
    );
    expect(lineasTrasLaSegunda.rows[0].n).toBe(lineasTrasLaPrimera.rows[0].n);
  });

  it('--stop-at para ANTES del paso nombrado y deja el periodo abierto', async () => {
    const g = await crearInquilino('Cierre a medias');
    await seedPolicies({ tenantId: g.tenantId, entityId: g.entityId });
    // EL CONTEXTO DEL INQUILINO SE FIJA AQUÍ, y no basta con que `crearInquilino`
    // lo haya hecho: `enterTenant` es `AsyncLocalStorage.enterWith`, y llamado
    // dentro de una función AWAITADA no vuelve al contexto del llamador. Sin
    // esta línea la prueba corre bajo el inquilino del `beforeAll` y pasa por
    // el motivo equivocado — sobre todo aquí, donde la suite es superusuario y
    // RLS no la corrige.
    enterTenant(g.tenantId);
    const ctxG = contextoDe(g, 'Cierre a medias');
    const septiembre = await periodoDe(g, 9);

    const r = await conductClose(ctxG, septiembre, {
      userId: g.userId,
      stopAt: 'soft-close',
    });

    expect(r.status).toBe('stopped');
    expect(r.haltedAtStep).toBe('soft-close');
    expect(r.steps.map((p) => p.step)).not.toContain('soft-close');
    expect(r.steps.map((p) => p.step)).toContain('verify-checklist');

    const estado = await query<{ status: string }>(
      'SELECT status FROM fiscal_periods WHERE id = $1', [septiembre.id]
    );
    expect(estado.rows[0].status).toBe('open');

    // Y la corrida queda ABIERTA, que es lo que hace reanudable el mes.
    const abierta = await openRunOf(g.entityId, septiembre.id);
    expect(abierta?.status).toBe('stopped');
    expect(abierta?.halted_at_step).toBe('soft-close');

    // Reanudarla la termina, y SIN repetir lo ya hecho.
    const seguir = await conductClose(ctxG, await periodoDe(g, 9), { userId: g.userId });
    expect(seguir.status).toBe('completed');
    expect(seguir.steps.find((p) => p.step === 'verify-checklist')?.resumed).toBe(true);
    expect(await openRunOf(g.entityId, septiembre.id)).toBeNull();
  });

  it('una casilla bloqueante detiene el cierre, y el periodo sigue abierto', async () => {
    const g = await crearInquilino('Cierre bloqueado');
    await seedPolicies({ tenantId: g.tenantId, entityId: g.entityId });
    // EL CONTEXTO DEL INQUILINO SE FIJA AQUÍ, y no basta con que `crearInquilino`
    // lo haya hecho: `enterTenant` es `AsyncLocalStorage.enterWith`, y llamado
    // dentro de una función AWAITADA no vuelve al contexto del llamador. Sin
    // esta línea la prueba corre bajo el inquilino del `beforeAll` y pasa por
    // el motivo equivocado — sobre todo aquí, donde la suite es superusuario y
    // RLS no la corrige.
    enterTenant(g.tenantId);
    const ctxG = contextoDe(g, 'Cierre bloqueado');
    const octubre = await periodoDe(g, 10);

    // Un asiento SIN postear dentro del mes: la casilla «entries-posted» es
    // bloqueante y el cierre tiene que negarse.
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
    expect(r.steps.find((p) => p.step === 'verify-checklist')?.detail).toMatch(/blocking/);
    expect(r.steps.map((p) => p.step)).not.toContain('soft-close');

    const estado = await query<{ status: string }>(
      'SELECT status FROM fiscal_periods WHERE id = $1', [octubre.id]
    );
    expect(estado.rows[0].status).toBe('open');

    // La corrida bloqueada es reanudable, y el paso bloqueado se REPITE al
    // reanudar: lo contrario dejaría el mes cerrándose sobre una verificación
    // que ya no vale.
    const abierta = await openRunOf(g.entityId, octubre.id);
    expect(abierta?.status).toBe('blocked');
  });

  it('el ensayo no escribe nada, y CONTESTA de verdad la única pregunta gratis', async () => {
    const g = await crearInquilino('Ensayo del conductor');
    await seedPolicies({ tenantId: g.tenantId, entityId: g.entityId });
    // EL CONTEXTO DEL INQUILINO SE FIJA AQUÍ, y no basta con que `crearInquilino`
    // lo haya hecho: `enterTenant` es `AsyncLocalStorage.enterWith`, y llamado
    // dentro de una función AWAITADA no vuelve al contexto del llamador. Sin
    // esta línea la prueba corre bajo el inquilino del `beforeAll` y pasa por
    // el motivo equivocado — sobre todo aquí, donde la suite es superusuario y
    // RLS no la corrige.
    enterTenant(g.tenantId);
    const ctxG = contextoDe(g, 'Ensayo del conductor');
    const febrero = await periodoDe(g, 2);

    const r = await conductClose(ctxG, febrero, { userId: g.userId, dryRun: true });

    expect(r.status).toBe('previewed');
    expect(r.runId).toBeNull();
    // Los pasos que escribirían dicen que están PENDIENTES; el checklist, que
    // es de lectura, se evalúa de verdad — un ensayo que contestara «lo haría»
    // sobre lo único que puede preguntarse gratis sería la clase de comando
    // que esta casa llama peor que ausente.
    expect(r.steps.find((p) => p.step === 'accrue-benefits')?.status).toBe('pending');
    expect(r.steps.find((p) => p.step === 'soft-close')?.status).toBe('pending');
    const checklist = r.steps.find((p) => p.step === 'verify-checklist');
    expect(checklist?.status).toBe('done');
    expect(checklist?.processed).toBeGreaterThan(0);

    // Y no escribió NADA: ni corrida, ni paso, ni estado del periodo.
    const corridas = await query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM closing_runs WHERE entity_id = $1', [g.entityId]
    );
    expect(corridas.rows[0].n).toBe('0');
    const estado = await query<{ status: string }>(
      'SELECT status FROM fiscal_periods WHERE id = $1', [febrero.id]
    );
    expect(estado.rows[0].status).toBe('open');
  });

  it('un motor que revienta queda escrito, y la corrida se puede reanudar tras arreglarlo', async () => {
    const g = await crearInquilino('Motor que revienta');
    await seedPolicies({ tenantId: g.tenantId, entityId: g.entityId });
    // EL CONTEXTO DEL INQUILINO SE FIJA AQUÍ, y no basta con que `crearInquilino`
    // lo haya hecho: `enterTenant` es `AsyncLocalStorage.enterWith`, y llamado
    // dentro de una función AWAITADA no vuelve al contexto del llamador. Sin
    // esta línea la prueba corre bajo el inquilino del `beforeAll` y pasa por
    // el motivo equivocado — sobre todo aquí, donde la suite es superusuario y
    // RLS no la corrige.
    enterTenant(g.tenantId);
    const ctxG = contextoDe(g, 'Motor que revienta');
    const abril = await periodoDe(g, 4);

    // `base_depreciacion` con un valor que no es ninguna de las dos bases: el
    // motor de depreciación se NIEGA a adivinar, y el conductor tiene que
    // dejar constancia en vez de dejar la corrida diciendo «running» para
    // siempre.
    const torcida = await query(
      `UPDATE policy_decisions SET resolved_value = 'lo_que_sea', status = 'resolved'
        WHERE key = 'base_depreciacion'
          AND (entity_id = $1 OR entity_id IS NULL)`,
      [g.entityId]
    );
    expect(torcida.rowCount, 'la política no se torció: la prueba no probaría nada').toBeGreaterThan(0);

    const r = await conductClose(ctxG, abril, { userId: g.userId });
    expect(r.status).toBe('failed');
    expect(r.haltedAtStep).toBe('depreciate-assets');
    const paso = r.steps.find((p) => p.step === 'depreciate-assets');
    expect(paso?.status).toBe('failed');
    expect(paso?.detail).toMatch(/base_depreciacion/);

    const fila = await query<{ status: string; halted_at_step: string; ended_at: string | null }>(
      `SELECT status, halted_at_step, ended_at::text AS ended_at FROM closing_runs WHERE id = $1`,
      [r.runId]
    );
    expect(fila.rows[0].status).toBe('failed');
    expect(fila.rows[0].halted_at_step).toBe('depreciate-assets');
    expect(fila.rows[0].ended_at).not.toBeNull();

    // Arreglado el criterio, la MISMA corrida se reanuda y llega al final: el
    // paso fallido se repite (sólo `done` y `skipped` no se revisitan).
    await query(
      `UPDATE policy_decisions SET resolved_value = 'vida_util_nif'
        WHERE key = 'base_depreciacion' AND (entity_id = $1 OR entity_id IS NULL)`,
      [g.entityId]
    );
    const seguir = await conductClose(ctxG, await periodoDe(g, 4), { userId: g.userId });
    expect(seguir.runId).toBe(r.runId);
    expect(seguir.status).toBe('completed');
    expect(seguir.steps.find((p) => p.step === 'depreciate-assets')?.status).not.toBe('failed');
  });

  it('nunca hay dos corridas abiertas del mismo periodo', async () => {
    const g = await crearInquilino('Una sola corrida');
    await seedPolicies({ tenantId: g.tenantId, entityId: g.entityId });
    // EL CONTEXTO DEL INQUILINO SE FIJA AQUÍ, y no basta con que `crearInquilino`
    // lo haya hecho: `enterTenant` es `AsyncLocalStorage.enterWith`, y llamado
    // dentro de una función AWAITADA no vuelve al contexto del llamador. Sin
    // esta línea la prueba corre bajo el inquilino del `beforeAll` y pasa por
    // el motivo equivocado — sobre todo aquí, donde la suite es superusuario y
    // RLS no la corrige.
    enterTenant(g.tenantId);
    const noviembre = await periodoDe(g, 11);
    await query(
      `INSERT INTO closing_runs (tenant_id, entity_id, fiscal_period_id, status)
       VALUES ($1, $2, $3, 'blocked')`,
      [g.tenantId, g.entityId, noviembre.id]
    );
    await expect(
      query(
        `INSERT INTO closing_runs (tenant_id, entity_id, fiscal_period_id, status)
         VALUES ($1, $2, $3, 'running')`,
        [g.tenantId, g.entityId, noviembre.id]
      )
    ).rejects.toThrow(/uq_closing_run_open|duplicate key/);
  });

  it('un paso de OTRA entidad no se puede colgar de esta corrida', async () => {
    // LA ENTIDAD VIAJA EN LA FORÁNEA, y la prueba tiene que doler por ESO y no
    // por la UNIQUE: se abre una corrida en un mes SIN pasos, para que la
    // única restricción que pueda hablar sea la compuesta.
    const diciembre = await periodoDe(f, 12);
    const corrida = await query<{ id: string }>(
      `INSERT INTO closing_runs (tenant_id, entity_id, fiscal_period_id, status)
       VALUES ($1, $2, $3, 'running') RETURNING id`,
      [f.tenantId, f.entityId, diciembre.id]
    );
    await expect(
      query(
        `INSERT INTO closing_run_steps
           (tenant_id, entity_id, run_id, step_key, ordinal, status, detail)
         VALUES ($1, $2, $3, 'soft-close', 5, 'done', 'colado')`,
        [hermana.tenantId, hermana.entityId, corrida.rows[0].id]
      )
    ).rejects.toThrow(/fk_closing_step_run_entity|violates foreign key/);

    // Y con la entidad correcta el mismo INSERT entra: la negativa es de la
    // frontera, no de la forma de la fila.
    await expect(
      query(
        `INSERT INTO closing_run_steps
           (tenant_id, entity_id, run_id, step_key, ordinal, status, detail)
         VALUES ($1, $2, $3, 'soft-close', 5, 'done', 'legítimo')`,
        [f.tenantId, f.entityId, corrida.rows[0].id]
      )
    ).resolves.toBeDefined();
  });
});

describe('A6 · el expediente, y la prueba de aceptación', () => {
  it('LA PRUEBA DE ACEPTACIÓN: dos sellados del mismo mes dan el MISMO sello', async () => {
    const julio = await periodoDe(f, JULIO);
    const uno = await buildClosingPack(f.entityId, julio.id, { userId: f.userId });
    const dos = await buildClosingPack(f.entityId, julio.id, { userId: f.userId });

    // Los sobres difieren —el reloj corre— y los cuerpos sellados no.
    expect(dos.envelope.generated_at).not.toBe(uno.envelope.generated_at);
    expect(dos.seal).toBe(uno.seal);
    expect(dos.sealed).toEqual(uno.sealed);
  });

  it('el tercero vuelve a correrlo y los libros lo sostienen', async () => {
    const julio = await periodoDe(f, JULIO);
    const pack = await buildClosingPack(f.entityId, julio.id, { userId: f.userId });

    // El tercero tiene el ARCHIVO, no nuestra memoria: se serializa y se
    // vuelve a leer, que es lo que de verdad hace `closing pack verify`.
    const delArchivo = parseClosingPack(JSON.stringify(pack, null, 2));
    const veredicto = await verifyClosingPack(delArchivo);

    expect(veredicto.sealIntact).toBe(true);
    expect(veredicto.figuresReproduce, JSON.stringify(veredicto.differences)).toBe(true);
    expect(veredicto.criteriaUnchanged).toBe(true);
    expect(veredicto.differences).toEqual([]);
  });

  it('la fecha de corte es la del periodo, no el reloj', async () => {
    const julio = await periodoDe(f, JULIO);
    const cuerpo = await deriveSealedBody(f.entityId, julio.id);
    expect(cuerpo.as_of).toBe('2026-07-31');
    expect(cuerpo.as_of).toBe(cuerpo.period.end_date);
  });

  it('un peso nuevo dentro del periodo rompe la comprobación, y la ruta nombra la cuenta', async () => {
    const g = await crearInquilino('Expediente que deriva');
    await seedPolicies({ tenantId: g.tenantId, entityId: g.entityId });
    // EL CONTEXTO DEL INQUILINO SE FIJA AQUÍ, y no basta con que `crearInquilino`
    // lo haya hecho: `enterTenant` es `AsyncLocalStorage.enterWith`, y llamado
    // dentro de una función AWAITADA no vuelve al contexto del llamador. Sin
    // esta línea la prueba corre bajo el inquilino del `beforeAll` y pasa por
    // el motivo equivocado — sobre todo aquí, donde la suite es superusuario y
    // RLS no la corrige.
    enterTenant(g.tenantId);
    const marzo = await periodoDe(g, 3);
    await asientoEn(g, '2026-03-10', '700.0000');

    const pack = await buildClosingPack(g.entityId, marzo.id, { userId: g.userId });
    expect((await verifyClosingPack(pack)).figuresReproduce).toBe(true);

    // Y ahora entra un asiento más en el mismo mes.
    await asientoEn(g, '2026-03-20', '300.0000');

    const veredicto = await verifyClosingPack(pack);
    expect(veredicto.sealIntact).toBe(true);
    expect(veredicto.figuresReproduce).toBe(false);
    // La acusación NOMBRA dónde: «los sellos difieren» es cierto y no sirve.
    const rutas = veredicto.differences.map((d) => d.path);
    expect(rutas.some((r) => r.startsWith('figures.trial_balance'))).toBe(true);
    expect(rutas).toContain('figures.totals.debit');
    const total = veredicto.differences.find((d) => d.path === 'figures.totals.debit');
    expect(total?.expected).toBe('700.0000');
    expect(total?.actual).toBe('1000.0000');
  });

  it('editar el archivo se nota aunque las cifras del mayor no se hayan movido', async () => {
    const julio = await periodoDe(f, JULIO);
    const pack = await buildClosingPack(f.entityId, julio.id, { userId: f.userId });

    // El clásico: alguien abre el JSON y le cambia un nombre.
    const editado = parseClosingPack(JSON.stringify(pack));
    editado.sealed.entity.name = 'Otra Sociedad SA de CV';

    const veredicto = await verifyClosingPack(editado);
    expect(veredicto.sealIntact).toBe(false);
    expect(veredicto.recomputedSeal).not.toBe(veredicto.expectedSeal);
    // Y las dos preguntas se contestan por separado: el archivo está tocado Y
    // además sus cifras ya no son las de los libros.
    expect(veredicto.figuresReproduce).toBe(false);
    expect(veredicto.differences.map((d) => d.path)).toContain('entity.name');
  });

  it('el sello guardado en la base es el del cuerpo, y la tabla es de sólo agregar', async () => {
    const julio = await periodoDe(f, JULIO);
    const pack = await buildClosingPack(f.entityId, julio.id, { userId: f.userId });
    const id = await storeClosingPack(f.tenantId, f.entityId, julio.id, pack);

    const fila = await query<{ seal: string; body: { seal: string } }>(
      'SELECT seal, body FROM closing_packs WHERE id = $1', [id]
    );
    expect(fila.rows[0].seal).toBe(sealOf(pack.sealed));
    expect(fila.rows[0].body.seal).toBe(pack.seal);

    // Un expediente que se puede reescribir no prueba nada: el disparador de
    // la 082 alcanza también al dueño del esquema, que es bajo quien corre
    // esta suite.
    await expect(
      query('UPDATE closing_packs SET seal = $1 WHERE id = $2', ['0'.repeat(64), id])
    ).rejects.toThrow(/append-only/);
    await expect(
      query('DELETE FROM closing_packs WHERE id = $1', [id])
    ).rejects.toThrow(/append-only/);
  });

  it('el expediente de una sociedad no se puede colgar del periodo de su hermana', async () => {
    const julioHermana = await periodoDe(hermana, JULIO);
    const pack = await buildClosingPack(hermana.entityId, julioHermana.id, {
      userId: hermana.userId,
    });
    await expect(
      storeClosingPack(f.tenantId, f.entityId, julioHermana.id, pack)
    ).rejects.toThrow(/fk_closing_pack_period_entity|violates foreign key/);
  });
});
