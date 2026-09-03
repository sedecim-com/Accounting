import type pg from 'pg';
import Decimal from 'decimal.js';
import { query } from '../../../database/connection.js';
import { getPolicy } from '../../policy/policy-service.js';
import { ValidationError } from '../../../utils/errors.js';

// ============================================================
// ISN · EL IMPUESTO SOBRE NÓMINAS QUE NO EXISTÍA
//
// El ISN es estatal, lo paga el PATRÓN sobre las remuneraciones al trabajo
// personal subordinado, y va de ~1% a ~4% según la entidad federativa. Hasta
// esta pieza no aparecía en una sola línea del sistema: se calculaban IMSS e
// INFONAVIT y se declaraba completo el costo laboral de cada trabajador
// habiéndole quitado un impuesto entero.
//
// TRES NEGATIVAS DELIBERADAS, y las tres existen porque la alternativa a
// negarse es devolver un número plausible:
//
//  1. LA TASA SE BUSCA POR ESTADO **Y** POR FECHA. Nunca «la última
//     capturada». Los congresos estatales mueven estas tasas por decreto, y
//     calcular la nómina de marzo con la tasa de diciembre da un importe que
//     nadie va a mirar dos veces porque tiene la magnitud correcta.
//
//  2. SIN TASA CAPTURADA NO HAY CERO. La tabla mx_isn_tasas_estatales nace
//     vacía a propósito (migración 067): treinta y dos estados de memoria son
//     treinta y dos números inventados. Cuando falta la tasa, esto devuelve un
//     HALLAZGO que nombra el estado y el periodo — un cero silencioso aquí es
//     una omisión fiscal con aspecto de resultado, y el estado que no cobró
//     este año cobra con recargos el que viene.
//
//  3. UN RÉGIMEN QUE NO SEA TASA PLANA SE NIEGA. Varios estados cobran por
//     escalones o eximen bajo cierto monto. Este motor sólo sabe multiplicar
//     una tasa por una base: aplicar esa tasa a un régimen escalonado —o
//     ignorar una exención mensual sobre un periodo que puede ser quincenal—
//     produce, otra vez, un número con la magnitud correcta y el valor
//     equivocado. Se marca y se dice cuál es el régimen que no se sabe hacer.
//
// El resultado NO lanza: devuelve renglones y hallazgos, igual que el motor de
// la DIOT (src/services/sat/diot/hallazgos.ts) y por la misma razón. Con
// trabajadores en cinco estados, lanzar al primero que falta obligaría al
// contador a capturar una tasa, volver a correr y descubrir la siguiente. Se
// calcula todo lo que se puede, y se nombra TODO lo que falta de una vez.
// ============================================================

/** Escala interna del dinero en este módulo: cuatro decimales, como en todo el sistema. */
const ESCALA = 4;

export type SeveridadNomina = 'bloqueante' | 'aviso';

/**
 * Un hallazgo de la salida de nómina.
 *
 * Vive aquí porque nació con el ISN, y lo comparte el acumulador del pasivo
 * patronal (employer-liability-service.ts), que es su otro consumidor: los dos
 * reportan al mismo lector y no tiene sentido que le hablen en dos formas.
 */
export interface HallazgoNomina {
  /** Código estable: una prueba lo cuenta sin casar prosa. */
  codigo: string;
  severidad: SeveridadNomina;
  /** En español, y nombrando SIEMPRE al estado y al periodo culpables. */
  mensaje: string;
  /** Clave de la entidad federativa, cuando el hallazgo es de una. */
  estado?: string | null;
  /** El periodo que le falta, como «2026-03-01 a 2026-03-31». */
  periodo?: string;
}

export function hallazgosQueBloquean(hallazgos: readonly HallazgoNomina[]): HallazgoNomina[] {
  return hallazgos.filter((h) => h.severidad === 'bloqueante');
}

export function contarHallazgos(
  hallazgos: readonly HallazgoNomina[]
): Record<SeveridadNomina, number> {
  return {
    bloqueante: hallazgos.filter((h) => h.severidad === 'bloqueante').length,
    aviso: hallazgos.filter((h) => h.severidad === 'aviso').length,
  };
}

