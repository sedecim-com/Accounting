import type pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction, currentTenant } from '../../database/connection.js';
import { createJournalEntry, attestEntryAsync } from '../accounting/posting.js';
import { getPolicy } from '../policy/policy-service.js';
import { ValidationError } from '../../utils/errors.js';
import type { FixedAsset } from '../../types/index.js';
import { DepreciationMethod, JournalEntryType } from '../../types/index.js';
import {
  BASES_DE_DEPRECIACION,
  CONVENCIONES_PRIMER_MES,
  TIPO_DE_CALENDARIO,
  baseDeLaVida,
  calculateDepreciation,
  effectiveInvestmentBase,
  esImporteCero,
  indiceDeCalendario,
  metadatosDeCalculo,
  type BaseDepreciacion,
  type ConvencionPrimerMes,
  type DepreciationInput,
  type InvestmentBase,
} from './depreciation-math.js';
import {
  periodoDeLaCorrida,
  type PeriodoDeCorrida,
} from '../accounting/periodo-de-corrida.js';

// ============================================================
// LA CORRIDA MENSUAL: DE LA ARITMÉTICA AL MAYOR (F06a)
//
// La aritmética vive en `depreciation-math.ts` y no toca Postgres a propósito
// (los defectos A y C se arreglan allí, con sus pruebas). Aquí queda lo que
// SÓLO se puede hacer contra la base: elegir la fila del calendario que
// corresponde al periodo que se corre, postear el asiento y dejar escrito con
// qué se calculó.
//
// LOS DOS DEFECTOS QUE SE REPARAN EN ESTE ARCHIVO:
//
//   B · el asiento se fechaba con `entry.period_start_date` —la fecha que
//       decía el calendario del activo— y no con el periodo que se está
//       corriendo. Combinado con el índice derivado (defecto A), correr
//       diciembre posteaba un asiento fechado en noviembre; y como
//       `createJournalEntry` deduce el periodo fiscal DE LA FECHA, la fila del
//       calendario decía un periodo y el mayor otro. Ver `fechaDelPeriodo`.
//   D · `journal_entry_id` y `calculation_metadata` (003:211-213) no se
//       escribían nunca: el motor insertaba la fila y creaba el asiento sin
//       atarlos. Desde la 056 eso ni siquiera es posible —el CHECK
//       `depreciacion_posteada_con_asiento` exige el asiento para
//       `is_posted`—, así que hoy el motor no podría ni postear.
//
// TODA LECTURA Y ESCRITURA ACOTADA POR ENTIDAD DENTRO DEL SQL. Van cuatro
// fugas cerradas en este proyecto por confiar en que el id venía de una
// consulta anterior; `depreciation_schedules` no tiene `entity_id`, así que el
// alcance entra por `fixed_assets` —en el JOIN de la lectura y en el SELECT
// del INSERT—, no por la foránea.
//
// POR QUÉ OCHO AYUDANTES DE ESTE ARCHIVO SE EXPORTAN. El plan que enseña
// `mnemosine depreciation run` antes de escribir nada (`depreciation-plan.ts`)
// tiene que decir EXACTAMENTE lo que esta corrida va a hacer. Si lo dedujera
// por su cuenta —su propio periodo, sus propios criterios, su propia elección
// de método— habría dos implementaciones del mismo acto, y el día que
// divergieran la que miente sería justo la que el operador leyó antes de decir
// que sí. Así que el plan entra por estas mismas puertas y no por copias.
// ============================================================

export {
  BASES_DE_DEPRECIACION,
  CONVENCIONES_PRIMER_MES,
  MACRS_TABLES,
  TIPO_DE_CALENDARIO,
  calculateDecliningBalance,
  calculateDepreciation,
  calculateMACRS,
  calculateStraightLine,
  calculateSumOfYearsDigits,
  calculateUnitsOfProduction,
  baseDeLaVida,
  diasDelMes,
  esImporteCero,
  fraccionDelPrimerMes,
  indiceDeCalendario,
  metadatosDeCalculo,
  primerDiaDelMes,
  ultimoDiaDelMes,
  type BaseDepreciacion,
  type ConvencionPrimerMes,
  type DepreciationInput,
  type DepreciationResult,
  type InvestmentBase,
} from './depreciation-math.js';

