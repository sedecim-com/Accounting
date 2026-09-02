import { describe, it, expect, afterAll } from 'vitest';
import Decimal from 'decimal.js';
import { v4 as uuidv4 } from 'uuid';
import {
  crearInquilino,
  crearEntidadHermana,
  fechaEnPeriodo,
  type Fixture,
} from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { createAccount } from '../../src/services/accounting/account-service.js';
import { JournalEntryType } from '../../src/types/index.js';
import {
  getCashFlowStatement,
  politicasDeFlujo,
  type CashFlowStatement,
} from '../../src/services/reporting/cash-flow-service.js';
import {
  movimientoRealDeEfectivo,
  conciliarFlujoDeEfectivo,
} from '../../src/services/reporting/cash-flow-reconcile.js';

// ============================================================
// G1b · EL ATAQUE AL ESTADO DE FLUJOS DE EFECTIVO
//
// Este es el ÚNICO estado financiero cuyo error es comprobable desde fuera:
// el cliente lo compara contra su banco. Así que la afirmación central que se
// ataca aquí no es «las secciones se ven bien», es la única que el banco
// puede desmentir:
//
//     neto del estado === variación de caja y bancos en el mayor
//
// Todo lo demás —secciones, método, políticas, frontera— se ataca alrededor
// de esa igualdad, con IMPORTES EXACTOS construidos a mano y verificados
// contra el mayor por una consulta que NO usa el módulo bajo prueba.
//
// Corre como superusuario a propósito (ver frontera-entidad-ten): RLS queda
// inerte y lo que se ataca es la ARITMÉTICA DEL CÓDIGO, no el predicado.
// ============================================================

const JULIO = { startDate: '2026-07-01', endDate: '2026-07-31' };

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

// ---- utilería de libros --------------------------------------------

async function asiento(
  f: Fixture,
  mes: number,
  desc: string,
  cargo: string,
  abono: string,
  monto: string,
  tipo: JournalEntryType = JournalEntryType.STANDARD
) {
  return createJournalEntry(
    f.entityId,
    fechaEnPeriodo(mes, 10),
    tipo,
    desc,
    [
      { account_id: cargo, debit_amount: monto, credit_amount: null, description: desc },
      { account_id: abono, debit_amount: null, credit_amount: monto, description: desc },
    ],
    f.userId,
    { autoPost: true }
  );
}

async function cuenta(
  f: Fixture,
  code: string,
  name: string,
  account_type: string,
  normal_balance: 'debit' | 'credit',
  account_subtype: string | null,
  fs_category: string | null
): Promise<string> {
  const a = await createAccount({
    code,
    name,
    account_type,
    account_subtype,
    fs_category,
    entity_id: f.entityId,
    normal_balance,
    created_by: f.userId,
  } as unknown as Parameters<typeof createAccount>[0]);
  return a.id;
}

/**
 * LAS TRES FILAS DEL PANEL QUE G1b NECESITA, SEMBRADAS A MANO.
 *
 * NO ES UN AUXILIAR DE CONVENIENCIA: es el andamio que sostiene esta suite
 * mientras `pending-catalog.ts` no declare las claves. Sin él, `getPolicy`
 * lanza «Policy "flujo_efectivo_metodo" does not exist in the catalog or in
 * the database» y NINGUNA de las pruebas de abajo llega a mirar una cifra.
 * El bloque 0 documenta ese estado; el resto de la suite lo esquiva para
 * poder atacar la aritmética, que es lo que aquí se vino a atacar.
 */
async function sembrarPoliticasDeFlujo(f: Fixture, valores: Record<string, string> = {}) {
  const filas: Array<[string, string, string]> = [
    ['flujo_efectivo_metodo', 'indirecto', 'Por qué método se construye el estado de flujos'],
    ['flujo_efectivo_cuentas_de_efectivo', 'rol', 'Qué cuentas son efectivo y equivalentes'],
    ['flujo_efectivo_descuadre', 'avisar', 'Qué hacer cuando el estado no amarra con el efectivo'],
  ];
  for (const [key, defecto, pregunta] of filas) {
    const resuelto = valores[key];
    await query(
      `INSERT INTO policy_decisions (id, tenant_id, entity_id, key, category, question, impact,
         options, default_value, status, resolved_value, resolved_by, resolved_at, priority)
       VALUES ($1,$2,$3,$4,'reporting',$5,'G1b',$6::jsonb,$7,
         $8, $9, CASE WHEN $9::text IS NULL THEN NULL ELSE 'ataque-g1b' END,
         CASE WHEN $9::text IS NULL THEN NULL ELSE NOW() END, 50)
       ON CONFLICT (tenant_id, entity_id, key) WHERE entity_id IS NOT NULL
       DO UPDATE SET status = EXCLUDED.status, resolved_value = EXCLUDED.resolved_value,
                     resolved_by = EXCLUDED.resolved_by, resolved_at = EXCLUDED.resolved_at`,
      [
        uuidv4(), f.tenantId, f.entityId, key, pregunta, JSON.stringify([]), defecto,
        resuelto ? 'resolved' : 'pending', resuelto ?? null,
      ]
    );
  }
}

/**
 * LA VARIACIÓN DE CAJA Y BANCOS, A MANO Y DESDE EL MAYOR.
 *
 * No usa el módulo bajo prueba: si el estado y su amarre salieran los dos de
 * la misma función equivocada, coincidirían y la prueba pasaría. Éste es el
 * tercer testigo, y es contra él contra quien se compara el neto.
 */
async function variacionAMano(
  entityId: string,
  cuentas: string[],
  { startDate, endDate }: { startDate: string; endDate: string }
): Promise<string> {
  const { rows } = await query<{ v: string }>(
    `SELECT COALESCE(SUM(COALESCE(jel.debit_amount,0) - COALESCE(jel.credit_amount,0)), 0)::text AS v
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN accounts a ON a.id = jel.account_id
      WHERE je.status = 'posted'
        AND je.entry_date BETWEEN $2::date AND $3::date
        AND a.entity_id = $1
        AND jel.account_id = ANY($4::uuid[])`,
    [entityId, startDate, endDate, cuentas]
  );
  return new Decimal(rows[0].v).toFixed(4);
}