export type RegimenIsn = 'tasa_plana' | 'escalonado' | 'con_exencion';

/** Una vigencia capturada de mx_isn_tasas_estatales, ya como cadenas. */
export interface TasaIsn {
  estado: string;
  /** 'YYYY-MM-DD'. */
  vigenciaDesde: string;
  /** 'YYYY-MM-DD' o null = sigue vigente. */
  vigenciaHasta: string | null;
  /** Tasa como se capturó, p. ej. '0.030000'. */
  tasa: string;
  regimen: RegimenIsn;
  exencionMensual: string | null;
  fundamento: string;
}

/** Remuneraciones de un periodo atribuidas a un estado. */
export interface BaseIsn {
  /** null = el trabajador no tiene estado capturado; el hallazgo lo dirá. */
  estado: string | null;
  /** Remuneraciones pagadas, cadena de dinero. */
  base: string;
  /** Cuántos recibos componen la base: el hallazgo dice a cuántos afecta. */
  trabajadores: number;
}

export interface EntradaIsn {
  bases: readonly BaseIsn[];
  /** 'YYYY-MM-DD' — inicio del periodo de nómina. */
  periodoInicio: string;
  /** 'YYYY-MM-DD' — fin del periodo de nómina. */
  periodoFin: string;
  /**
   * Fecha con la que se elige la vigencia. La decide `isn_momento_de_causacion`:
   * devengo → fin del periodo; pago → fecha de pago.
   */
  fechaCausacion: string;
  /** Cliente del llamador, para leer DENTRO de su transacción. */
  client?: pg.PoolClient;
}

export interface RenglonIsn {
  estado: string;
  /** Base gravable, 4 decimales. */
  base: string;
  tasa: string;
  /** Importe del impuesto, 4 decimales. */
  importe: string;
  vigenciaDesde: string;
  fundamento: string;
  trabajadores: number;
}

export interface ResultadoIsn {
  /** Un renglón POR ESTADO: cada estado audita el suyo, no hay un agregado. */
  porEstado: RenglonIsn[];
  hallazgos: HallazgoNomina[];
  /** Suma de los estados que SÍ tienen tasa. Nunca incluye a los que faltan. */
  total: string;
}

type Ejecutor = <T extends pg.QueryResultRow>(
  sql: string,
  params: unknown[]
) => Promise<pg.QueryResult<T>>;

function ejecutorDe(client?: pg.PoolClient): Ejecutor {
  return client
    ? <T extends pg.QueryResultRow>(sql: string, params: unknown[]) => client.query<T>(sql, params)
    : query;
}

function periodoLegible(inicio: string, fin: string): string {
  return `${inicio} a ${fin}`;
}

/**
 * Las vigencias de un estado que TOCAN el periodo.
 *
 * El intervalo es SEMIABIERTO — [vigencia_desde, vigencia_hasta) — y no es una
 * elección de este archivo: es la que impone el disparador `trg_isn_sin_solape`
 * de la migración 067, que declara solape cuando
 * `desde < COALESCE(hasta,'9999-12-31') AND COALESCE(hasta,…) > otro_desde`.
 * Con esa convención, una tasa que cierra el 2026-01-01 y la siguiente que
 * abre ese mismo día no se solapan, y el 2026-01-01 pertenece a la SEGUNDA.
 * Leer con la convención contraria devolvería dos filas para ese día — que es
 * exactamente el instrumento que miente según quién lo corra.
 *
 * mx_isn_tasas_estatales es CATÁLOGO (como inpc_serie o sat_bancos): la ley es
 * la misma para todos los inquilinos y la tabla no lleva tenant_id, así que
 * aquí no hay frontera de inquilino que acotar.
 */
