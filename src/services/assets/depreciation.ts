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
  esImporteCero,
  indiceDeCalendario,
  metadatosDeCalculo,
  type BaseDepreciacion,
  type ConvencionPrimerMes,
  type DepreciationInput,
} from './depreciation-math.js';

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

export interface PeriodoDeCorrida {
  id: string;
  inicio: Date;
  fin: Date;
  nombre: string;
}

/**
 * El periodo que se está corriendo, ACOTADO POR ENTIDAD.
 *
 * La consulta anterior era `WHERE id = $1` a secas: con el id de un periodo de
 * otra entidad, la corrida habría fechado y numerado asientos de esta contra
 * el calendario de aquella. Que la corrida ya filtre los activos por entidad
 * no cubre esto —el periodo es el otro extremo del par—.
 */
export async function periodoDeLaEntidad(entityId: string, fiscalPeriodId: string): Promise<PeriodoDeCorrida> {
  const r = await query<{ id: string; start_date: Date; end_date: Date; period_name: string }>(
    `SELECT id, start_date, end_date, period_name
       FROM fiscal_periods
      WHERE id = $1 AND entity_id = $2`,
    [fiscalPeriodId, entityId]
  );
  const fila = r.rows[0];
  if (!fila) {
    throw new ValidationError(
      `El periodo fiscal ${fiscalPeriodId} no existe o no es de esta entidad. La corrida de ` +
        'depreciación no cruza entidades.'
    );
  }
  return {
    id: fila.id,
    inicio: medianocheLocal(fila.start_date),
    fin: medianocheLocal(fila.end_date),
    nombre: fila.period_name,
  };
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
    throw new ValidationError(
      `La política \`base_depreciacion\` vale "${base.value}", que no es ninguna de las dos ` +
        `bases posibles (${BASES_DE_DEPRECIACION.join(', ')}). Corrígela con ` +
        '`mnemosine pending resolve base_depreciacion` antes de correr la depreciación.'
    );
  }
  if (!esConvencion(convencion.value)) {
    throw new ValidationError(
      `La política \`convencion_primer_mes\` vale "${convencion.value}", que no es ninguna de ` +
        `las dos convenciones posibles (${CONVENCIONES_PRIMER_MES.join(', ')}). Corrígela con ` +
        '`mnemosine pending resolve convencion_primer_mes` antes de correr la depreciación.'
    );
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
 * LO QUE ESTA BASE TODAVÍA NO SABE. `tasa_lisr` cambia el MÉTODO y el
 * `schedule_type`, no la vida: la tasa máxima del artículo 34 —10 % edificios,
 * 30 % equipo de cómputo— no tiene columna en `fixed_assets`, así que el
 * calendario fiscal se reparte sobre `useful_life_months` igual que el
 * contable. Mientras no exista esa columna, elegir la base fiscal separa las
 * dos corridas y las etiqueta bien, pero no las hace divergir por sí sola.
 */
export function metodoDeLaBase(asset: FixedAsset, base: BaseDepreciacion): DepreciationMethod {
  const elegido = base === 'tasa_lisr' ? asset.tax_depreciation_method : asset.book_depreciation_method;
  return elegido ?? asset.depreciation_method;
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
    throw new ValidationError(`No se pudo determinar el inquilino de la entidad ${entityId}.`);
  }
  return tenantId;
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
): Promise<{ processed: number; errors: string[] }> {
  let processed = 0;
  const errors: string[] = [];

  const periodo = await periodoDeLaEntidad(entityId, fiscalPeriodId);
  const tenantId = await inquilinoDeLaEntidad(entityId);
  const criterios = await criteriosDeLaCorrida(tenantId, entityId);
  const tipoDeCalendario = TIPO_DE_CALENDARIO[criterios.base];

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
      const existente = await query<{ id: string }>(
        `SELECT ds.id
           FROM depreciation_schedules ds
           JOIN fixed_assets fa ON fa.id = ds.asset_id
          WHERE ds.asset_id = $1 AND ds.fiscal_period_id = $2
            AND fa.entity_id = $4
            AND (ds.is_posted = true OR ds.schedule_type = $3)`,
        [asset.id, periodo.id, tipoDeCalendario, entityId]
      );
      if (existente.rows.length > 0) continue;

      const metodo = metodoDeLaBase(asset, criterios.base);
      if (metodo === DepreciationMethod.UNITS_OF_PRODUCTION) {
        errors.push(
          `Activo ${asset.asset_number}: se deprecia por unidades de producción y la corrida ` +
            'mensual no tiene de dónde leer la producción del periodo. Su renglón se captura aparte.'
        );
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

        // LA FICHA DEL ACTIVO SE DERIVA DE LO POSTEADO, NO DEL CALENDARIO.
        //
        // Antes se copiaban aquí `fila.accumulated_depreciation` y
        // `fila.ending_book_value`, que son los del RENGLÓN TEÓRICO: lo que el
        // calendario dice que llevarías acumulado si hubieras corrido todos los
        // meses anteriores. Nada obliga a correrlos en orden —se onboardea a
        // mitad de año, o sencillamente se olvida un mes—, y entonces la ficha
        // afirmaba una acumulada que el mayor no respalda.
        //
        // Corrido marzo, luego enero, luego febrero sobre un activo de 120.000
        // a doce meses: los tres asientos suman 30.000 en el mayor y la ficha
        // se quedaba diciendo 20.000 y 100.000 de valor en libros, porque el
        // último UPDATE en ganar era el del renglón de FEBRERO. La diferencia
        // no se cerraba nunca —cada mes siguiente vuelve a copiar su propio
        // renglón— y `last_depreciation_date` hasta retrocedía.
        //
        // La suma de los renglones POSTEADOS es, por construcción, la misma
        // que la de los asientos: la 056 exige `journal_entry_id` para
        // `is_posted`, así que no hay renglón posteado sin asiento detrás. El
        // valor en libros sale del costo y no de una resta arrastrada, que es
        // lo que hace que cierre exacto también con MACRS —cuya base es el
        // costo entero— y con salvamento. Acotado por entidad en el mismo SQL.
        const actualizacion = await client.query(
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
           ) p
           WHERE fa.id = $1 AND fa.entity_id = $2`,
          [asset.id, entityId]
        );
        if (actualizacion.rowCount !== 1) {
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

  return { processed, errors };
}