/**
 * DEFECTO B (mitad de la zona horaria) · MEDIANOCHE LOCAL, NUNCA UTC.
 *
 * `new Date('2026-12-01T00:00:00Z')` es medianoche UTC, que en México es el 30
 * de noviembre a las 18:00: el asiento se fecharía en el mes anterior —y
 * colgaría del periodo fiscal anterior— cuadrando igual de bien. Sin
 * `setTypeParser` en `src/database`, el driver devuelve una columna DATE ya
 * como `Date` a medianoche local, y reconstruirla por componentes locales la
 * deja igual; el rodeo por el string existe para el llamador que pase
 * 'YYYY-MM-DD'. Mismo criterio que journal-entry-service.ts:361 y
 * treasury-posting.ts:653.
 */
export function medianocheLocal(valor: Date | string): Date {
  if (typeof valor === 'string') return new Date(`${valor.slice(0, 10)}T00:00:00`);
  return new Date(valor.getFullYear(), valor.getMonth(), valor.getDate());
}

/**
 * EL PERIODO, ACOTADO POR ENTIDAD — AHORA DESDE UN SOLO SITIO.
 *
 * La consulta vivía aquí y `amortization-run.ts` la copió en D1a, dejando
 * escrito que si aparecía un TERCER motor periódico había que subirla a un
 * módulo común con el nombre del llamador como parámetro en vez de hacer una
 * tercera copia. El motor de provisiones de prestaciones (D1) es ese tercero,
 * así que la consulta subió a `accounting/periodo-de-corrida.ts` y aquí queda
 * la envoltura que pone «depreciación» en el mensaje: es lo único que
 * distinguía a las copias, y el mensaje lo lee un operador en mitad de un
 * cierre.
 *
 * Lo que la consulta defiende no cambia: con el id de un periodo de otra
 * entidad, la corrida habría fechado y numerado asientos de ésta contra el
 * calendario de aquélla. Que la corrida ya filtre los activos por entidad no
 * cubre esto —el periodo es el otro extremo del par—.
 */
export type { PeriodoDeCorrida };

export async function periodoDeLaEntidad(
  entityId: string,
  fiscalPeriodId: string
): Promise<PeriodoDeCorrida> {
  return periodoDeLaCorrida(entityId, fiscalPeriodId, 'depreciación');
}

/**
 * DEFECTO B · LA FECHA DEL ASIENTO ES LA DEL PERIODO QUE SE CORRE.
 *
 * El último día del periodo, no el primero: la depreciación es un devengo de
 * mes cerrado y se reconoce cuando el mes termina, que es lo que ya hace
 * `generateClosingEntries` con `period.end_date` (period-close.ts:329). Lo que
 * importa para el defecto es que la fecha caiga DENTRO del periodo corrido:
 * `createJournalEntry` busca el periodo fiscal por la fecha, así que una fecha
 * de noviembre en la corrida de diciembre no era sólo una etiqueta torcida,
 * era el asiento colgado de otro periodo que el de la fila del calendario.
 */
export function fechaDelAsiento(periodo: PeriodoDeCorrida): Date {
  return periodo.fin;
}

export interface CriteriosDeCorrida {
  base: BaseDepreciacion;
  baseDefinida: boolean;
  convencion: ConvencionPrimerMes;
  convencionDefinida: boolean;
}

function esBase(valor: string): valor is BaseDepreciacion {
  return (BASES_DE_DEPRECIACION as readonly string[]).includes(valor);
}

function esConvencion(valor: string): valor is ConvencionPrimerMes {
  return (CONVENCIONES_PRIMER_MES as readonly string[]).includes(valor);
}

/**
 * LAS DOS DECISIONES QUE ESTE CÓDIGO NO TOMA.
 *
 * Qué depreciación rige el gasto —la vida útil de la NIF C-6 o la tasa máxima
 * de la LISR— y si el mes de compra se carga entero o por días son criterio
 * del despacho, no del programa: las dos respuestas son defendibles y postean
 * importes distintos todos los meses. Se leen del panel una vez por corrida,
 * y lo que se leyó queda escrito en cada renglón.
 *
 * Un valor fuera del vocabulario DETIENE la corrida en vez de caer al defecto:
 * un `base_depreciacion` mal tecleado elegiría en silencio el otro método de
 * cálculo, y el silencio es lo que hace que un importe equivocado se descubra
 * un año después.
 */