export async function vigenciasDeIsn(
  estado: string,
  periodoInicio: string,
  periodoFin: string,
  client?: pg.PoolClient
): Promise<TasaIsn[]> {
  const ejecutar = ejecutorDe(client);
  const r = await ejecutar<{
    estado: string;
    vigencia_desde: string;
    vigencia_hasta: string | null;
    tasa: string;
    regimen: RegimenIsn;
    exencion_mensual: string | null;
    fundamento: string;
  }>(
    // Las fechas salen como TEXTO a propósito: sin setTypeParser, el driver
    // convierte una columna DATE en un Date a medianoche LOCAL, y comparar eso
    // con 'YYYY-MM-DD' corre el día entero en cuanto la máquina no está en UTC.
    `SELECT estado,
            vigencia_desde::text AS vigencia_desde,
            vigencia_hasta::text AS vigencia_hasta,
            tasa::text AS tasa,
            regimen,
            exencion_mensual::text AS exencion_mensual,
            fundamento
       FROM mx_isn_tasas_estatales
      WHERE estado = $1
        AND vigencia_desde <= $3::date
        AND (vigencia_hasta IS NULL OR vigencia_hasta > $2::date)
      ORDER BY vigencia_desde`,
    [estado, periodoInicio, periodoFin]
  );
  return r.rows.map((f) => ({
    estado: f.estado,
    vigenciaDesde: f.vigencia_desde,
    vigenciaHasta: f.vigencia_hasta,
    tasa: f.tasa,
    regimen: f.regimen,
    exencionMensual: f.exencion_mensual,
    fundamento: f.fundamento,
  }));
}

/** La vigencia que cubre una fecha, con el intervalo semiabierto de arriba. */
export function vigenteEn(tasas: readonly TasaIsn[], fecha: string): TasaIsn | undefined {
  return tasas.find(
    (t) => t.vigenciaDesde <= fecha && (t.vigenciaHasta === null || t.vigenciaHasta > fecha)
  );
}

/**
 * El ISN de un periodo, estado por estado.
 *
 * No lanza nunca: lo que no se puede calcular sale como hallazgo bloqueante
 * con el estado y el periodo escritos en el mensaje. El llamador decide si
 * eso detiene el cierre; lo que no puede pasar es que se vuelva un cero.
 */
