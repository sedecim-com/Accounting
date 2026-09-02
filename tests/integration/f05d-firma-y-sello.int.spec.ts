import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import {
  reopenPolicy,
  resolvePolicy,
  seedPolicies,
} from '../../src/services/policy/policy-service.js';
import { approveDraft, resolveReviewer } from '../../src/ai/draft-service.js';
import { resolveEntity } from '../../src/ai/context.js';
import { crearAjuste } from '../../src/services/banking/reconciliation-adjustments.js';
import {
  abrirSesion,
  aprobarSesion,
  cerrarSesion,
  clasificarPartidasDeSesion,
  contabilizarSesion,
  estadoDeSesion,
  hashDeInstantanea,
  type InstantaneaDeAprobacion,
} from '../../src/services/banking/reconciliation-service.js';

/**
 * F05d · LA FIRMA Y EL SELLO, CONTRA POSTGRES.
 *
 * Éste es el ÚNICO tramo de F05 que toca el mayor, así que lo que hay que
 * probar contra la base de verdad no es la aritmética —eso es F05c— sino los
 * hechos que sólo existen cuando hay filas:
 *
 *  · que los tres CHECK de la 055 se cumplen porque el servicio escribe las
 *    columnas juntas, y no porque nadie los haya probado;
 *  · que el hash SOBREVIVE AL VIAJE POR JSONB — que es donde una serialización
 *    ingenua se habría roto, porque Postgres no conserva el orden de las claves
 *    de un jsonb y la verificación habría dicho «esto no es lo que se aprobó»
 *    sobre una sesión intacta;
 *  · que contabilizar dos veces no postea dos veces;
 *  · y que después de contabilizar la sesión SIGUE cuadrando, que es lo que
 *    delata si las partidas explicadas por un ajuste no se resuelven.
 */

let f: Fixture;
let cuenta: string;
let glBanco: string;
let estadoId: string;
let sesionId: string;
let segundoUsuario: string;
let cuentaDeComision: string;