export async function criteriosDeLaCorrida(tenantId: string, entityId: string): Promise<CriteriosDeCorrida> {
  const base = await getPolicy({ tenantId, entityId }, 'base_depreciacion');
  const convencion = await getPolicy({ tenantId, entityId }, 'convencion_primer_mes');

  if (!esBase(base.value)) {
    // The key spells out the two commands of changePolicyHint (policy-hint.ts).
    throw new ValidationError({
      key: 'error.VALIDATION_ERROR.depreciation.policy_base_unknown',
      params: { value: base.value, known: BASES_DE_DEPRECIACION.join(', ') },
    });
  }
  if (!esConvencion(convencion.value)) {
    throw new ValidationError({
      key: 'error.VALIDATION_ERROR.depreciation.policy_convention_unknown',
      params: { value: convencion.value, known: CONVENCIONES_PRIMER_MES.join(', ') },
    });
  }

  return {
    base: base.value,
    baseDefinida: base.defined,
    convencion: convencion.value,
    convencionDefinida: convencion.defined,
  };
}

/**
 * El método que rige según la base elegida.
 *
 * `book_depreciation_method` y `tax_depreciation_method` existen desde la 003
 * y NADIE las leía: el motor usaba `depreciation_method` para todo y clavaba
 * `schedule_type: 'book'`. Que existan dos columnas no es redundancia —en
 * México la depreciación contable sigue la vida útil (NIF C-6) y la fiscal las
 * tasas de los artículos 31-38 de la LISR—, y la 056 les puso vocabulario
 * justo para que el valor mal tecleado no eligiera un método en silencio.
 *
 * Si la columna de la base elegida viene vacía se cae a `depreciation_method`,
 * que es NOT NULL: es el activo que se dio de alta sin distinguir las dos
 * depreciaciones, y para él ambas bases son la misma.
 *
 * `tasa_lisr` also changes the SPEED: see `taxRateForBasis`.
 */
export function metodoDeLaBase(
  asset: Pick<FixedAsset, 'depreciation_method' | 'book_depreciation_method' | 'tax_depreciation_method'>,
  base: BaseDepreciacion
): DepreciationMethod {
  const elegido = base === 'tasa_lisr' ? asset.tax_depreciation_method : asset.book_depreciation_method;
  return elegido ?? asset.depreciation_method;
}

/**
 * The annual rate the schedule runs at, or undefined to run on the life.
 *
 * Only under `tasa_lisr`, and only for an asset that stores its rate (088).
 * An asset registered before 088 has none and keeps running on its useful
 * life, as it did: inventing it from the class now would change the speed of
 * an asset that may already have posted months.
 */
export function taxRateForBasis(asset: FixedAsset, base: BaseDepreciacion): string | undefined {
  return base === 'tasa_lisr' && asset.tax_rate ? asset.tax_rate : undefined;
}

/**
 * The base the tax schedule applies its rate to.
 *
 * Under `tasa_lisr` it is the original investment, with no salvage value
 * subtracted: LISR art. 31 applies the maximum percentages to the *monto
 * original de la inversión* (owner decision MNE-001-135, #429). Under
 * `vida_util_nif` it stays cost less salvage, NIF C-6's depreciable amount.
 * This is the base asked for: an asset that does not run on the rate (no
 * stored rate, or not straight line) still subtracts salvage, and
 * `effectiveInvestmentBase` decides that and is what the row records.
 *
 * An asset that already posted tax rows keeps the base it started with, for
 * the same reason as `basisLock`: moving the base under posted months would
 * post a schedule whose earlier rows were computed on another amount.
 */
export function investmentBaseFor(
  base: BaseDepreciacion,
  started: InvestmentBase | undefined
): InvestmentBase {
  if (base !== 'tasa_lisr') return 'cost_less_salvage';
  return started ?? 'original_investment';
}