export async function calcularIsn(entrada: EntradaIsn): Promise<ResultadoIsn> {
  const { bases, periodoInicio, periodoFin, fechaCausacion, client } = entrada;
  const periodo = periodoLegible(periodoInicio, periodoFin);
  const porEstado: RenglonIsn[] = [];
  const hallazgos: HallazgoNomina[] = [];
  let total = new Decimal(0);

  for (const b of bases) {
    const estado = (b.estado ?? '').trim().toUpperCase();

    // EL TRABAJADOR SIN ESTADO NO ES UN TRABAJADOR SIN IMPUESTO. Su nómina
    // causa ISN en algún lado; lo que falta es el dato que dice en cuál.
    if (estado === '') {
      hallazgos.push({
        codigo: 'isn_sin_estado_en_el_trabajador',
        severidad: 'bloqueante',
        estado: null,
        periodo,
        mensaje:
          `${b.trabajadores} recibo(s) del periodo ${periodo} suman ${b.base} sin estado ` +
          'que los cause: el ISN de esa base no se puede calcular ni declarar. Captura el ' +
          'estado de trabajo del trabajador, o cambia la política isn_estado_que_causa ' +
          'a domicilio_fiscal si tu criterio es declararlo todo en el domicilio de la entidad.',
      });
      continue;
    }

    // LA VENTANA DE BÚSQUEDA TIENE QUE ALCANZAR A LA CAUSACIÓN, Y LA
    // CAUSACIÓN CAE FUERA DEL PERIODO EN CUANTO EL CRITERIO ES «pago».
    //
    // Se buscaba entre `periodoInicio` y `periodoFin`, y después se elegía la
    // vigencia que cubre `fechaCausacion`. Con `isn_momento_de_causacion` en
    // `pago` esa fecha es el día de pago, que normalmente cae DESPUÉS del
    // cierre del periodo: una quincena del 16 al 30 de junio pagada el 5 de
    // julio se causa en julio, y la tasa que rige desde el 1 de julio no
    // entraba en la consulta porque su `vigencia_desde` es posterior al fin
    // del periodo. El resultado era el hallazgo «no hay tasa capturada»
    // señalando a una tasa que SÍ está capturada y que sí cubre la causación,
    // y —peor— el pasivo de ISN de esa corrida no se apuntaba en ninguna
    // parte. La ventana se estira hasta abarcar la fecha con la que después
    // se va a elegir; el intervalo semiabierto no cambia.
    const ventanaInicio = fechaCausacion < periodoInicio ? fechaCausacion : periodoInicio;
    const ventanaFin = fechaCausacion > periodoFin ? fechaCausacion : periodoFin;
    const tasas = await vigenciasDeIsn(estado, ventanaInicio, ventanaFin, client);
    const vigente = vigenteEn(tasas, fechaCausacion);

    if (!vigente) {
      hallazgos.push({
        codigo: 'isn_sin_tasa_capturada',
        severidad: 'bloqueante',
        estado,
        periodo,
        mensaje:
          tasas.length === 0
            ? `No hay tasa de ISN capturada para ${estado} en el periodo ${periodo} ` +
              `(causación ${fechaCausacion}). La base de ${b.base} de ${b.trabajadores} ` +
              'recibo(s) queda SIN calcular: no se declara cero, se declara que falta el dato. ' +
              'Captura la tasa con su fundamento en mx_isn_tasas_estatales.'
            : `${estado} tiene ${tasas.length} vigencia(s) capturada(s) que tocan el periodo ` +
              `${periodo} o su causación, pero ninguna cubre la fecha de causación ` +
              `${fechaCausacion}: la base de ${b.base} queda sin calcular. ` +
              'Revisa vigencia_desde/vigencia_hasta.',
      });
      continue;
    }

    // UN RÉGIMEN QUE NO SE SABE HACER SE DICE, NO SE APROXIMA. El escalonado
    // necesita una tabla de escalones que aquí no existe; el de exención
    // necesita repartir una franquicia MENSUAL sobre un periodo que puede ser
    // quincenal o semanal, y repartirla mal exime de más en cada corrida.
    if (vigente.regimen !== 'tasa_plana') {
      hallazgos.push({
        codigo: 'isn_regimen_no_soportado',
        severidad: 'bloqueante',
        estado,
        periodo,
        mensaje:
          `La tasa de ISN de ${estado} vigente desde ${vigente.vigenciaDesde} está capturada ` +
          `como régimen «${vigente.regimen}»` +
          (vigente.exencionMensual ? ` (exime ${vigente.exencionMensual} al mes)` : '') +
          `, y este motor sólo sabe calcular tasa plana. La base de ${b.base} del periodo ` +
          `${periodo} NO se calcula: aplicarle la tasa como si fuera plana daría un importe ` +
          'de la magnitud correcta y del valor equivocado.',
      });
      continue;
    }

    // Un cambio de tasa DENTRO del periodo se aplica entero o no se aplica:
    // partir la base por días es una decisión de criterio que nadie ha tomado.
    // Se calcula con la tasa de la causación y se avisa de que hubo cambio.
    //
    // El aviso cuenta las vigencias que tocan EL PERIODO, no las que trajo la
    // ventana: al estirarla hasta la causación puede entrar una vigencia
    // posterior al periodo, y avisar de un cambio «dentro del periodo» que no
    // ocurrió dentro del periodo sería un aviso falso — de los que enseñan a
    // ignorar los avisos.
    const tocanElPeriodo = tasas.filter(
      (t) =>
        t.vigenciaDesde <= periodoFin &&
        (t.vigenciaHasta === null || t.vigenciaHasta > periodoInicio)
    );
    if (tocanElPeriodo.length > 1) {
      hallazgos.push({
        codigo: 'isn_tasa_cambia_dentro_del_periodo',
        severidad: 'aviso',
        estado,
        periodo,
        mensaje:
          `${estado} cambió de tasa dentro del periodo ${periodo}: se aplicó la vigente ` +
          `al ${fechaCausacion} (${vigente.tasa}, desde ${vigente.vigenciaDesde}) a la base ` +
          'completa, sin partirla por días.',
      });
    }

    const base = new Decimal(b.base).toDecimalPlaces(ESCALA);
    const importe = base.times(vigente.tasa).toDecimalPlaces(ESCALA);
    total = total.plus(importe);
    porEstado.push({
      estado,
      base: base.toFixed(ESCALA),
      tasa: vigente.tasa,
      importe: importe.toFixed(ESCALA),
      vigenciaDesde: vigente.vigenciaDesde,
      fundamento: vigente.fundamento,
      trabajadores: b.trabajadores,
    });
  }

  return { porEstado, hallazgos, total: total.toFixed(ESCALA) };
}