function sumaDeSecciones(e: CashFlowStatement): string {
  return new Decimal(e.operating_activities.total)
    .plus(e.investing_activities.total)
    .plus(e.financing_activities.total)
    .toFixed(4);
}

function residuo(neto: string, variacion: string): string {
  return new Decimal(neto).minus(new Decimal(variacion)).toFixed(4);
}

/** Los tres totales del estado, como los pide `conciliarFlujoDeEfectivo`. */
function derivadoDe(e: CashFlowStatement) {
  return {
    method: e.method,
    operating_activities: { total: e.operating_activities.total },
    investing_activities: { total: e.investing_activities.total },
    financing_activities: { total: e.financing_activities.total },
  };
}

/**
 * Julio, a mano:
 *   venta a crédito   1120 +10 000 / 4100 +10 000
 *   cobranza          1110 + 6 000 / 1120 −  6 000
 *   gasto a crédito   6100 + 4 000 / 2110 +  4 000
 *   pago a proveedor  2110 − 1 500 / 1110 −  1 500
 *   depreciación      6140 + 1 000 / 1290 +  1 000   (asiento STANDARD)
 *
 *   utilidad = 10 000 − 4 000 − 1 000 = 5 000
 *   virtuales = +1 000 · ΔCxC = +4 000 → −4 000 · ΔCxP = +2 500 → +2 500
 *   operación = 4 500        EFECTIVO REAL = +6 000 − 1 500 = 4 500
 *
 * La depreciación va como asiento STANDARD A PROPÓSITO: la ruta REST la
 * detectaba por `entry_type = 'auto_depreciation'`, y un motor que herede ese
 * criterio se deja los 1 000 fuera y el residuo sale −1 000.
 */
async function julioConMovimiento(f: Fixture) {
  await asiento(f, 7, 'Venta a crédito', f.cuentas['1120'], f.cuentas['4100'], '10000.0000');
  await asiento(f, 7, 'Cobranza', f.cuentas['1110'], f.cuentas['1120'], '6000.0000');
  await asiento(f, 7, 'Gasto a crédito', f.cuentas['6100'], f.cuentas['2110'], '4000.0000');
  await asiento(f, 7, 'Pago a proveedor', f.cuentas['2110'], f.cuentas['1110'], '1500.0000');
  await asiento(f, 7, 'Depreciación del mes', f.cuentas['6140'], f.cuentas['1290'], '1000.0000');
}

// ============================================================
// 0 · LA PUERTA: ¿ARRANCA SIQUIERA?
//
// Las tres políticas de G1b tienen que existir en el panel para que alguien
// pueda leerlas. Si no están, `getPolicy` no devuelve un defecto: LANZA. Este
// bloque mide exactamente eso, sin andamio, sobre un inquilino sembrado con
// `seedPolicies` como lo estaría una instalación real.
// ============================================================

describe('la puerta: las tres políticas de G1b contra el panel real', () => {
  it('un inquilino sembrado normalmente puede construir su estado de flujos', async () => {
    const f = await crearInquilino('G1b puerta');
    enterTenant(f.tenantId);
    await julioConMovimiento(f);

    // `seedPolicies` siembra el catálogo entero. Si las tres claves de G1b
    // están declaradas, esto pasa; si no, `politicasDeFlujo` revienta y el
    // informe entero es inalcanzable para toda entidad de toda instalación.
    const { seedPolicies } = await import('../../src/services/policy/policy-service.js');
    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });

    const pol = await politicasDeFlujo(f.entityId);
    expect(pol.metodo).toBe('indirecto');
    expect(pol.cuentasDeEfectivo).toBe('rol');
    expect(pol.descuadre).toBe('avisar');

    const e = await getCashFlowStatement(f.entityId, JULIO);
    expect(e.net_cash_flow).toBe('4500.0000');
  });
});

// ============================================================
// 1 · EL AMARRE: EL NETO CONTRA EL BANCO
// ============================================================