/**
 * A ROW COUNTS WHILE THE LEDGER BACKS IT (MNE-001-646, #595).
 *
 * `is_posted` alone is not enough. Reversing a depreciation entry leaves its
 * row saying `is_posted = true` (056's CHECK still holds: the entry exists),
 * while the expense has left the result. With the row still counting, the
 * card kept the month, the close box called it done, and the run refused to
 * post it again: the month was lost. The reversal is the only correction the
 * ledger admits (041), so every reader here asks the ledger. Same rule as
 * `RENGLON_VIGENTE` (accruals/prepaid-service.ts).
 *
 * A voided entry is the same case: posted, it gets a mirror; a draft becomes
 * 'void'. `asset` is the alias of the row's fixed asset, which the caller
 * scopes by entity; the row's alias is `ds`.
 */
const backedBy = (asset: string): string => `EXISTS (
        SELECT 1 FROM journal_entries je_v
         WHERE je_v.id = ds.journal_entry_id
           AND je_v.entity_id = ${asset}.entity_id
           AND je_v.status = 'posted'
           AND je_v.reversed_by_entry_id IS NULL
      )`;
export const LIVE_ROW = `ds.is_posted = true AND ${backedBy('fa')}`;
/** A posted row whose entry was reversed or voided. Aliases `ds` and `fa`. */
export const DEAD_ROW = `ds.is_posted = true AND NOT ${backedBy('fa')}`;

/**
 * The asset card is the sum of its LIVE rows, never the theoretical schedule.
 *
 * Months need not run in order (onboarding mid-year, a forgotten month): run
 * March, January, February on 120,000 over twelve months and the theoretical
 * row of February would leave the card at 20,000 against 30,000 in the
 * ledger, for good. The sum of live rows is the sum of the entries by
 * construction, and the book value comes from the cost, so it also closes
 * with MACRS and with salvage. Called by the run and by the reversal of a
 * depreciation entry (`reversalFollowUps`, posting.ts), each on its own
 * transaction. Returns the rows updated: the caller refuses anything but 1.
 */
export async function refreshAssetCard(
  client: pg.PoolClient,
  entityId: string,
  assetId: string
): Promise<number> {
  const r = await client.query(
    `UPDATE fixed_assets fa SET
       accumulated_depreciation = p.acumulada,
       current_book_value = fa.acquisition_cost - p.acumulada,
       last_depreciation_date = p.ultima,
       updated_at = NOW()
     FROM (
       SELECT COALESCE(SUM(ds.depreciation_expense), 0) AS acumulada,
              MAX(ds.depreciation_date)                 AS ultima
         FROM depreciation_schedules ds
         JOIN fixed_assets f2 ON f2.id = ds.asset_id
        WHERE ds.asset_id = $1 AND ds.is_posted = true
          AND f2.entity_id = $2
          AND ${backedBy('f2')}
     ) p
     WHERE fa.id = $1 AND fa.entity_id = $2`,
    [assetId, entityId]
  );
  return r.rowCount ?? 0;
}

/**
 * The investment base each asset's EARLIEST live tax row was computed on.
 *
 * A row posted before MNE-001-396 does not record `investment_base`, and every
 * such row was computed on cost less salvage (MACRS ran on the cost, where the
 * two bases give the same schedule). Read once per run and once per plan.
 */
export async function taxBasesStarted(entityId: string): Promise<Map<string, InvestmentBase>> {
  const r = await query<{ asset_id: string; investment_base: string | null }>(
    `SELECT DISTINCT ON (ds.asset_id)
            ds.asset_id, ds.calculation_metadata->>'investment_base' AS investment_base
       FROM depreciation_schedules ds
       JOIN fixed_assets fa ON fa.id = ds.asset_id
      WHERE fa.entity_id = $1 AND ds.schedule_type = 'tax' AND ${LIVE_ROW}
      ORDER BY ds.asset_id, ds.depreciation_date, ds.created_at`,
    [entityId]
  );
  return new Map(
    r.rows.map((row) => [
      row.asset_id,
      row.investment_base === 'original_investment' ? 'original_investment' : 'cost_less_salvage',
    ])
  );
}

/**
 * The books each asset of the entity has LIVE posted rows under, any month.
 *
 * Read once per run (and once per plan, which must say what the run does).
 */