export type CriterioEstadoIsn = 'centro_de_trabajo' | 'domicilio_fiscal';

const CRITERIOS_ESTADO_CONOCIDOS: Record<string, CriterioEstadoIsn> = {
  centro_de_trabajo: 'centro_de_trabajo',
  domicilio_fiscal: 'domicilio_fiscal',
};

/**
 * Traduce lo que `isn_estado_que_causa` VALE a lo que este motor sabe hacer,
 * y se niega si no lo sabe.
 *
 * Era un ternario —`=== 'domicilio_fiscal' ? … : 'centro_de_trabajo'`— y ahí
 * vivía un defecto silencioso. `pending define` acepta respuesta libre a
 * propósito («A free-form value is accepted», policy-service.ts): el despacho
 * puede contestar `domicilio` y la fila queda 'resolved' con ese valor. El
 * ternario lo colapsaba al centro de trabajo y el llamador seguía recibiendo
 * `criterioDefinido: true`, o sea que el sistema aplicaba SU omisión y la
 * firmaba como criterio del despacho. Con gente en varios estados, ésa es la
 * diferencia entre declarar el ISN donde se presta el trabajo y declararlo
 * todo en el domicilio fiscal: años debiéndole a otro estado sin enterarse.
 *
 * Se lanza en vez de avisar por la misma razón que en
 * `leerRegistroDelSubsidio`, el módulo hermano de este tramo: un valor que el
 * lector no entiende no es un dato que falte —eso sí se reporta y se sigue—,
 * es una decisión escrita que nadie está aplicando. El remedio es una línea de
 * `pending define`, y el mensaje la nombra.
 */
export function criterioEstadoDe(valor: string): CriterioEstadoIsn {
  const criterio = CRITERIOS_ESTADO_CONOCIDOS[valor];
  if (!criterio) {
    throw new ValidationError(
      `La política isn_estado_que_causa vale "${valor}" y este motor sólo entiende ` +
        `${Object.keys(CRITERIOS_ESTADO_CONOCIDOS).join(', ')}. No se elige uno por ti: ` +
        'de esa respuesta depende a qué estado se le declara el ISN, y aplicar la omisión ' +
        'como si fuera tu criterio es cómo se le acaba debiendo a un estado durante años. ' +
        `Corrígela con \`mnemosine pending define isn_estado_que_causa ` +
        `<${Object.keys(CRITERIOS_ESTADO_CONOCIDOS).join('|')}>\`.`,
      'isn_estado_que_causa'
    );
  }
  return criterio;
}

export interface ContextoBasesIsn {
  tenantId: string;
  entityId: string;
  payRunId: string;
  client?: pg.PoolClient;
}

export interface BasesIsnDeCorrida {
  criterio: CriterioEstadoIsn;
  /** false = nadie contestó la política y se está usando su omisión. */
  criterioDefinido: boolean;
  bases: BaseIsn[];
}