async function asientosDeLaEntidad(): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM journal_entries WHERE entity_id = $1`,
    [f.entityId]
  );
  return parseInt(r.rows[0].n, 10);
}

beforeAll(async () => {
  f = await crearInquilino('Sonda F05d');
  glBanco = f.roles.banco ?? Object.values(f.cuentas)[0];

  // Los roles que la 055 vino a sembrar. Si faltan, el ajuste de comisión
  // tendría que inventarse una cuenta, que es justo lo que F05c se negó a hacer.
  expect(f.roles.comision_bancaria).toBeDefined();
  cuentaDeComision = (
    await query<{ code: string }>(`SELECT code FROM accounts WHERE id = $1`, [
      f.roles.comision_bancaria,
    ])
  ).rows[0].code;

  segundoUsuario = uuidv4();
  await query(
    `INSERT INTO users (id, tenant_id, email, password_hash, first_name, last_name,
       roles, permissions, accessible_entities, is_active)
     VALUES ($1,$2,$3,'x','Segunda','Firma','["owner"]'::jsonb,'["*"]'::jsonb,$4::jsonb,true)`,
    [segundoUsuario, f.tenantId, `it2-${segundoUsuario.slice(0, 8)}@example.test`,
     JSON.stringify([f.entityId])]
  );

  cuenta = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
     VALUES ($1,$2,'Operativa F05d','Banco',$3,'MXN','checking')`,
    [cuenta, f.entityId, glBanco]
  );

  // Un mes entero cuya única diferencia es una comisión que los libros no
  // registran: banco −350, libros 0. Con la partida levantada los dos lados
  // ajustados dan −350 y la sesión cuadra.
  estadoId = uuidv4();
  await query(
    `INSERT INTO bank_statements (id, entity_id, bank_account_id, period_start, period_end,
       opening_balance, closing_balance, currency_code, source_format, file_sha256, imported_by)
     VALUES ($1,$2,$3,'2026-08-01','2026-08-31',0,-350,'MXN','csv',$4,$5)`,
    [estadoId, f.entityId, cuenta, 'd'.repeat(64), f.userId]
  );
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type,
       description, is_matched, statement_id)
     VALUES ($1,$2,'2026-08-20',-350,'debit','comision de manejo de cuenta',false,$3)`,
    [uuidv4(), cuenta, estadoId]
  );
}, 180_000);

afterAll(async () => {
  await closeDatabase();
});

describe('sonda: la firma', () => {
  let hashFirmado: string;

  it('deja la sesión cuadrada, con su ajuste como BORRADOR y sin tocar el mayor', async () => {
    const abierta = await abrirSesion(
      entityScope(f.tenantId, f.entityId),
      { cuenta, periodo: '2026-08' },
      { userId: f.userId }
    );
    sesionId = abierta.sesionId;

    await clasificarPartidasDeSesion(entityScope(f.tenantId, f.entityId), sesionId, {
      userId: f.userId,
    });
    const partida = (
      await query<{ id: string }>(
        `SELECT id FROM reconciling_items WHERE reconciliation_session_id = $1`,
        [sesionId]
      )
    ).rows[0].id;
    await query(
      `UPDATE reconciling_items SET fecha_esperada = '2026-09-15', responsable = 'tesoreria'
        WHERE id = $1`,
      [partida]
    );

    const antes = await asientosDeLaEntidad();
    const ajuste = await crearAjuste(
      f.entityId,
      sesionId,
      { tipo: 'comision', cuenta: cuentaDeComision, importe: '-350.00' },
      f.userId,
      { reconcilingItemId: partida }
    );
    // La promesa de F05c, comprobada sobre la fila y no leyendo el código.
    expect(ajuste.journalEntryId).toBeNull();
    expect(await asientosDeLaEntidad()).toBe(antes);

    const cerrada = await cerrarSesion(
      entityScope(f.tenantId, f.entityId),
      sesionId,
      {},
      { userId: f.userId }
    );
    expect(cerrada.estado).toBe('balanced');
    expect(cerrada.congelado.variance).toBe('0.00');
  });

  it('con la política en "exigir", quien cerró la sesión NO la firma', async () => {
    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
    await resolvePolicy(
      { tenantId: f.tenantId, entityId: f.entityId },
      'segregacion_de_funciones',
      'exigir',
      'sonda@f05d'
    );

    await expect(
      aprobarSesion(entityScope(f.tenantId, f.entityId), sesionId, {}, { userId: f.userId })
    ).rejects.toThrow(/segregación de funciones/);

    // Y la fila no se movió ni a medias: el CHECK `sesion_firma_coherente` no
    // llegó siquiera a tener ocasión de rechazar media firma.
    const bd = await query<{ status: string; approval_hash: string | null }>(
      `SELECT status, approval_hash FROM reconciliation_sessions WHERE id = $1`,
      [sesionId]
    );
    expect(bd.rows[0].status).toBe('balanced');
    expect(bd.rows[0].approval_hash).toBeNull();
  });

  it('otro usuario sí la firma, y la firma va ENTERA: fecha, motivo, instantánea y hash', async () => {
    const r = await aprobarSesion(
      entityScope(f.tenantId, f.entityId),
      sesionId,
      { motivo: 'revisada contra el estado de cuenta de agosto' },
      { userId: segundoUsuario }
    );
    hashFirmado = r.hash;

    expect(r.estado).toBe('approved');
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.segregacion.politica).toBe('exigir');
    expect(r.segregacion.preparador).toBe(f.userId);
    expect(r.segregacion.coincide).toBe(false);
    // Los MIEMBROS: la partida, el ajuste, y los saldos de los dos lados.
    expect(r.instantanea.miembros.partidas).toHaveLength(1);
    expect(r.instantanea.miembros.ajustes).toHaveLength(1);
    expect(r.instantanea.miembros.ajustes[0].journalEntryId).toBeNull();
    expect(r.instantanea.saldos.variacion).toBe('0.00');

    const bd = await query<{
      status: string;
      approved_by: string;
      approved_at: string | null;
      approval_reason: string | null;
      approval_hash: string;
      approval_snapshot: InstantaneaDeAprobacion;
    }>(
      `SELECT status, approved_by, approved_at::text AS approved_at, approval_reason,
              approval_hash, approval_snapshot
         FROM reconciliation_sessions WHERE id = $1`,
      [sesionId]
    );
    expect(bd.rows[0].status).toBe('approved');
    expect(bd.rows[0].approved_by).toBe(segundoUsuario);
    expect(bd.rows[0].approved_at).not.toBeNull();
    expect(bd.rows[0].approval_reason).toMatch(/estado de cuenta/);
    expect(bd.rows[0].approval_hash).toBe(hashFirmado);

    // ── LO QUE ESTA SONDA EXISTE PARA PROBAR ──
    // La instantánea vuelve de un JSONB, que NO conserva el orden de las
    // claves. Si la serialización no fuera determinista, verificar una firma
    // intacta contestaría «esto no es lo que se aprobó».
    expect(hashDeInstantanea(bd.rows[0].approval_snapshot)).toBe(hashFirmado);
  });

  it('no se firma dos veces: el segundo hash no se escribe encima del primero', async () => {
    await expect(
      aprobarSesion(entityScope(f.tenantId, f.entityId), sesionId, {}, { userId: f.userId })
    ).rejects.toThrow(/ya está en 'approved'/);
  });
});

describe('sonda: la contabilización', () => {
  let asientoDelAjuste: string;

  it('el ensayo recorre el camino entero y no deja nada', async () => {
    const antes = await asientosDeLaEntidad();
    const r = await contabilizarSesion(
      entityScope(f.tenantId, f.entityId),
      sesionId,
      {},
      { userId: segundoUsuario, dryRun: true }
    );
    expect(r.ensayo).toBe(true);
    expect(r.posteados).toBe(1);
    expect(r.partidasSelladas).toBe(1);

    expect(await asientosDeLaEntidad()).toBe(antes);
    const bd = await query<{ status: string; posted_at: string | null }>(
      `SELECT status, posted_at::text AS posted_at FROM reconciliation_sessions WHERE id = $1`,
      [sesionId]
    );
    expect(bd.rows[0].status).toBe('approved');
    expect(bd.rows[0].posted_at).toBeNull();
  });

  it('postea el ajuste, rellena journal_entry_id, sella la línea de banco y cierra el borrador', async () => {
    const antes = await asientosDeLaEntidad();
    const r = await contabilizarSesion(
      entityScope(f.tenantId, f.entityId),
      sesionId,
      { notas: 'contabilizada por la sonda' },
      { userId: segundoUsuario }
    );
    expect(r.estado).toBe('posted');
    expect(r.yaContabilizada).toBe(false);
    expect(r.posteados).toBe(1);
    expect(r.adoptados).toBe(0);
    expect(r.partidasSelladas).toBe(1);
    expect(r.cotejosEscritos).toBe(1);
    expect(r.partidasResueltas).toBe(1);
    expect(await asientosDeLaEntidad()).toBe(antes + 1);
    asientoDelAjuste = r.asientos[0].journalEntryId;

    // 1. LA COLUMNA QUE PRUEBA QUE EL AJUSTE DEJÓ DE SER UNA PROMESA.
    const ajuste = await query<{ journal_entry_id: string | null }>(
      `SELECT journal_entry_id FROM reconciliation_adjustments
        WHERE reconciliation_session_id = $1 AND entity_id = $2`,
      [sesionId, f.entityId]
    );
    expect(ajuste.rows[0].journal_entry_id).toBe(asientoDelAjuste);

    // 2. EL ASIENTO ESTÁ POSTEADO Y DICE DE DÓNDE VIENE.
    const je = await query<{ status: string; entry_type: string; source_type: string | null }>(
      `SELECT status, entry_type, source_type FROM journal_entries WHERE id = $1`,
      [asientoDelAjuste]
    );
    expect(je.rows[0].status).toBe('posted');
    expect(je.rows[0].entry_type).toBe('auto_reconciliation');
    expect(je.rows[0].source_type).toBe('bank_reconciliation');

    // 3. EL SELLO, CON SUS TRES COLUMNAS: es lo único que la 041 deja escribir
    //    sobre una línea posteada, y el CHECK de la 052 no admite medio sello.
    const lineas = await query<{
      account_id: string;
      is_reconciled: boolean;
      reconciled_at: string | null;
      reconciliation_id: string | null;
    }>(
      `SELECT account_id, is_reconciled, reconciled_at::text AS reconciled_at, reconciliation_id
         FROM journal_entry_lines WHERE journal_entry_id = $1`,
      [asientoDelAjuste]
    );
    const banco = lineas.rows.find((l) => l.account_id === glBanco);
    const contra = lineas.rows.find((l) => l.account_id !== glBanco);
    expect(banco?.is_reconciled).toBe(true);
    expect(banco?.reconciled_at).not.toBeNull();
    expect(banco?.reconciliation_id).toBe(r.grupoDelSello);
    // La contrapartida NO se sella: el gasto por comisión no es materia de
    // conciliación bancaria y sellarlo no significaría nada.
    expect(contra?.is_reconciled).toBe(false);

    // 4. EL BORRADOR SE CIERRA. Si se quedara pendiente, `mnemosine review`
    //    postearía la misma comisión una segunda vez.
    const draft = await query<{ status: string; journal_entry_id: string | null }>(
      `SELECT d.status, d.journal_entry_id
         FROM ai_drafts d
         JOIN reconciliation_adjustments ra ON ra.draft_id = d.id
        WHERE ra.reconciliation_session_id = $1`,
      [sesionId]
    );
    expect(draft.rows[0].status).toBe('approved');
    expect(draft.rows[0].journal_entry_id).toBe(asientoDelAjuste);

    // 5. EL RASTRO DE LA SESIÓN, que el CHECK `sesion_contabilizada_con_rastro`
    //    exige entero.
    const bd = await query<{ status: string; posted_at: string | null; posted_by: string | null }>(
      `SELECT status, posted_at::text AS posted_at, posted_by
         FROM reconciliation_sessions WHERE id = $1`,
      [sesionId]
    );
    expect(bd.rows[0].status).toBe('posted');
    expect(bd.rows[0].posted_at).not.toBeNull();
    expect(bd.rows[0].posted_by).toBe(segundoUsuario);
  });

  it('la sesión SIGUE cuadrando después de contabilizar', async () => {
    // Éste es el caso que delata si la partida explicada por el ajuste se queda
    // abierta: el saldo de libros ya bajó 350 por el asiento, y una partida
    // viva volvería a restarlos, dejando la sesión firmada mostrando una
    // variación de −350 que nada explica.
    const e = await estadoDeSesion(entityScope(f.tenantId, f.entityId), { sesionId });
    expect(e.aritmetica.libros.saldo).toBe('-350.00');
    expect(e.aritmetica.variacion).toBe('0.00');
    expect(e.aritmetica.cuadra).toBe(true);
    expect(e.partidas.every((p) => p.resuelta)).toBe(true);
    // Y la lectura enseña la firma entera: una superficie que muestra la sesión
    // y esconde su hash obliga a creerle en vez de dejar comprobar.
    expect(e.sesion.aprobadaPor).toBe(segundoUsuario);
    expect(e.sesion.hashDeAprobacion).toMatch(/^[0-9a-f]{64}$/);
    expect(e.sesion.contabilizadaPor).toBe(segundoUsuario);
    expect(e.sesion.contabilizadaEl).not.toBeNull();
  });

  it('contabilizar dos veces NO postea dos veces', async () => {
    const antes = await asientosDeLaEntidad();
    const r = await contabilizarSesion(
      entityScope(f.tenantId, f.entityId),
      sesionId,
      {},
      { userId: segundoUsuario }
    );
    expect(r.yaContabilizada).toBe(true);
    expect(r.posteados).toBe(0);
    expect(r.asientos.map((x) => x.journalEntryId)).toEqual([asientoDelAjuste]);
    expect(await asientosDeLaEntidad()).toBe(antes);
  });

  it('el mayor sigue siendo inmutable: el asiento del ajuste no se edita ni se borra', async () => {
    await expect(
      query(`UPDATE journal_entries SET entry_date = '2026-09-30' WHERE id = $1`, [asientoDelAjuste])
    ).rejects.toThrow(/no se edita/);
    await expect(
      query(`DELETE FROM journal_entries WHERE id = $1`, [asientoDelAjuste])
    ).rejects.toThrow(/no se borra/);
  });
});

describe('sonda: lo que no se contabiliza', () => {
  it('una sesión que no llegó a `approved` no se contabiliza', async () => {
    const otra = uuidv4();
    await query(
      `INSERT INTO reconciliation_sessions
         (id, bank_account_id, entity_id, start_date, end_date, beginning_balance, ending_balance_per_bank)
       VALUES ($1,$2,$3,'2026-06-01','2026-06-30',0,0)`,
      [otra, cuenta, f.entityId]
    );
    await expect(
      contabilizarSesion(entityScope(f.tenantId, f.entityId), otra, {}, { userId: segundoUsuario })
    ).rejects.toThrow(/sólo se contabiliza una sesión aprobada/);
  });

  it('una sesión en curso no se firma: no se firma lo que nadie calculó', async () => {
    const enCurso = (
      await query<{ id: string }>(
        `SELECT id FROM reconciliation_sessions
          WHERE entity_id = $1 AND status = 'in_progress' LIMIT 1`,
        [f.entityId]
      )
    ).rows[0].id;
    await expect(
      aprobarSesion(entityScope(f.tenantId, f.entityId), enCurso, {}, { userId: segundoUsuario })
    ).rejects.toThrow(/no se firma lo que todavía no cuadra/);
  });

  it('la sesión de otra entidad no existe para ésta: 404 y no 403', async () => {
    await expect(
      aprobarSesion(entityScope(f.tenantId, uuidv4()), sesionId, {}, { userId: segundoUsuario })
    ).rejects.toThrow(/not found/);
  });
});

/**
 * EL SEGUNDO MES, QUE ES DONDE VIVEN LOS DOS CASOS QUE MÁS PUEDEN DOLER: la
 * política en `alertar` —que deja pasar y ANOTA, en vez de bloquear— y el
 * borrador que un humano ya aprobó por `mnemosine review` antes de que la
 * sesión se contabilizara. Ése es el camino MÁS natural del despacho (revisar
 * los pendientes antes de cerrar el mes), y sin la rama de adopción cada
 * comisión quedaría contabilizada dos veces.
 */
describe('sonda: alertar, y el borrador que alguien ya aprobó', () => {
  let sesion2: string;
  let draftId: string;
  let asientoDelRevisor: string;

  beforeAll(async () => {
    await query(
      `INSERT INTO bank_statements (id, entity_id, bank_account_id, period_start, period_end,
         opening_balance, closing_balance, currency_code, source_format, file_sha256, imported_by)
       VALUES ($1,$2,$3,'2026-09-01','2026-09-30',-350,-550,'MXN','csv',$4,$5)`,
      [uuidv4(), f.entityId, cuenta, 'e'.repeat(64), f.userId]
    );
    await query(
      `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type,
         description, is_matched)
       VALUES ($1,$2,'2026-09-18',-200,'debit','comision de septiembre',false)`,
      [uuidv4(), cuenta]
    );
  }, 60_000);

  it('con la política en "alertar" quien cerró SÍ firma, y la coincidencia queda anotada', async () => {
    const abierta = await abrirSesion(
      entityScope(f.tenantId, f.entityId),
      { cuenta, periodo: '2026-09' },
      { userId: f.userId }
    );
    sesion2 = abierta.sesionId;

    await clasificarPartidasDeSesion(entityScope(f.tenantId, f.entityId), sesion2, {
      userId: f.userId,
    });
    // UNA SOLA PARTIDA, y ahí está la prueba del cotejo que `post` escribió en
    // agosto. Las partidas se levantan ACUMULADAS hasta el cierre del periodo,
    // así que la comisión de agosto sería candidata otra vez si su movimiento
    // no tuviera cotejo vivo — ya estando en libros—, y septiembre descuadraría
    // por 350 sin que nada lo explicara.
    const items = await query<{ id: string }>(
      `SELECT id FROM reconciling_items WHERE reconciliation_session_id = $1`,
      [sesion2]
    );
    expect(items.rows).toHaveLength(1);
    const partida = items.rows[0].id;
    await query(
      `UPDATE reconciling_items SET fecha_esperada = '2026-10-15' WHERE id = $1`,
      [partida]
    );
    const ajuste = await crearAjuste(
      f.entityId,
      sesion2,
      { tipo: 'comision', cuenta: cuentaDeComision, importe: '-200.00' },
      f.userId,
      { reconcilingItemId: partida }
    );
    draftId = ajuste.draftId;
    await cerrarSesion(entityScope(f.tenantId, f.entityId), sesion2, {}, { userId: f.userId });

    await reopenPolicy({ tenantId: f.tenantId, entityId: f.entityId }, 'segregacion_de_funciones');
    await resolvePolicy(
      { tenantId: f.tenantId, entityId: f.entityId },
      'segregacion_de_funciones',
      'alertar',
      'sonda@f05d'
    );

    // MISMO usuario que cerró: con 'alertar' pasa, y la bitácora lo dice.
    const r = await aprobarSesion(
      entityScope(f.tenantId, f.entityId),
      sesion2,
      {},
      { userId: f.userId }
    );
    expect(r.estado).toBe('approved');
    expect(r.segregacion.coincide).toBe(true);
    expect(r.segregacion.nota).toMatch(/quien aprueba la conciliación es quien la cerró/);

    const rastro = await query<{ reason: string | null; new_values: { aprobador_es_preparador: boolean } }>(
      `SELECT reason, new_values FROM audit_log
        WHERE entity_id = $1 AND action = 'approve' ORDER BY timestamp DESC LIMIT 1`,
      [sesion2]
    );
    expect(rastro.rows[0].reason).toMatch(/SoD/);
    expect(rastro.rows[0].new_values.aprobador_es_preparador).toBe(true);
  });

  it('el borrador que el revisor ya aprobó se ADOPTA, no se postea otra vez', async () => {
    // El revisor pasa por `mnemosine review` entre la firma y la
    // contabilización: su asiento YA existe.
    const ctxAgente = await resolveEntity(f.entityId);
    const correo = (
      await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [f.userId])
    ).rows[0].email;
    const revisor = await resolveReviewer(f.tenantId, correo);
    const posteado = await approveDraft(ctxAgente, draftId, revisor);
    asientoDelRevisor = posteado.entryId;

    const antes = await asientosDeLaEntidad();
    const r = await contabilizarSesion(
      entityScope(f.tenantId, f.entityId),
      sesion2,
      {},
      { userId: segundoUsuario }
    );
    expect(r.posteados).toBe(0);
    expect(r.adoptados).toBe(1);
    expect(r.asientos[0].journalEntryId).toBe(asientoDelRevisor);
    // NINGÚN asiento nuevo: la comisión de septiembre está una sola vez.
    expect(await asientosDeLaEntidad()).toBe(antes);

    const ajuste = await query<{ journal_entry_id: string | null }>(
      `SELECT journal_entry_id FROM reconciliation_adjustments
        WHERE reconciliation_session_id = $1`,
      [sesion2]
    );
    expect(ajuste.rows[0].journal_entry_id).toBe(asientoDelRevisor);

    // Y la línea de banco del asiento del revisor queda sellada igual: el sello
    // no depende de quién posteó, sino de que la sesión lo dé por explicado.
    const banco = await query<{ is_reconciled: boolean; reconciliation_id: string | null }>(
      `SELECT is_reconciled, reconciliation_id FROM journal_entry_lines
        WHERE journal_entry_id = $1 AND account_id = $2`,
      [asientoDelRevisor, glBanco]
    );
    expect(banco.rows[0].is_reconciled).toBe(true);
    expect(banco.rows[0].reconciliation_id).toBe(r.grupoDelSello);
  });

  it('y septiembre sigue cuadrando después de contabilizar', async () => {
    const e = await estadoDeSesion(entityScope(f.tenantId, f.entityId), { sesionId: sesion2 });
    expect(e.aritmetica.libros.saldo).toBe('-550.00');
    expect(e.aritmetica.variacion).toBe('0.00');
    expect(e.aritmetica.cuadra).toBe(true);
  });
});