export async function postedBooks(entityId: string): Promise<Map<string, Set<string>>> {
  const r = await query<{ asset_id: string; schedule_type: string }>(
    `SELECT DISTINCT ds.asset_id, ds.schedule_type
       FROM depreciation_schedules ds
       JOIN fixed_assets fa ON fa.id = ds.asset_id
      WHERE fa.entity_id = $1 AND ${LIVE_ROW}`,
    [entityId]
  );
  const byAsset = new Map<string, Set<string>>();
  for (const row of r.rows) {
    byAsset.set(row.asset_id, (byAsset.get(row.asset_id) ?? new Set()).add(row.schedule_type));
  }
  return byAsset;
}

/**
 * THE LOCK: an asset that already posted rows under one basis does not switch.
 *
 * Not configurable (owner, #322). The run counts months from the in-service
 * date and the asset card sums posted rows with no cap, so posting the first
 * months on the book life and the next ones on the 35 % rate depreciates more
 * than 100 % of the cost. A prospective recalculation (NIF B-1) belongs to an
 * explicit command, not to a panel answer. Returns the reason, or null.
 */
export function basisLock(
  posted: ReadonlySet<string> | undefined,
  book: 'book' | 'tax'
): string | null {
  const other = [...(posted ?? [])].find((t) => t !== book);
  if (other === undefined) return null;
  return (
    `it already posted rows on the ${other} book, and \`base_depreciacion\` now says ${book}: ` +
    'the basis of an asset with posted rows cannot change, or it could depreciate more than its cost'
  );
}

export async function inquilinoDeLaEntidad(entityId: string): Promise<string> {
  const delContexto = currentTenant();
  if (delContexto) return delContexto;
  const r = await query<{ tenant_id: string }>(
    'SELECT tenant_id FROM legal_entities WHERE id = $1',
    [entityId]
  );
  const tenantId = r.rows[0]?.tenant_id;
  if (!tenantId) {
    throw new ValidationError({ key: 'error.VALIDATION_ERROR.depreciation.tenant_unknown', params: { entityId } });
  }
  return tenantId;
}

/**
 * MNE-001-881 · An asset the run leaves out ON PURPOSE, with its reason. It is
 * not an error: nothing is broken in the asset, the run cannot depreciate it.
 * Nothing is posted and no figure is computed for it; the month it owes is
 * counted by the close box, with the weight the panel gives it.
 */
export interface SkippedAsset {
  asset_number: string;
  asset_name: string;
  /** The same word the plan uses for this omission. */
  reason: 'unidades_de_produccion';
}

/** How many skipped assets a note names before it says «+N more». */
const NAMED_IN_NOTE = 5;

/**
 * What the close says about assets by units of production, in one place: the
 * `depreciate-assets` step and the `depreciation-posted` box print the same
 * sentence. It names the assets and what a person can do today.
 */
export function unitsOfProductionNote(
  assets: ReadonlyArray<Pick<SkippedAsset, 'asset_number' | 'asset_name'>>
): string {
  const named = assets.slice(0, NAMED_IN_NOTE).map((a) => `${a.asset_number} ${a.asset_name}`).join(', ');
  const more = assets.length > NAMED_IN_NOTE ? ` (+${assets.length - NAMED_IN_NOTE} more)` : '';
  return (
    `${assets.length} asset(s) skipped by units of production (unidades_de_produccion), nothing posted for them: ` +
    `${named}${more}. The period's production cannot be captured yet: book the month's charge by hand (entry create), or give the asset another method (asset edit --method)`
  );
}

/** The columns the card refresh writes: the only ones a posting run moves. */
const CARD_COLUMNS = new Set(['accumulated_depreciation', 'current_book_value', 'last_depreciation_date', 'updated_at']);

/**
 * MNE-001-880 · The asset without its card columns, to tell whether the row
 * a run computed from is still the row in the register. Every other column
 * counts, so one added later is compared without touching this.
 */
const asTheRunReadIt = (asset: FixedAsset): string =>
  JSON.stringify(Object.entries(asset).filter(([column]) => !CARD_COLUMNS.has(column)));