/**
 * Las remuneraciones de una corrida, agrupadas por el estado que las causa.
 *
 * QUIÉN DECIDE EL ESTADO es la política `isn_estado_que_causa` del panel, y
 * este código no la elige ni la pregunta: la lee. Su omisión —el centro de
 * trabajo— es la que puede exigir el impuesto, porque el ISN grava el trabajo
 * PRESTADO en la entidad federativa. La otra respuesta, declararlo todo en el
 * domicilio fiscal, es un criterio real de despachos con una sola plaza; con
 * gente en varios estados es también la forma de deberle a otro estado durante
 * años sin enterarse. Por eso se responde en el panel y no aquí.
 *
 * `criterioDefinido` viaja al llamador porque una política sin contestar NO es
 * una decisión del despacho, y el reporte no debe presentarla como tal.
 *
 * LAS DOS COLUMNAS DE ORIGEN NO SON DEL MISMO ANCHO NI DEL MISMO IDIOMA que la
 * clave del catálogo, y conviene saberlo antes de capturar tasas:
 * `employees.work_state` es VARCHAR(2) —nació para los estados de EE. UU.— y
 * `legal_entities.state_province` es VARCHAR(120) de texto libre, mientras que
 * `mx_isn_tasas_estatales.estado` es VARCHAR(3). Aquí se normaliza a mayúsculas
 * sin espacios y se compara TAL CUAL: la tasa hay que capturarla con la misma
 * clave con que el estado está escrito en el trabajador o en la entidad.
 * Cuando no coinciden, el resultado no es un cero — es el hallazgo
 * `isn_sin_tasa_capturada` nombrando la clave que se buscó, que es justo lo que
 * hace falta para arreglarlo.
 */
export async function basesIsnDeCorrida(ctx: ContextoBasesIsn): Promise<BasesIsnDeCorrida> {
  const ejecutar = ejecutorDe(ctx.client);
  const politica = await getPolicy(
    { tenantId: ctx.tenantId, entityId: ctx.entityId },
    'isn_estado_que_causa',
    ctx.client
  );
  const criterio = criterioEstadoDe(politica.value);

  // La frontera de inquilino y la de entidad van DENTRO del SQL, no en un if:
  // p.tenant_id acota el inquilino y e.entity_id la entidad, y el JOIN de
  // employees repite tenant_id para que ni siquiera un pay_run_id adivinado
  // pueda arrastrar recibos de otro.
  //
  // Sólo México: el ISN es un impuesto mexicano y una corrida puede llevar
  // trabajadores de los dos países.
  //
  // LA BASE ES `gross_earnings`, las remuneraciones pagadas por el trabajo
  // subordinado, que es lo que las leyes estatales gravan. Varios estados
  // excluyen conceptos concretos (fondo de ahorro, previsión social) y ese
  // detalle no está capturado en ninguna parte: cuando lo esté, se acota aquí.
  const sql =
    criterio === 'domicilio_fiscal'
      ? `SELECT UPPER(TRIM(COALESCE(le.state_province, ''))) AS estado,
                COALESCE(SUM(p.gross_earnings), 0)::text AS base,
                COUNT(*)::int AS trabajadores
           FROM paychecks p
           JOIN employees e ON e.id = p.employee_id AND e.tenant_id = p.tenant_id
           JOIN legal_entities le ON le.id = e.entity_id AND le.tenant_id = e.tenant_id
          WHERE p.tenant_id = $1 AND p.pay_run_id = $2
            AND e.entity_id = $3 AND e.country_code = 'MX'
          GROUP BY 1
          ORDER BY 1`
      : `SELECT UPPER(TRIM(COALESCE(e.work_state, ''))) AS estado,
                COALESCE(SUM(p.gross_earnings), 0)::text AS base,
                COUNT(*)::int AS trabajadores
           FROM paychecks p
           JOIN employees e ON e.id = p.employee_id AND e.tenant_id = p.tenant_id
          WHERE p.tenant_id = $1 AND p.pay_run_id = $2
            AND e.entity_id = $3 AND e.country_code = 'MX'
          GROUP BY 1
          ORDER BY 1`;

  const r = await ejecutar<{ estado: string; base: string; trabajadores: number }>(sql, [
    ctx.tenantId,
    ctx.payRunId,
    ctx.entityId,
  ]);

  return {
    criterio,
    criterioDefinido: politica.defined,
    bases: r.rows.map((f) => ({
      estado: f.estado === '' ? null : f.estado,
      base: f.base,
      trabajadores: f.trabajadores,
    })),
  };
}