describe('el neto del estado contra la variación real de caja y bancos', () => {
  it('iguala al peso: 4 500 de operación y 4 500 en el banco', async () => {
    const f = await crearInquilino('G1b amarre');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f);
    await julioConMovimiento(f);

    const e = await getCashFlowStatement(f.entityId, JULIO);
    const real = await movimientoRealDeEfectivo(f.entityId, JULIO);
    const aMano = await variacionAMano(
      f.entityId,
      real.cuentas.map((c) => c.account_id),
      JULIO
    );

    expect(aMano).toBe('4500.0000');
    expect(real.variacion).toBe('4500.0000');
    expect(e.net_cash_flow).toBe('4500.0000');
    expect(residuo(e.net_cash_flow, real.variacion)).toBe('0.0000');
  });

  it('las tres piezas del indirecto salen con su importe, no en cero', async () => {
    const f = await crearInquilino('G1b piezas');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f);
    await julioConMovimiento(f);

    const op = (await getCashFlowStatement(f.entityId, JULIO)).operating_activities;
    expect(op.net_income).toBe('5000.0000');
    // La depreciación se devuelve aunque el asiento sea STANDARD: el criterio
    // es la CUENTA, no el `entry_type` que miraba la ruta REST.
    expect(op.non_cash.total).toBe('1000.0000');
    // EL DEFECTO 3 EN PERSONA: con `name ILIKE '%receivable%'` esto vale cero.
    expect(op.working_capital.total).toBe('-1500.0000');
    expect(op.total).toBe('4500.0000');
  });

  it('la suma de las tres secciones es EXACTAMENTE el neto, a cuatro decimales', async () => {
    const f = await crearInquilino('G1b suma');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f);
    await julioConMovimiento(f);
    // Un tercio de peso tres veces: si algo redondea antes de sumar, la suma
    // de secciones y el neto se separan en el cuarto decimal.
    await asiento(f, 7, 'Tercio uno', f.cuentas['1110'], f.cuentas['4100'], '33.3333');
    await asiento(f, 7, 'Tercio dos', f.cuentas['1110'], f.cuentas['4100'], '33.3333');
    await asiento(f, 7, 'Tercio tres', f.cuentas['1110'], f.cuentas['4100'], '33.3334');

    const e = await getCashFlowStatement(f.entityId, JULIO);
    const real = await movimientoRealDeEfectivo(f.entityId, JULIO);

    expect(sumaDeSecciones(e)).toBe(e.net_cash_flow);
    expect(e.net_cash_flow).toBe('4600.0000');
    expect(real.variacion).toBe('4600.0000');
    for (const [etiqueta, importe] of [
      ['neto', e.net_cash_flow],
      ['operación', e.operating_activities.total],
      ['inversión', e.investing_activities.total],
      ['financiamiento', e.financing_activities.total],
      ['saldo inicial', real.saldo_inicial],
      ['saldo final', real.saldo_final],
      ['variación', real.variacion],
    ] as const) {
      expect(importe, etiqueta).toMatch(/^-?\d+\.\d{4}$/);
    }
  });

  it('el saldo inicial y el final son los del mayor, y su diferencia es la variación', async () => {
    const f = await crearInquilino('G1b saldos');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f);
    // Junio deja 20 000: el saldo inicial de julio NO es cero, y un amarre que
    // arrancara en cero lo enseñaría aquí.
    await asiento(f, 6, 'Aportación previa', f.cuentas['1110'], f.cuentas['3100'], '20000.0000');
    await julioConMovimiento(f);

    const real = await movimientoRealDeEfectivo(f.entityId, JULIO);
    expect(real.saldo_inicial).toBe('20000.0000');
    expect(real.saldo_final).toBe('24500.0000');
    expect(new Decimal(real.saldo_final).minus(real.saldo_inicial).toFixed(4)).toBe(real.variacion);
  });

  it('el estado y su amarre llaman efectivo a las MISMAS cuentas', async () => {
    // Si el encabezado nombra un juego de cuentas y el amarre compara contra
    // otro, el residuo no mide lo que el documento dice medir.
    const f = await crearInquilino('G1b mismo efectivo');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f);
    await julioConMovimiento(f);

    const e = await getCashFlowStatement(f.entityId, JULIO);
    const real = await movimientoRealDeEfectivo(f.entityId, JULIO);
    expect(e.cash_accounts.map((c) => c.id).sort()).toEqual(
      real.cuentas.map((c) => c.account_id).sort()
    );
    expect(e.cash_accounts.length).toBeGreaterThan(0);
  });
});

// ============================================================
// 2 · EL DESCUADRE FABRICADO
//
// Una cuenta de activo SIN `fs_category` —la que produce `account create` sin
// clasificar, o un catálogo importado a medias—. El clasificador la deja
// 'sin_clasificar', el neto no la cuenta y el banco sí: residuo de 12 000
// exactos. Lo que se exige no es que el motor sepa clasificarla; es que si no
// sabe, lo DIGA con el importe y el nombre, y no lo absorba.
// ============================================================

async function julioConAgujero(f: Fixture): Promise<string> {
  await julioConMovimiento(f);
  const enTramite = await cuenta(f, '1170', 'Cuenta en Trámite', 'asset', 'debit', null, null);
  await asiento(f, 7, 'Traspaso a cuenta en trámite', enTramite, f.cuentas['1110'], '12000.0000');
  return enTramite;
}