/** What the close box says of each state that takes an asset out of the run, in this order. */
const OUT_OF_USE: ReadonlyArray<readonly [status: string, said: string]> = [
  ['inactive', 'retired (inactive), not depreciated'],
  ['fully_depreciated', 'fully depreciated'],
  ['disposed', 'disposed'],
];

/**
 * MNE-001-880 · The assets of the register that are not in use, named by
 * state: they owe nothing, and an asset held out of depreciation is seen at
 * every close. Null when every asset is in use.
 */
export function assetsOutOfUseNote(
  assets: ReadonlyArray<{ asset_number: string; status: string }>
): string | null {
  const parts = OUT_OF_USE.flatMap(([status, said]) => {
    const numbers = assets.filter((a) => a.status === status).map((a) => a.asset_number);
    if (numbers.length === 0) return [];
    const more = numbers.length > NAMED_IN_NOTE ? ` (+${numbers.length - NAMED_IN_NOTE} more)` : '';
    return [`${numbers.length} asset(s) ${said}: ${numbers.slice(0, NAMED_IN_NOTE).join(', ')}${more}`];
  });
  return parts.length > 0 ? parts.join('; ') : null;
}

/**
 * La corrida mensual: un renglón de calendario y un asiento por activo activo.
 *
 * Devuelve lo procesado y los errores por activo en vez de abortar entera: un
 * activo con datos incompletos no debe impedir que los otros veinte se
 * deprecien, y el mes que le falta se ve en la casilla del cierre.
 */
