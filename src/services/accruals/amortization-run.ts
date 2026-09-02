import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, withTransaction } from '../../database/connection.js';
import { createJournalEntry, attestEntryAsync } from '../accounting/posting.js';
import { getPolicy } from '../policy/policy-service.js';
import { ValidationError } from '../../utils/errors.js';
import { JournalEntryType } from '../../types/index.js';
import { indiceDeCalendario, primerDiaDelMes } from '../assets/depreciation-math.js';
import {
  calcularAmortizacion,
  esConvencionDeAmortizacion,
  esImporteCero,
  metadatosDeAmortizacion,
  type ConvencionAmortizacion,
} from './amortization-math.js';
import {
  RENGLON_VIGENTE,
  anticiposPorDevengar,
  devengadoEnElMayor,
  inquilinoDeLaEntidad,
  medianocheLocal,
  refrescarFichasDeAnticipos,
  type PrepaidExpenseRow,
} from './prepaid-service.js';

// ============================================================
// LA CORRIDA MENSUAL DEL DEVENGO: DE LA ARITMÉTICA AL MAYOR (D1a)
//
// La aritmética vive en `amortization-math.ts` y no toca Postgres a propósito.
// Aquí queda lo que SÓLO se puede hacer contra la base: elegir el renglón del
// calendario que corresponde al periodo que se corre, postear el asiento y
// dejar escrito con qué se calculó.
//
// ESTE ARCHIVO NO INVENTA NADA: copia el único motor periódico que el
// repositorio tiene funcionando —`services/assets/depreciation.ts`, de F06a— y
// las cuatro cosas que aquél ya resolvió a base de defectos medidos:
//
//   · IDEMPOTENCIA POR ENTIDAD-PERIODO. Un mes corrido dos veces no carga el
//     gasto dos veces. Aquí es más simple que allá y conviene decir por qué:
//     la UNIQUE de la depreciación incluye `schedule_type`, así que el libro
//     contable y el fiscal del mismo mes son dos filas legítimas, y cambiar la
//     política `base_depreciacion` entre dos corridas del mismo mes cargaba el
//     gasto DOS VECES (depreciation.ts:253-273 cuenta el ataque). Un anticipo
//     no tiene dos libros: el devengo es uno y un mes es un renglón, así que
//     la UNIQUE (anticipo, periodo) basta y el freno es una sola pregunta.
//
//   · LA FECHA DEL ASIENTO ES LA DEL PERIODO QUE SE CORRE, no la del
//     calendario del anticipo. `createJournalEntry` deduce el periodo fiscal
//     DE LA FECHA: una fecha de noviembre en la corrida de diciembre no era
//     una etiqueta torcida, era el asiento colgado de otro periodo que el de
//     su propio renglón (defecto B de F06a).
//
//   · LA CÉDULA ATADA A SU ASIENTO. El asiento PRIMERO y la fila después con
//     su id, que es el orden que impone el CHECK `amortizacion_posteada_con_
//     asiento` de la 059 — y es el correcto: una fila que dice estar posteada
//     sin poder decir dónde es indistinguible de una marcada a mano.
//
//   · LA TARJETA SE ARMA DE LA SUMA POSTEADA, NO DEL CALENDARIO. Nada obliga a
//     correr los meses en orden —se onboardea a mitad de año, o sencillamente
//     se olvida un mes—, y copiar el renglón teórico dejaba la ficha del
//     activo afirmando una acumulada que el mayor no respaldaba, con la
//     diferencia sin cerrarse nunca (depreciation.ts:344-360).
//
// TODA LECTURA Y ESCRITURA ACOTADA POR ENTIDAD DENTRO DEL SQL. A diferencia de
// `depreciation_schedules`, esta tabla tiene `entity_id` propio y foráneas
// compuestas, así que el alcance no depende de que la consulta se acuerde de
// un JOIN — pero se escribe igual en cada consulta, porque el esquema es la
// segunda línea y no la primera.
// ============================================================

export interface PeriodoDeCorrida {
  id: string;
  inicio: Date;
  fin: Date;
  nombre: string;
}