describe('un descuadre fabricado', () => {
  it('sale con su importe EXACTO, con nombre y apellido, y no absorbido', async () => {
    const f = await crearInquilino('G1b descuadre');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f);
    const enTramite = await julioConAgujero(f);

    const e = await getCashFlowStatement(f.entityId, JULIO);
    const real = await movimientoRealDeEfectivo(f.entityId, JULIO);
    const aMano = await variacionAMano(
      f.entityId,
      real.cuentas.map((c) => c.account_id),
      JULIO
    );

    expect(aMano).toBe('-7500.0000');
    expect(real.variacion).toBe('-7500.0000');
    expect(residuo(e.net_cash_flow, real.variacion)).toBe('12000.0000');

    // NO ABSORBIDO: la cuenta sale nombrada, fuera de los tres totales, y la
    // suma de secciones sigue siendo el neto publicado.
    expect(e.unclassified.total).toBe('-12000.0000');
    expect(e.unclassified.lines.map((l) => l.account_id)).toContain(enTramite);
    expect(sumaDeSecciones(e)).toBe(e.net_cash_flow);
    expect(e.self_check?.ties).toBe(false);
  });

  it('una recompra de acciones propias SÍ es financiamiento: no todo lo raro es residuo', async () => {
    // `contra_equity` es la única de las ocho familias de `account_type` que
    // el catálogo sembrado nunca usa. Un clasificador con seis brazos la
    // manda al residuo y el estado deja de amarrar por 12 000.
    const f = await crearInquilino('G1b tesorería');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f);
    await julioConMovimiento(f);
    const tesoreria = await cuenta(
      f, '3400', 'Acciones en Tesorería', 'contra_equity', 'debit', 'treasury_stock', 'equity'
    );
    await asiento(f, 7, 'Recompra de acciones propias', tesoreria, f.cuentas['1110'], '12000.0000');

    const e = await getCashFlowStatement(f.entityId, JULIO);
    const real = await movimientoRealDeEfectivo(f.entityId, JULIO);

    expect(real.variacion).toBe('-7500.0000');
    expect(e.financing_activities.total).toBe('-12000.0000');
    expect(e.financing_activities.lines.map((l) => l.account_id)).toContain(tesoreria);
    expect(e.unclassified.lines).toHaveLength(0);
    expect(residuo(e.net_cash_flow, real.variacion)).toBe('0.0000');
  });

  it('un asiento cojo NO se puede postear: el descuadre del mayor lo cierra la base', async () => {
    // El caso que el banco caza de verdad sería éste: salió dinero y la
    // contrapartida nunca se registró. Se intenta por la única puerta que
    // queda —SQL crudo, saltándose `createJournalEntry`— y la base lo rehúsa:
    // `CHECK (status <> 'posted' OR total_debits = total_credits)`.
    //
    // Importa decirlo porque es lo que sostiene el resto de este archivo: si
    // el mayor no puede quedar descuadrado, el residuo del estado no puede
    // venir de un asiento cojo. Sólo puede venir de una cuenta que el motor
    // no supo clasificar — y ésa sí sale nombrada.
    const f = await crearInquilino('G1b asiento cojo');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f);
    await julioConMovimiento(f);

    const je = uuidv4();
    await query(
      `INSERT INTO journal_entries (id, entity_id, entry_number, entry_date, entry_type, status,
         description, fiscal_period_id, created_by)
       VALUES ($1,$2,$3,$4::date,'standard','draft','Retiro sin contrapartida',$5,$6)`,
      [je, f.entityId, `COJO-${je.slice(0, 8)}`, '2026-07-20', f.periodos[7], f.userId]
    );
    await query(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, credit_amount)
       VALUES ($1,$2,1,$3,'900.0000')`,
      [uuidv4(), je, f.cuentas['1110']]
    );

    await expect(
      query(
        `UPDATE journal_entries SET status='posted', posted_date=NOW(), posted_by=$2 WHERE id=$1`,
        [je, f.userId]
      )
    ).rejects.toThrow();

    // Y el borrador no entra al estado ni al amarre: el mayor sigue diciendo
    // 4 500 por las dos vías.
    const e = await getCashFlowStatement(f.entityId, JULIO);
    const real = await movimientoRealDeEfectivo(f.entityId, JULIO);
    expect(real.variacion).toBe('4500.0000');
    expect(e.net_cash_flow).toBe('4500.0000');
    expect(residuo(e.net_cash_flow, real.variacion)).toBe('0.0000');
  });
});

// ============================================================
// 3 · LAS TRES POLÍTICAS: GOBIERNAN EL VEREDICTO, NUNCA EL IMPORTE
// ============================================================

describe('flujo_efectivo_descuadre', () => {
  it('«bloquear» se rehúsa, «silencio» calla, «avisar» nombra — y el importe es el mismo', async () => {
    const f = await crearInquilino('G1b políticas');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f);
    await julioConAgujero(f);

    const e = await getCashFlowStatement(f.entityId, JULIO);
    const derivado = derivadoDe(e);

    const avisar = await conciliarFlujoDeEfectivo(f.entityId, { ...JULIO, derivado });
    expect(avisar.residuo.cuadra).toBe(false);
    expect(avisar.residuo.importe).toBe('12000.0000');
    expect(avisar.trato).toBe('nombrado');
    expect(avisar.hallazgos).toEqual({ blocking: 0, warning: 1 });
    expect(avisar.aviso).toContain('12000.0000');

    await sembrarPoliticasDeFlujo(f, { flujo_efectivo_descuadre: 'bloquear' });
    const bloquear = await conciliarFlujoDeEfectivo(f.entityId, { ...JULIO, derivado });
    expect(bloquear.trato).toBe('bloqueado');
    expect(bloquear.hallazgos.blocking).toBe(1);
    expect(bloquear.residuo.importe).toBe('12000.0000');

    await sembrarPoliticasDeFlujo(f, { flujo_efectivo_descuadre: 'silencio' });
    const silencio = await conciliarFlujoDeEfectivo(f.entityId, { ...JULIO, derivado });
    expect(silencio.trato).toBe('silenciado');
    expect(silencio.hallazgos.blocking).toBe(0);
    // Callar el VEREDICTO no es borrar la MEDICIÓN: el importe sigue ahí.
    expect(silencio.residuo.importe).toBe('12000.0000');
  });

  it('«bloquear» impide EMITIR el estado, no sólo conciliarlo', async () => {
    // Si la política sólo gobernara `reconcile`, quien corriera `generate`
    // publicaría el estado descuadrado sin enterarse: la puerta de atrás.
    const f = await crearInquilino('G1b bloquear emite');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f, { flujo_efectivo_descuadre: 'bloquear' });
    await julioConAgujero(f);

    let publicado: CashFlowStatement | undefined;
    let error: unknown;
    try {
      publicado = await getCashFlowStatement(f.entityId, JULIO);
    } catch (err) {
      error = err;
    }
    if (!error) {
      // Si emite, al menos tiene que traer el hallazgo en el cuerpo y NUNCA
      // decir que amarra.
      expect(publicado?.self_check?.ties).toBe(false);
      expect(publicado?.self_check?.unclassified_total).not.toBe('0.0000');
    } else {
      expect(String((error as Error).message)).toContain('bloquear');
    }
  });

  it('«silencio» no borra el residuo del cuerpo del estado', async () => {
    const f = await crearInquilino('G1b silencio cuerpo');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f, { flujo_efectivo_descuadre: 'silencio' });
    const enTramite = await julioConAgujero(f);

    const e = await getCashFlowStatement(f.entityId, JULIO);
    const real = await movimientoRealDeEfectivo(f.entityId, JULIO);

    // Apagar el aviso no puede apagar la aritmética: los 12 000 siguen fuera
    // del neto y la cuenta que los causó sigue nombrada.
    expect(residuo(e.net_cash_flow, real.variacion)).toBe('12000.0000');
    expect(e.unclassified.lines.map((l) => l.account_id)).toContain(enTramite);
    expect(e.unclassified.total).toBe('-12000.0000');
  });
});

// ============================================================
// 4 · INVERSIÓN: DEL MAYOR, NO DE `fixed_assets`
// ============================================================

describe('las actividades de inversión salen del mayor', () => {
  it('un activo comprado a crédito NO es salida de efectivo, y se revela', async () => {
    const f = await crearInquilino('G1b activo a crédito');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f);
    await julioConMovimiento(f);
    await asiento(f, 7, 'Maquinaria a crédito', f.cuentas['1210'], f.cuentas['2110'], '30000.0000');

    // Y con su fila en `fixed_assets`, que es de donde salía la mentira.
    const cat = uuidv4();
    await query(
      `INSERT INTO asset_categories (id, entity_id, name, default_useful_life_years,
         default_depreciation_method) VALUES ($1,$2,'Maquinaria',10,'straight_line')`,
      [cat, f.entityId]
    );
    await query(
      `INSERT INTO fixed_assets (id, entity_id, asset_number, asset_name, category_id,
         acquisition_date, acquisition_cost, useful_life_years, useful_life_months,
         depreciation_method, depreciation_start_date, current_book_value,
         asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id,
         created_by)
       VALUES ($1,$2,'FA-1','Maquinaria a crédito',$3,'2026-07-10','30000.0000',10,120,
         'straight_line','2026-07-10','30000.0000',$4,$5,$6,$7)`,
      [uuidv4(), f.entityId, cat, f.cuentas['1210'], f.cuentas['1290'], f.cuentas['6140'], f.userId]
    );

    const e = await getCashFlowStatement(f.entityId, JULIO);
    const real = await movimientoRealDeEfectivo(f.entityId, JULIO);

    expect(real.variacion).toBe('4500.0000');
    expect(e.net_cash_flow).toBe('4500.0000');
    expect(residuo(e.net_cash_flow, real.variacion)).toBe('0.0000');
    // La mitad que inventaba la salida: inversión NO puede decir −30 000.
    expect(e.investing_activities.total).toBe('0.0000');
    // NIF B-2 / ASC 230-10-50-3: fuera del cuerpo, pero REVELADA.
    expect(e.non_cash_transactions.length).toBeGreaterThan(0);
    expect(
      e.non_cash_transactions.some((t) => new Decimal(t.amount).abs().toFixed(4) === '30000.0000')
    ).toBe(true);
  });

  it('una baja registrada SÓLO en el mayor sí aparece en inversión', async () => {
    const f = await crearInquilino('G1b baja sólo en mayor');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f);
    await julioConMovimiento(f);
    // Venta de mobiliario a valor en libros, cobrada. Ninguna fila en
    // `fixed_assets`: la ruta REST no la habría visto jamás.
    await asiento(f, 7, 'Venta de mobiliario', f.cuentas['1110'], f.cuentas['1210'], '8000.0000');

    const e = await getCashFlowStatement(f.entityId, JULIO);
    const real = await movimientoRealDeEfectivo(f.entityId, JULIO);

    expect(real.variacion).toBe('12500.0000');
    expect(e.investing_activities.total).toBe('8000.0000');
    expect(e.net_cash_flow).toBe('12500.0000');
    expect(residuo(e.net_cash_flow, real.variacion)).toBe('0.0000');
  });
});

// ============================================================
// 5 · FINANCIAMIENTO: NUNCA MÁS LA CADENA '0.0000' POR AFIRMACIÓN
// ============================================================

describe('el financiamiento se calcula', () => {
  it('préstamo, amortización, dividendo y aportación suman su cifra', async () => {
    const f = await crearInquilino('G1b financiamiento');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f);
    await julioConMovimiento(f);

    const prestamo = await cuenta(
      f, '2200', 'Préstamos Bancarios a Largo Plazo', 'liability', 'credit',
      'long_term_liability', 'long_term_liabilities'
    );
    await asiento(f, 7, 'Préstamo recibido', f.cuentas['1110'], prestamo, '100000.0000');
    await asiento(f, 7, 'Amortización de capital', prestamo, f.cuentas['1110'], '20000.0000');
    await asiento(f, 7, 'Dividendo pagado', f.cuentas['3200'], f.cuentas['1110'], '15000.0000');
    await asiento(f, 7, 'Aportación de capital', f.cuentas['1110'], f.cuentas['3100'], '50000.0000');

    const e = await getCashFlowStatement(f.entityId, JULIO);
    const real = await movimientoRealDeEfectivo(f.entityId, JULIO);

    expect(e.financing_activities.total).toBe('115000.0000');
    expect(e.financing_activities.total).not.toBe('0.0000');
    // Con su renglón cada una: un total correcto en una sola línea no se audita.
    expect(e.financing_activities.lines.length).toBeGreaterThanOrEqual(3);
    expect(real.variacion).toBe('119500.0000');
    expect(e.net_cash_flow).toBe('119500.0000');
    expect(residuo(e.net_cash_flow, real.variacion)).toBe('0.0000');
  });
});

// ============================================================
// 6 · LOS NOMBRES EN ESPAÑOL, Y LOS QUE NO SON NI ESOS
// ============================================================

describe('el capital de trabajo no depende del idioma del catálogo', () => {
  it('con «Clientes» y «Proveedores» renombrados sale la misma cifra', async () => {
    const f = await crearInquilino('G1b renombre');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f);
    await julioConMovimiento(f);
    await query(`UPDATE accounts SET name='Clientes' WHERE entity_id=$1 AND code='1120'`, [f.entityId]);
    await query(`UPDATE accounts SET name='Proveedores' WHERE entity_id=$1 AND code='2110'`, [f.entityId]);

    const e = await getCashFlowStatement(f.entityId, JULIO);
    expect(e.operating_activities.working_capital.total).toBe('-1500.0000');
    expect(e.net_cash_flow).toBe('4500.0000');
  });

  it('con un catálogo IMPORTADO —códigos y nombres ajenos— tampoco sale en cero', async () => {
    const f = await crearInquilino('G1b catálogo importado');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f);

    // Cuentas que ninguna semilla de esta casa produjo, y cuyos nombres no
    // contienen «cobrar», «pagar», «receivable» ni «payable».
    const deudores = await cuenta(f, '105-01', 'Deudores Diversos Nacionales', 'asset', 'debit', 'current_asset', 'current_assets');
    const acreedores = await cuenta(f, '205-01', 'Acreedores Diversos Nacionales', 'liability', 'credit', 'current_liability', 'current_liabilities');
    await query(
      `UPDATE account_roles SET account_id=$1 WHERE entity_id=$2 AND role='cxc' AND qualifier IS NULL`,
      [deudores, f.entityId]
    );
    await query(
      `UPDATE account_roles SET account_id=$1 WHERE entity_id=$2 AND role='cxp' AND qualifier IS NULL`,
      [acreedores, f.entityId]
    );

    await asiento(f, 7, 'Venta a crédito', deudores, f.cuentas['4100'], '10000.0000');
    await asiento(f, 7, 'Cobranza', f.cuentas['1110'], deudores, '6000.0000');
    await asiento(f, 7, 'Gasto a crédito', f.cuentas['6100'], acreedores, '4000.0000');
    await asiento(f, 7, 'Pago', acreedores, f.cuentas['1110'], '1500.0000');

    const e = await getCashFlowStatement(f.entityId, JULIO);
    const real = await movimientoRealDeEfectivo(f.entityId, JULIO);

    expect(e.operating_activities.working_capital.total).toBe('-1500.0000');
    expect(e.operating_activities.working_capital.total).not.toBe('0.0000');
    expect(e.net_cash_flow).toBe('4500.0000');
    expect(residuo(e.net_cash_flow, real.variacion)).toBe('0.0000');
  });
});

// ============================================================
// 7 · EL MÉTODO DIRECTO: O ES DIRECTO, O FALLA CERRADO
//
// La ruta REST aceptaba `method=direct`, no cambiaba una consulta y devolvía
// el indirecto rotulado como directo. Es el peor de los cuatro defectos: el
// documento MIENTE SOBRE SÍ MISMO. No se exige que el directo exista; se
// exige que si no existe, se rehúse.
// ============================================================

describe('--method direct', () => {
  it('o sale el directo de verdad, o se rehúsa; jamás el indirecto con otra etiqueta', async () => {
    const f = await crearInquilino('G1b método directo');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f);
    await julioConMovimiento(f);

    let e: CashFlowStatement | undefined;
    let error: unknown;
    try {
      e = await getCashFlowStatement(f.entityId, { ...JULIO, metodo: 'directo' });
    } catch (err) {
      error = err;
    }

    if (error) {
      // Falla cerrado. El mensaje tiene que decir QUÉ falta, no «no soportado».
      const m = String((error as Error).message);
      expect(m.length).toBeGreaterThan(60);
      expect(m.toLowerCase()).toContain('direct');
      return;
    }
    // Si emitió, el cuerpo tiene que ser el directo: cobros y pagos brutos, y
    // NUNCA el renglón de utilidad neta con el que arranca el indirecto.
    expect((e as CashFlowStatement).method).toBe('direct');
    expect((e as CashFlowStatement).operating_activities.net_income).toBe('0.0000');
    expect((e as CashFlowStatement).operating_activities.working_capital.lines).toHaveLength(0);
  });

  it('la política del panel en «directo» tampoco puede publicar un indirecto rotulado', async () => {
    const f = await crearInquilino('G1b política directo');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f, { flujo_efectivo_metodo: 'directo' });
    await julioConMovimiento(f);

    let e: CashFlowStatement | undefined;
    let error: unknown;
    try {
      e = await getCashFlowStatement(f.entityId, JULIO);
    } catch (err) {
      error = err;
    }
    if (!error) {
      expect((e as CashFlowStatement).method).not.toBe('indirect');
    } else {
      expect(String((error as Error).message).toLowerCase()).toContain('direct');
    }
  });
});

// ============================================================
// 8 · FRONTERA DE ENTIDAD (SERIE TEN)
//
// Dos entidades legales del MISMO inquilino: es donde RLS no acota nada,
// porque su predicado es el inquilino.
// ============================================================

describe('frontera de entidad', () => {
  it('el estado de A no ve ni un peso de B, ni en el neto ni en el amarre', async () => {
    const a = await crearInquilino('G1b frontera A');
    enterTenant(a.tenantId);
    const b = await crearEntidadHermana(a, 'G1b frontera B');
    await sembrarPoliticasDeFlujo(a);
    await sembrarPoliticasDeFlujo(b);

    await julioConMovimiento(a);
    await asiento(b, 7, 'Venta B', b.cuentas['1110'], b.cuentas['4100'], '777000.0000');

    const ea = await getCashFlowStatement(a.entityId, JULIO);
    const ra = await movimientoRealDeEfectivo(a.entityId, JULIO);
    const eb = await getCashFlowStatement(b.entityId, JULIO);
    const rb = await movimientoRealDeEfectivo(b.entityId, JULIO);

    expect(ea.net_cash_flow).toBe('4500.0000');
    expect(ra.variacion).toBe('4500.0000');
    expect(eb.net_cash_flow).toBe('777000.0000');
    expect(rb.variacion).toBe('777000.0000');

    const deB = new Set(Object.values(b.cuentas));
    const lineas = [
      ...ea.operating_activities.non_cash.lines,
      ...ea.operating_activities.working_capital.lines,
      ...ea.investing_activities.lines,
      ...ea.financing_activities.lines,
      ...ea.unclassified.lines,
    ];
    for (const l of lineas) expect(deB.has(l.account_id), `${l.code} ${l.name}`).toBe(false);
    for (const c of ra.cuentas) expect(deB.has(c.account_id), `efectivo ${c.code}`).toBe(false);
    for (const c of ea.cash_accounts) expect(deB.has(c.id), `cash_accounts ${c.code}`).toBe(false);
  });

  it('la política de A no gobierna el estado de B', async () => {
    const a = await crearInquilino('G1b política frontera A');
    enterTenant(a.tenantId);
    const b = await crearEntidadHermana(a, 'G1b política frontera B');
    await sembrarPoliticasDeFlujo(a, { flujo_efectivo_descuadre: 'bloquear' });
    await sembrarPoliticasDeFlujo(b);

    expect((await politicasDeFlujo(a.entityId)).descuadre).toBe('bloquear');
    expect((await politicasDeFlujo(b.entityId)).descuadre).toBe('avisar');
  });
});

// ============================================================
// 9 · EL PERIODO VACÍO: CERO HONESTO, NO CERO POR VACUIDAD
//
// «No había nada que mirar» y «miré y no había nada» son dos afirmaciones
// distintas, y el estado que las confunde es el que nadie caza.
// ============================================================

describe('un periodo sin movimientos', () => {
  it('sale en cero con las cuentas de efectivo identificadas y el criterio dicho', async () => {
    const f = await crearInquilino('G1b vacío');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f);
    // Movimiento en JUNIO: lo vacío es el periodo, no los libros.
    await asiento(f, 6, 'Aportación previa', f.cuentas['1110'], f.cuentas['3100'], '20000.0000');

    const e = await getCashFlowStatement(f.entityId, JULIO);
    const real = await movimientoRealDeEfectivo(f.entityId, JULIO);

    expect(e.net_cash_flow).toBe('0.0000');
    expect(real.variacion).toBe('0.0000');
    // Lo que separa el cero honesto del cero por vacuidad: había con qué
    // comparar, y se comparó.
    expect(real.saldo_inicial).toBe('20000.0000');
    expect(real.saldo_final).toBe('20000.0000');
    expect(real.cuentas.length).toBeGreaterThan(0);
    expect(real.criterio).toBe('rol');
    expect(e.cash_accounts.length).toBeGreaterThan(0);
  });

  it('sin cuenta de efectivo identificable NO se publica un cero como si fuera un hecho', async () => {
    const f = await crearInquilino('G1b sin efectivo');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f);
    await query(`DELETE FROM account_roles WHERE entity_id=$1 AND role='banco'`, [f.entityId]);
    await query(`DELETE FROM bank_accounts WHERE entity_id=$1`, [f.entityId]);
    await asiento(f, 7, 'Venta cobrada', f.cuentas['1110'], f.cuentas['4100'], '5000.0000');

    // El neto de un estado así no es cero: es DESCONOCIDO, y decir cero sería
    // inventarlo. Falla cerrado o lo declara; lo que no puede es callar.
    let error: unknown;
    try {
      await getCashFlowStatement(f.entityId, JULIO);
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(String((error as Error).message).toLowerCase()).toContain('banco');
  });
});

// ============================================================
// 10 · LAS DOS DEFINICIONES DE «EFECTIVO»
//
// «Qué cuentas son efectivo» está implementado DOS VECES, en dos SQL
// distintos: `resolverCuentasDeEfectivo` (cash-flow-service) y
// `cuentasDeEfectivo` (cash-flow-reconcile). Si discrepan en un solo caso, el
// estado y su amarre publican residuos distintos del mismo periodo — que es
// el defecto de los dos estados, otra vez. Se atacan las tres puertas por las
// que el efectivo puede entrar sin pasar por 1110.
// ============================================================

describe('el estado y el amarre no pueden discrepar sobre qué es efectivo', () => {
  it('un rol `banco` CUALIFICADO fuera del árbol de 1110 lo ven los dos', async () => {
    const f = await crearInquilino('G1b banco cualificado');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f);
    await julioConMovimiento(f);

    // Un despacho con dos bancos mapea una variante por banco. La cuenta NO
    // cuelga de 1110: es un código de otro tramo del catálogo.
    const otroBanco = await cuenta(
      f, '1180', 'Banco del Bajío - Cuenta 2', 'asset', 'debit', 'current_asset', 'current_assets'
    );
    await query(
      `INSERT INTO account_roles (id, tenant_id, entity_id, role, account_id, qualifier)
       VALUES ($1,$2,$3,'banco',$4,'bajio')`,
      [uuidv4(), f.tenantId, f.entityId, otroBanco]
    );
    await asiento(f, 7, 'Cobro en el otro banco', otroBanco, f.cuentas['4100'], '9000.0000');

    const e = await getCashFlowStatement(f.entityId, JULIO);
    const real = await movimientoRealDeEfectivo(f.entityId, JULIO);

    expect(e.cash_accounts.map((c) => c.id).sort()).toEqual(
      real.cuentas.map((c) => c.account_id).sort()
    );
    expect(real.cuentas.map((c) => c.account_id)).toContain(otroBanco);
    expect(real.variacion).toBe('13500.0000');
    expect(e.net_cash_flow).toBe('13500.0000');
    expect(residuo(e.net_cash_flow, real.variacion)).toBe('0.0000');
  });

  it('una `bank_accounts.gl_account_id` fuera del árbol la ven los dos', async () => {
    const f = await crearInquilino('G1b cuenta bancaria suelta');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f);
    await julioConMovimiento(f);

    const suelta = await cuenta(
      f, '1185', 'Banco Extranjero', 'asset', 'debit', 'current_asset', 'current_assets'
    );
    await query(
      `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code)
       VALUES ($1,$2,'Operativa USD','Banco Extranjero',$3,'USD')`,
      [uuidv4(), f.entityId, suelta]
    );
    await asiento(f, 7, 'Cobro en el banco extranjero', suelta, f.cuentas['4100'], '7000.0000');

    const e = await getCashFlowStatement(f.entityId, JULIO);
    const real = await movimientoRealDeEfectivo(f.entityId, JULIO);

    expect(e.cash_accounts.map((c) => c.id).sort()).toEqual(
      real.cuentas.map((c) => c.account_id).sort()
    );
    expect(real.cuentas.map((c) => c.account_id)).toContain(suelta);
    expect(real.variacion).toBe('11500.0000');
    expect(residuo(e.net_cash_flow, real.variacion)).toBe('0.0000');
  });

  it('bajo el criterio «subtipo» los dos siguen viendo el mismo conjunto', async () => {
    const f = await crearInquilino('G1b subtipo');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f, { flujo_efectivo_cuentas_de_efectivo: 'subtipo' });
    // El catálogo sembrado no usa ningún subtipo de efectivo: se marca 1110
    // como lo traería un catálogo importado que sí los declara.
    await query(`UPDATE accounts SET account_subtype='cash' WHERE entity_id=$1 AND code='1110'`, [f.entityId]);
    await julioConMovimiento(f);

    const e = await getCashFlowStatement(f.entityId, JULIO);
    const real = await movimientoRealDeEfectivo(f.entityId, JULIO, );

    expect(e.policies.cuentasDeEfectivo).toBe('subtipo');
    expect(real.criterio).toBe('subtipo');
    expect(e.cash_accounts.map((c) => c.id).sort()).toEqual(
      real.cuentas.map((c) => c.account_id).sort()
    );
    expect(residuo(e.net_cash_flow, real.variacion)).toBe('0.0000');
  });
});

// ============================================================
// 11 · EL EJERCICIO QUE SE CIERRA DENTRO DEL RANGO
//
// El estado FILTRA los asientos de cierre según `informes_asientos_de_cierre`;
// el amarre los deja pasar a propósito. Los dos criterios conviven mientras el
// cierre no toque efectivo — que es lo que se afirma y lo que aquí se
// comprueba, sobre un ejercicio entero cerrado en duro.
// ============================================================

describe('un ejercicio con cierre duro dentro del rango', () => {
  it('el neto del año sigue igualando la variación de caja del año', async () => {
    const { softClosePeriod, hardClosePeriod } = await import(
      '../../src/services/accounting/period-close.js'
    );
    const f = await crearInquilino('G1b cierre en el rango');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f);
    await julioConMovimiento(f);
    await asiento(f, 12, 'Venta cobrada de diciembre', f.cuentas['1110'], f.cuentas['4100'], '3000.0000');

    await softClosePeriod(f.periodos[12], f.entityId, f.userId);
    await hardClosePeriod(f.periodos[12], f.entityId, f.userId, 'cierre del ejercicio');

    const ANIO = { startDate: '2026-01-01', endDate: '2026-12-31' };
    const e = await getCashFlowStatement(f.entityId, ANIO);
    const real = await movimientoRealDeEfectivo(f.entityId, ANIO);

    expect(real.variacion).toBe('7500.0000');
    expect(residuo(e.net_cash_flow, real.variacion)).toBe('0.0000');
    // Y el estado avisa que el rango contiene el cierre: la utilidad de su
    // primer renglón tiene que poder atarse con la del estado de resultados.
    expect(e.closing).toBeDefined();
  });
});

// ============================================================
// 12 · LOS BORDES DEL PERIODO Y LO QUE NO ES UN HECHO
//
// Un estado de flujos es un movimiento ENTRE DOS FECHAS. Los dos días
// extremos son del periodo, el día anterior es del saldo inicial, y lo que
// no está posteado no es un hecho. Cualquiera de las tres reglas rota mueve
// dinero de un mes a otro sin que nadie lo vea: el mes cuadra igual, y el
// año no.
// ============================================================

describe('los bordes del periodo', () => {
  it('el primero y el último día ENTRAN; la víspera es saldo inicial y el día siguiente no existe', async () => {
    const f = await crearInquilino('G1b bordes');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f);

    // OJO: NO se usa `fechaEnPeriodo`. Ese helper construye la fecha con
    // `Date.UTC`, y `pg` serializa un Date en la hora LOCAL del proceso: en
    // America/Chihuahua (UTC−6) la medianoche UTC del 1 de julio se guarda
    // como 2026-06-30. Con el helper, esta prueba mediría el corrimiento del
    // fixture en vez del borde del periodo — y un borde que nadie puede
    // probar es un borde que nadie defiende. Se construye en hora local, a
    // mediodía, que sobrevive a cualquier huso.
    const cobro = async (mes: number, dia: number, monto: string) =>
      createJournalEntry(
        f.entityId,
        new Date(2026, mes - 1, dia, 12, 0, 0),
        JournalEntryType.STANDARD,
        `Cobro ${mes}-${dia}`,
        [
          { account_id: f.cuentas['1110'], debit_amount: monto, credit_amount: null, description: 'x' },
          { account_id: f.cuentas['4100'], debit_amount: null, credit_amount: monto, description: 'x' },
        ],
        f.userId,
        { autoPost: true }
      );

    await cobro(6, 30, '100.0000'); // víspera: saldo inicial, no movimiento
    await cobro(7, 1, '200.0000'); // primer día: DENTRO
    await cobro(7, 31, '400.0000'); // último día: DENTRO
    await cobro(8, 1, '800.0000'); // día siguiente: FUERA

    const e = await getCashFlowStatement(f.entityId, JULIO);
    const real = await movimientoRealDeEfectivo(f.entityId, JULIO);

    expect(real.saldo_inicial).toBe('100.0000');
    expect(real.variacion).toBe('600.0000');
    expect(real.saldo_final).toBe('700.0000');
    expect(e.net_cash_flow).toBe('600.0000');
    expect(residuo(e.net_cash_flow, real.variacion)).toBe('0.0000');
  });

  it('un borrador y un asiento anulado no son hechos: ni en el estado ni en el amarre', async () => {
    const f = await crearInquilino('G1b borradores');
    enterTenant(f.tenantId);
    await sembrarPoliticasDeFlujo(f);
    await julioConMovimiento(f);

    // Borrador: nunca se posteó.
    await createJournalEntry(
      f.entityId,
      fechaEnPeriodo(7, 15),
      JournalEntryType.STANDARD,
      'Cobro que nunca se posteó',
      [
        { account_id: f.cuentas['1110'], debit_amount: '50000.0000', credit_amount: null, description: 'x' },
        { account_id: f.cuentas['4100'], debit_amount: null, credit_amount: '50000.0000', description: 'x' },
      ],
      f.userId
    );

    const e = await getCashFlowStatement(f.entityId, JULIO);
    const real = await movimientoRealDeEfectivo(f.entityId, JULIO);

    expect(real.variacion).toBe('4500.0000');
    expect(e.net_cash_flow).toBe('4500.0000');
    expect(residuo(e.net_cash_flow, real.variacion)).toBe('0.0000');
  });
});