export async function runMonthlyDepreciation(
  entityId: string,
  fiscalPeriodId: string,
  userId: string
): Promise<{ processed: number; errors: string[]; skipped: SkippedAsset[] }> {
  let processed = 0;
  const errors: string[] = [];
  const skipped: SkippedAsset[] = [];

  const periodo = await periodoDeLaEntidad(entityId, fiscalPeriodId);
  const tenantId = await inquilinoDeLaEntidad(entityId);
  const criterios = await criteriosDeLaCorrida(tenantId, entityId);
  const tipoDeCalendario = TIPO_DE_CALENDARIO[criterios.base];
  const posted = await postedBooks(entityId);
  const startedBases = await taxBasesStarted(entityId);

  const assets = await query<FixedAsset>(
    `SELECT * FROM fixed_assets WHERE entity_id = $1 AND status = 'active'`,
    [entityId]
  );

  for (const asset of assets.rows) {
    try {
      // YA CORRIDO, Y LA PREGUNTA NO ES POR LIBRO SINO POR MAYOR.
      //
      // La UNIQUE del esquema es (asset_id, fiscal_period_id, schedule_type),
      // así que el libro contable y el fiscal del mismo mes son dos filas
      // legítimas EN LA TABLA. Pero el gasto que llega al mayor es UNO: la
      // corrida carga `depreciation_expense_account_id` sin mirar de qué libro
      // salió el número. Preguntar sólo por el tipo dejaba abierta la puerta
      // más fácil de empujar que tiene este módulo: correr marzo con la base
      // contable, contestar `base_depreciacion` con `tasa_lisr` —que es
      // exactamente lo que el mensaje de error de `criteriosDeLaCorrida`
      // invita a hacer— y volver a correr marzo. El tipo pasaba de 'book' a
      // 'tax', la fila no existía, y el mes se cargaba DOS VECES. Con el mayor
      // inmutable (041) eso no se edita: son N reversas.
      //
      // Por eso el freno tiene dos mitades. `is_posted` de CUALQUIER libro
      // cierra el mayor —el gasto de este mes ya está reconocido—; el tipo
      // igual cierra la UNIQUE, para que un renglón proyectado no reviente el
      // INSERT con un mensaje de Postgres en vez de un motivo. El JOIN contra
      // fixed_assets es lo que acota por entidad: esta tabla no tiene
      // entity_id propio.
      //
      // MNE-001-646 · ONLY A ROW THAT STANDS STOPS THE RUN: a live one, or a
      // projected one of this book. A posted row whose entry was reversed is
      // a month the ledger no longer has, and it is owed again.
      const existente = await query<{ id: string; stands: boolean }>(
        `SELECT ds.id, NOT (${DEAD_ROW}) AS stands
           FROM depreciation_schedules ds
           JOIN fixed_assets fa ON fa.id = ds.asset_id
          WHERE ds.asset_id = $1 AND ds.fiscal_period_id = $2
            AND fa.entity_id = $4
            AND (ds.is_posted = true OR ds.schedule_type = $3)`,
        [asset.id, periodo.id, tipoDeCalendario, entityId]
      );
      if (existente.rows.some((r) => r.stands)) continue;
      const hasDeadRow = existente.rows.length > 0;

      const lock = basisLock(posted.get(asset.id), tipoDeCalendario);
      if (lock !== null) {
        errors.push(`Activo ${asset.asset_number}: ${lock}.`);
        continue;
      }

      const metodo = metodoDeLaBase(asset, criterios.base);
      if (metodo === DepreciationMethod.UNITS_OF_PRODUCTION) {
        // MNE-001-881 · SKIPPED, NOT AN ERROR. Nothing captures the period's
        // production, so the run cannot compute this row; reporting it as an
        // error made the step `failed` and ended `closing run` every month.
        skipped.push({
          asset_number: asset.asset_number,
          asset_name: asset.asset_name,
          reason: 'unidades_de_produccion',
        });
        continue;
      }

      const inicioServicio = medianocheLocal(asset.depreciation_start_date);
      const entrada: DepreciationInput = {
        asset_id: asset.id,
        // DINERO COMO STRING: era `parseFloat` sobre DECIMAL(19,4), que tira
        // por el camino justo lo que la columna guarda con cuatro decimales.
        acquisition_cost: asset.acquisition_cost,
        salvage_value: asset.salvage_value,
        useful_life_months: asset.useful_life_months,
        depreciation_start_date: inicioServicio,
        method: metodo,
        macrs_class: asset.macrs_class ?? undefined,
        convencion: criterios.convencion,
        annual_rate: taxRateForBasis(asset, criterios.base),
        investment_base: investmentBaseFor(criterios.base, startedBases.get(asset.id)),
      };
      const calendario = calculateDepreciation(entrada);

      // DEFECTO A, visto desde el llamador: el índice es la diferencia de
      // MESES DE CALENDARIO entre el periodo que se corre y el mes de entrada
      // en servicio. Negativo = el activo aún no estaba en servicio; fuera del
      // arreglo = su vida ya terminó. Antes ninguna de las dos cosas se
      // distinguía porque el índice derivaba.
      const indice = indiceDeCalendario(inicioServicio, periodo.inicio);
      if (indice < 0) continue;
      const fila = calendario[indice];
      if (!fila) continue;

      // Un renglón de cero no se postea: un asiento de importe nulo no dice
      // nada y ensucia el mayor. Ocurre en la cola de un activo ya agotado.
      if (esImporteCero(fila.depreciation_expense)) continue;

      const metadatos = metadatosDeCalculo({
        metodo,
        base: criterios.base,
        convencion: criterios.convencion,
        indice,
        periodos: calendario.length,
        vidaUtilMeses: asset.useful_life_months,
        baseDepreciable: baseDeLaVida(entrada),
        investmentBase: effectiveInvestmentBase(entrada),
        baseDefinida: criterios.baseDefinida,
        convencionDefinida: criterios.convencionDefinida,
      });

      const entryId = await withTransaction(async (client) => {
        // El asiento PRIMERO, y la fila después con su id: es el orden que
        // impone el CHECK `depreciacion_posteada_con_asiento` de la 056, y es
        // el correcto —una fila que dice estar posteada sin poder decir dónde
        // es indistinguible de una marcada a mano—.
        const je = await createJournalEntry(
          entityId,
          fechaDelAsiento(periodo),
          JournalEntryType.AUTO_DEPRECIATION,
          `Monthly depreciation ${periodo.nombre} - ${asset.asset_name}`,
          [
            {
              account_id: asset.depreciation_expense_account_id,
              debit_amount: fila.depreciation_expense,
              credit_amount: null,
              description: `Depreciation - ${asset.asset_name}`,
            },
            {
              account_id: asset.accumulated_depreciation_account_id,
              debit_amount: null,
              credit_amount: fila.depreciation_expense,
              description: `Accumulated Depreciation - ${asset.asset_name}`,
            },
          ],
          userId,
          // Mismo client: la fila del calendario, el asiento y el activo
          // confirman (o abortan) juntos y no en conexiones distintas.
          { sourceType: 'depreciation', sourceId: asset.id, autoPost: true, client }
        );

        // MNE-001-880 · THE ASSET IS LOCKED, AND IT IS STILL THE ONE THIS RUN
        // COMPUTED FROM. `asset edit` holds this same lock while it checks
        // that no live row exists: without it, an edit committed between the
        // read above and this write would leave a month posted from the old
        // figures. After the entry, so the order of locks stays the one a
        // reversal takes (the entry number first, the asset after).
        const current = await client.query<FixedAsset>(
          'SELECT * FROM fixed_assets WHERE id = $1 AND entity_id = $2 FOR UPDATE',
          [asset.id, entityId]
        );
        if (current.rows.length !== 1 || asTheRunReadIt(current.rows[0]) !== asTheRunReadIt(asset)) {
          throw new ValidationError(
            'it changed in the register while this run was posting: nothing was posted for it. Run the month again.'
          );
        }

        // MNE-001-646 · THE DEAD ROW GOES BEFORE THE NEW ONE IS WRITTEN, of
        // either book: UNIQUE(asset, period, book) says a month is one row,
        // and the one there documents a charge the ledger reversed. Nothing
        // is lost: the entry, its mirror and their link stay in the ledger
        // (041). The scope and the dead predicate are INSIDE the statement,
        // so a live row is never touched; zero rows means another run already
        // replaced it, and this one must not post the month a second time.
        if (hasDeadRow) {
          const removed = await client.query(
            `DELETE FROM depreciation_schedules ds
              USING fixed_assets fa
              WHERE ds.asset_id = $1 AND ds.fiscal_period_id = $2
                AND fa.id = ds.asset_id AND fa.entity_id = $3
                AND ${DEAD_ROW}`,
            [asset.id, periodo.id, entityId]
          );
          if ((removed.rowCount ?? 0) < 1) {
            throw new ValidationError(
              `its reversed row of ${periodo.nombre} was replaced by another run meanwhile: nothing was posted`
            );
          }
        }

        // DEFECTO D · el asiento y los metadatos, atados a la fila. Y el
        // alcance por entidad DENTRO del SQL: el asset_id no entra crudo al
        // INSERT «porque la foránea ya lo validaba» —esa frase es la de la
        // cuarta fuga—, sino que la fila sólo nace si el activo es de esta
        // entidad.
        const insercion = await client.query(
          `INSERT INTO depreciation_schedules (
             id, asset_id, fiscal_period_id, depreciation_date,
             depreciation_expense, accumulated_depreciation, book_value,
             schedule_type, is_posted, journal_entry_id, calculation_metadata
           )
           SELECT $1, fa.id, $3, $4::date, $5, $6, $7, $8, true, $9, $10::jsonb
             FROM fixed_assets fa
            WHERE fa.id = $2 AND fa.entity_id = $11`,
          [
            uuidv4(),
            asset.id,
            periodo.id,
            fechaDelAsiento(periodo),
            fila.depreciation_expense,
            fila.accumulated_depreciation,
            fila.ending_book_value,
            tipoDeCalendario,
            je.id,
            JSON.stringify(metadatos),
            entityId,
          ]
        );
        if (insercion.rowCount !== 1) {
          throw new ValidationError(
            `El activo ${asset.asset_number} no es de esta entidad: no se escribió su renglón.`
          );
        }

        // The card follows the live rows (see `refreshAssetCard`), in this
        // same transaction and scoped by entity inside its SQL.
        if ((await refreshAssetCard(client, entityId, asset.id)) !== 1) {
          throw new ValidationError(
            `El activo ${asset.asset_number} no es de esta entidad: no se actualizó su valor en libros.`
          );
        }

        return je.id;
      });

      // Client del llamador significa atestiguación del llamador, DESPUÉS del
      // commit: la cadena tiene que ver datos confirmados.
      attestEntryAsync(tenantId, entityId, entryId);

      processed++;
    } catch (err) {
      errors.push(`Activo ${asset.asset_number}: ${(err as Error).message}`);
    }
  }

  return { processed, errors, skipped };
}