/**
 * El periodo que se está corriendo, ACOTADO POR ENTIDAD.
 *
 * Con el id de un periodo de otra entidad, la corrida fecharía y numeraría
 * asientos de ésta contra el calendario de aquélla. Que la corrida ya filtre
 * los anticipos por entidad no cubre esto: el periodo es el otro extremo del
 * par.
 *
 * ESTO ES CASI GEMELO DE `periodoDeLaEntidad` (depreciation.ts:103-125) y no
 * se importa por una sola razón: aquel mensaje de error dice «La corrida de
 * depreciación no cruza entidades», y un operador que corre el devengo no
 * puede leer que le habla la depreciación. La sustancia es idéntica y no puede
 * divergir —una consulta de dos columnas contra una tabla—; si aparece un
 * tercer motor periódico, lo que toca es subir este ayudante a un módulo común
 * con el nombre del llamador como parámetro, no una tercera copia.
 */
export async function periodoDeLaCorrida(
  entityId: string,
  fiscalPeriodId: string
): Promise<PeriodoDeCorrida> {
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
        'amortización de pagos anticipados no cruza entidades.'
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
 * El último día del periodo, no el primero: el devengo es de mes cerrado y se
 * reconoce cuando el mes termina, que es lo que ya hace `generateClosingEntries`
 * con `period.end_date` (period-close.ts:329) y lo que hace la depreciación.
 */
export function fechaDelAsiento(periodo: PeriodoDeCorrida): Date {
  return periodo.fin;
}

export interface ResultadoDeCorrida {
  processed: number;
  /** Importe total devengado en esta corrida. String, como todo el dinero. */
  total: string;
  /** Anticipos que no tocaba correr: aún no arrancan, ya terminaron, o ya se corrió el mes. */
  skipped: number;
  errors: string[];
}

/**
 * LA CORRIDA MENSUAL: un renglón de calendario y un asiento por anticipo vivo.
 *
 * Devuelve lo procesado y los errores por anticipo en vez de abortar entera: un
 * anticipo con datos incompletos no debe impedir que los otros veinte se
 * devenguen, y el mes que le falta se ve en la casilla del cierre
 * (`revisionDeAmortizacionAlCierre`).
 */
export async function runMonthlyAmortization(
  entityId: string,
  fiscalPeriodId: string,
  userId: string
): Promise<ResultadoDeCorrida> {
  let processed = 0;
  let skipped = 0;
  let total = new Decimal(0);
  const errors: string[] = [];

  const periodo = await periodoDeLaCorrida(entityId, fiscalPeriodId);
  const tenantId = await inquilinoDeLaEntidad(entityId);

  // LA POLÍTICA SE LEE PARA COMPARAR, NO PARA APLICAR.
  //
  // Cada anticipo lleva CONGELADA la convención con la que nació, y la corrida
  // la respeta: recortar de otra manera un calendario cuyos primeros meses ya
  // están posteados dejaría el total sin cuadrar, y el mayor es inmutable
  // (041) — no se edita hacia atrás. Pero que el panel diga hoy otra cosa es un
  // hecho que el auditor necesita, así que se lee y se anota en cada renglón.
  // El día que alguien pregunte «¿por qué este seguro devenga por días si
  // nuestra política son meses completos?», la respuesta está en la fila.
  const delPanel = await getPolicy({ tenantId, entityId }, 'amortizacion_anticipados_convencion');
  const convencionDelPanel: ConvencionAmortizacion = esConvencionDeAmortizacion(delPanel.value)
    ? delPanel.value
    : 'proporcional_dias';

  // La ficha es una caché de una suma sobre el mayor, y el mayor cambia
  // también por fuera de este módulo: una reversa la deja atrasada. La corrida
  // es el momento en que el devengo vuelve a tener la palabra, así que
  // reconcilia antes de mirar nada. Sin escrituras cuando no hay nada que
  // corregir.
  await refrescarFichasDeAnticipos(entityId);

  const anticipos = await anticiposPorDevengar(entityId);

  for (const anticipo of anticipos) {
    try {
      const devengado = await devengarUnAnticipo({
        anticipo,
        periodo,
        entityId,
        tenantId,
        userId,
        convencionDelPanel,
        convencionDefinida: delPanel.defined,
      });
      if (devengado === null) {
        skipped++;
        continue;
      }
      total = total.plus(devengado);
      processed++;
    } catch (err) {
      errors.push(`Anticipo ${anticipo.description}: ${(err as Error).message}`);
    }
  }

  return { processed, total: total.toFixed(4), skipped, errors };
}

/**
 * Un anticipo, un mes. Devuelve el importe devengado, o `null` si no tocaba.
 *
 * Separado de la corrida porque el cuerpo tiene cinco motivos distintos para
 * no hacer nada, y un `continue` dentro de un bucle de setenta líneas los
 * vuelve invisibles.
 */
async function devengarUnAnticipo(a: {
  anticipo: PrepaidExpenseRow;
  periodo: PeriodoDeCorrida;
  entityId: string;
  tenantId: string;
  userId: string;
  convencionDelPanel: ConvencionAmortizacion;
  convencionDefinida: boolean;
}): Promise<string | null> {
  const { anticipo, periodo, entityId, userId } = a;

  // 1 · EL FRENO DE DOBLE CORRIDA. Una sola pregunta, porque un mes es un
  //     renglón (ver la cabecera). Acotada por entidad aunque la UNIQUE ya lo
  //     impediría: la consulta no delega su alcance en el esquema.
  //
  //     PERO EL FRENO SÓLO CUENTA RENGLONES VIGENTES. Con la pregunta a secas,
  //     revertir el asiento de un mes lo dejaba bloqueado para siempre: el
  //     renglón seguía ahí, el freno seguía mordiendo, y el gasto que la
  //     reversa sacó del resultado no volvía nunca. Una reversa es una
  //     corrección —la única que el mayor admite (041)—, no una condena.
  const existente = await query<{ id: string }>(
    `SELECT s.id FROM prepaid_amortization_schedules s
      WHERE s.prepaid_expense_id = $1 AND s.fiscal_period_id = $2 AND s.entity_id = $3
        AND ${RENGLON_VIGENTE}`,
    [anticipo.id, periodo.id, entityId]
  );
  if (existente.rows.length > 0) return null;

  // La convención llega de un VARCHAR, y un valor fuera del vocabulario DETIENE
  // este anticipo en vez de caer al defecto: elegir en silencio el otro recorte
  // del calendario es lo que hace que un importe equivocado se descubra un año
  // después. El CHECK de la 059 lo impide por la puerta de delante; esto cubre
  // la fila escrita por SQL a mano antes de que existiera el CHECK.
  if (!esConvencionDeAmortizacion(anticipo.amortization_convention)) {
    throw new ValidationError(
      `su convención guardada vale "${anticipo.amortization_convention}", que no es ninguna de ` +
        'las declaradas. Ningún importe se puede calcular con ella.'
    );
  }
  const convencion: ConvencionAmortizacion = anticipo.amortization_convention;

  const inicio = medianocheLocal(anticipo.coverage_start_date);
  const fin = medianocheLocal(anticipo.coverage_end_date);
  const calendario = calcularAmortizacion({
    importe: anticipo.total_amount,
    inicio,
    fin,
    convencion,
  });

  // 2 · EL ÍNDICE ES UNA DIFERENCIA DE MESES DE CALENDARIO, no una división de
  //     milisegundos entre la longitud media de un mes: ése fue el defecto A
  //     de F06a, donde marzo repetía la fila de febrero y desde abril el
  //     índice quedaba atrasado para siempre. Negativo = la cobertura aún no
  //     empieza; fuera del arreglo = ya terminó.
  const indice = indiceDeCalendario(primerDiaDelMes(inicio), periodo.inicio);
  if (indice < 0) return null;
  const fila = calendario[indice];
  if (!fila) return null;
  if (esImporteCero(fila.amortization_amount)) return null;

  // 3 · EL TOPE CONTRA LO QUE QUEDA POSTEADO. El renglón del calendario es
  //     TEÓRICO: dice lo que tocaría este mes si todos los demás se hubieran
  //     corrido. Si por lo que sea ya se devengó de más —un mes corrido dos
  //     veces bajo otra convención, una cabecera adoptada dos veces—, abonar
  //     el renglón entero dejaría la 1160 en negativo: un activo con saldo
  //     acreedor, con el balance cuadrando. Se topa, y el tope queda escrito
  //     en la fila en vez de pasar en silencio.
  //
  //     Y LO QUE QUEDA SE LE PREGUNTA AL MAYOR, no a `remaining_amount`. Esa
  //     columna se deriva de `amortized_to_date`, que sólo se reescribe cuando
  //     la corrida toca este anticipo: tras una reversa dice de menos, y con
  //     ella el tope recortaría el importe repuesto —o, si la reversa fue del
  //     último mes, daría cero y cerraría un anticipo que el mayor todavía
  //     debe.
  const devengado = new Decimal(await devengadoEnElMayor(anticipo.id, entityId));
  const restante = new Decimal(anticipo.total_amount).minus(devengado);
  if (restante.lessThanOrEqualTo(0)) {
    await marcarAgotado(anticipo.id, entityId);
    return null;
  }
  const teorico = new Decimal(fila.amortization_amount);
  const monto = teorico.greaterThan(restante) ? restante : teorico;

  const metadatos = metadatosDeAmortizacion({
    convencion,
    convencionDelPanel: a.convencionDelPanel,
    convencionDefinida: a.convencionDefinida,
    indice,
    periodos: calendario.length,
    diasCubiertos: fila.days_covered,
    importeTotal: anticipo.total_amount,
    cobertura: { inicio, fin },
    topadoPorSaldo: monto.equals(teorico) ? undefined : teorico.toFixed(4),
  });

  const importe = monto.toFixed(4);
  const acumulada = devengado.plus(monto);

  const entryId = await withTransaction(async (client) => {
    // El asiento PRIMERO y la fila después con su id: lo exige el CHECK
    // `amortizacion_posteada_con_asiento` de la 059.
    //
    // ES UN ASIENTO DE AJUSTE ('adjusting') y no un tipo propio. El vocabulario
    // de `entry_type` lo fija un CHECK de la 001 y el enum de `types/index.ts`,
    // que son de otro frente; y contablemente un devengo de fin de mes ES un
    // ajuste — no hay que inventar un tipo para decir la verdad. Quien busque
    // estos asientos los encuentra por `source_type = 'prepaid_amortization'`,
    // que es más específico que cualquier tipo que se pudiera añadir.
    const je = await createJournalEntry(
      entityId,
      fechaDelAsiento(periodo),
      JournalEntryType.ADJUSTING,
      `Prepaid amortization ${periodo.nombre} - ${anticipo.description}`,
      [
        {
          account_id: anticipo.expense_account_id,
          debit_amount: importe,
          credit_amount: null,
          description: `Accrued expense - ${anticipo.description}`,
        },
        {
          account_id: anticipo.prepaid_account_id,
          debit_amount: null,
          credit_amount: importe,
          description: `Prepaid expenses - ${anticipo.description}`,
        },
      ],
      userId,
      // Mismo client: la fila del calendario, el asiento y la cabecera
      // confirman (o abortan) juntos y no en conexiones distintas.
      { sourceType: 'prepaid_amortization', sourceId: anticipo.id, autoPost: true, client }
    );

    // EL RENGLÓN ANULADO SE RETIRA ANTES DE ESCRIBIR EL NUEVO.
    //
    // La UNIQUE (anticipo, periodo) dice —bien— que un mes es UN renglón. Tras
    // una reversa, el que hay documenta un devengo que ya no existe, y sin
    // quitarlo la reposición chocaría contra la propia UNIQUE. No se pierde
    // nada al borrarlo: la historia completa está en el mayor, que sí es
    // inmutable (041) —el asiento original, su espejo, y el vínculo
    // `reverses_entry_id` entre los dos, los tres con
    // `source_type = 'prepaid_amortization'`—. Lo que se borra es la copia de
    // trabajo, no el hecho.
    //
    // La condición del espejo va DENTRO del DELETE: un renglón vigente no se
    // toca aquí ni por una carrera entre dos corridas del mismo mes. Si lo
    // hubiera, no se borra nada, la UNIQUE rechaza el INSERT y la transacción
    // entera se deshace, que es la respuesta correcta.
    await client.query(
      `DELETE FROM prepaid_amortization_schedules s
        USING journal_entries je
        WHERE s.prepaid_expense_id = $1
          AND s.fiscal_period_id = $2
          AND s.entity_id = $3
          AND je.id = s.journal_entry_id
          AND (je.reversed_by_entry_id IS NOT NULL OR je.status <> 'posted')`,
      [anticipo.id, periodo.id, entityId]
    );

    // EL ALCANCE POR ENTIDAD DENTRO DEL SQL: el id del anticipo no entra crudo
    // al INSERT «porque la foránea ya lo validaba» —esa frase es la de la
    // cuarta fuga—, sino que la fila sólo nace si el anticipo es de esta
    // entidad y no está cancelado.
    const insercion = await client.query(
      `INSERT INTO prepaid_amortization_schedules (
         id, entity_id, prepaid_expense_id, fiscal_period_id, amortization_date,
         period_index, days_covered, amortization_amount, accumulated_amortization,
         remaining_balance, is_posted, journal_entry_id, calculation_metadata
       )
       SELECT $1, pe.entity_id, pe.id, $4, $5::date, $6, $7, $8, $9, $10, true, $11, $12::jsonb
         FROM prepaid_expenses pe
        WHERE pe.id = $2 AND pe.entity_id = $3 AND pe.status <> 'cancelled'`,
      [
        uuidv4(),
        anticipo.id,
        entityId,
        periodo.id,
        fechaDelAsiento(periodo),
        indice,
        fila.days_covered,
        importe,
        acumulada.toFixed(4),
        new Decimal(anticipo.total_amount).minus(acumulada).toFixed(4),
        je.id,
        JSON.stringify(metadatos),
      ]
    );
    if (insercion.rowCount !== 1) {
      throw new ValidationError(
        'no es de esta entidad o está cancelado: no se escribió su renglón.'
      );
    }

    // LA TARJETA SE DERIVA DE LO POSTEADO, NO DEL CALENDARIO.
    //
    // `amortized_to_date` se reescribe con la SUMA de los renglones posteados,
    // no con `acumulada`. La diferencia importa cuando los meses no se corren
    // en orden: corrido marzo, luego enero, luego febrero, la suma es la misma
    // en los tres casos y el arrastre no. Es la reparación que F06a tuvo que
    // hacer sobre la ficha del activo, donde el último UPDATE en ganar era el
    // que mandaba y la diferencia no se cerraba nunca.
    //
    // La suma de los renglones posteados es, por construcción, la misma que la
    // de los asientos: la 059 exige `journal_entry_id` para `is_posted`, así
    // que no hay renglón posteado sin asiento detrás. Pero `is_posted` sola
    // cuenta también el renglón cuyo asiento ya tiene espejo, y ése el mayor
    // no lo respalda: la ficha afirmaba un devengo que el resultado ya no
    // tenía. Se suman los renglones VIGENTES.
    //
    // Y EL ESTADO SE MUEVE EN LOS DOS SENTIDOS. La transición sólo subía a
    // `fully_amortized`, así que un anticipo al que una reversa le devolvía un
    // mes se quedaba cerrado con el mayor debiéndole gasto.
    const actualizacion = await client.query(
      `UPDATE prepaid_expenses pe SET
         amortized_to_date = p.devengado,
         last_amortization_date = p.ultima,
         status = CASE
                    WHEN p.devengado >= pe.total_amount THEN 'fully_amortized'
                    WHEN pe.status = 'fully_amortized'  THEN 'active'
                    ELSE pe.status
                  END,
         updated_at = NOW()
       FROM (
         SELECT COALESCE(SUM(s.amortization_amount), 0) AS devengado,
                MAX(s.amortization_date)                AS ultima
           FROM prepaid_amortization_schedules s
          WHERE s.prepaid_expense_id = $1 AND s.entity_id = $2 AND ${RENGLON_VIGENTE}
       ) p
       WHERE pe.id = $1 AND pe.entity_id = $2`,
      [anticipo.id, entityId]
    );
    if (actualizacion.rowCount !== 1) {
      throw new ValidationError(
        'no es de esta entidad: no se actualizó lo que lleva devengado.'
      );
    }

    return je.id;
  });

  // Client del llamador significa atestiguación del llamador, DESPUÉS del
  // commit: la cadena tiene que ver datos confirmados.
  attestEntryAsync(a.tenantId, entityId, entryId);

  return importe;
}

/**
 * Un anticipo sin nada que devengar se cierra, para que deje de aparecer en la
 * corrida y en la casilla del cierre.
 *
 * Ocurre con el saldo topado del punto 3 y con el anticipo cancelado a medias.
 * Es un UPDATE de estado, no de dinero: no toca el mayor.
 */
async function marcarAgotado(prepaidId: string, entityId: string): Promise<void> {
  await query(
    `UPDATE prepaid_expenses SET status = 'fully_amortized', updated_at = NOW()
      WHERE id = $1 AND entity_id = $2 AND status = 'active'`,
    [prepaidId, entityId]
  );
}
