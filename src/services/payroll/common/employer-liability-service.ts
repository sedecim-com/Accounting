import type pg from 'pg';
import Decimal from 'decimal.js';
import { withTransaction } from '../../../database/connection.js';
import { ValidationError } from '../../../utils/errors.js';
import { getPolicy } from '../../policy/policy-service.js';
import {
  basesIsnDeCorrida,
  calcularIsn,
  hallazgosQueBloquean,
  type CriterioEstadoIsn,
  type HallazgoNomina,
} from '../mx/isn-calculator.js';

// ============================================================
// EL PASIVO PATRONAL, APUNTADO
//
// `employer_tax_liabilities` nació en la migración 008 y hasta hoy se LEÍA y
// nadie la escribía: las formas 940 y 941 la suman, el doctor la clasifica
// como huérfana con nivel 'fail', y el tablero lleva un tramo con el criterio
// de E4.1 en rojo honesto diciéndolo. Una tabla vacía no rompe nada visible;
// hace que la forma declare CERO impuesto patronal, que es un dato falso ante
// la autoridad, no una función que falta.
//
// Aquí se escribe lo que el patrón debe por una corrida ya aprobada: el IMSS
// patronal, el INFONAVIT patronal y el ISN de cada estado, cada uno con su
// fecha límite.
//
// UN PASIVO POR ESTADO, NO UNO AGREGADO. Cada estado audita el suyo y cobra el
// suyo; un renglón «ISN nacional» de tres estados sumados no se puede pagar en
// ninguna ventanilla ni conciliar contra ninguna declaración.
//
// DOS POLÍTICAS DEL PANEL GOBIERNAN ESTO, y ninguna se pregunta aquí:
//  · `provision_cuotas_patronales` decide si el IMSS/INFONAVIT patronal se
//    apunta con CADA CORRIDA (omisión) o UNA VEZ AL MES, que es como se pagan.
//  · `isn_momento_de_causacion` decide si el ISN se devenga con la nómina
//    (omisión) o con el pago, lo que mueve el renglón de mes cuando el periodo
//    cruza el fin de mes.
//
// CORRER EL CIERRE DOS VECES NO DUPLICA NADA, y no por una guarda de servicio:
//  · Los renglones por corrida se apoyan en `employer_tax_liab_una_por_corrida`
//    —el índice único parcial de la migración 067— con ON CONFLICT. El índice
//    es parcial porque `pay_run_id` es nulable por diseño y en SQL dos NULL no
//    son iguales: una UNIQUE normal dejaría pasar los repetidos sin avisar.
//  · El renglón MENSUAL sí tiene pay_run_id NULL, así que ese índice no lo
//    cubre. Su idempotencia es de otra clase: el importe se RECALCULA desde
//    todos los recibos del mes y se sobreescribe, en vez de sumarse. Correrlo
//    dos veces da el mismo total por construcción. El candado contra dos
//    cierres simultáneos es un pg_advisory_xact_lock, que es de la base y no
//    del proceso: dos instancias de la app comparten la base, no la memoria.
//  · Ninguna de las dos cosas basta cuando entre los dos cierres CAMBIA LA
//    RESPUESTA DEL PANEL, que es lo que un panel existe para permitir. La
//    llave del índice lleva `period_start`, y `isn_momento_de_causacion` es
//    justo quien decide ese mes: contestarla después del primer cierre mueve
//    la llave, el ON CONFLICT no encuentra a quién pisar e inserta un SEGUNDO
//    ISN de la misma nómina. Lo mismo con `provision_cuotas_patronales`, que
//    mueve el pasivo entre el renglón de la corrida y el del mes. Por eso, al
//    escribir, se barre el apunte que este mismo cierre acaba de dejar
//    obsoleto — sólo si el reemplazo ya está escrito, sólo dentro de la misma
//    corrida y sólo si el viejo sigue en 'pending'—, y se dice en un hallazgo.
//    La dirección que NO se puede barrer —el renglón mensual, que agrega
//    varias corridas— sale como hallazgo bloqueante en vez de callarse.
//
// NO SE PISA LO YA DEPOSITADO. Un renglón con status distinto de 'pending' ya
// se pagó o se dispensó; reescribirle el importe borraría la evidencia de lo
// que se pagó. Se deja intacto y se dice.
// ============================================================

/** Los importes se escriben en una columna NUMERIC(14,2): se redondea aquí, a la vista. */
const ESCALA_COLUMNA = 2;

export type CriterioProvision = 'por_corrida' | 'mensual_al_cierre';
export type CriterioCausacionIsn = 'devengo' | 'pago';

export type AccionPasivo = 'creado' | 'actualizado' | 'intacto';

// ------------------------------------------------------------
// LAS DOS POLÍTICAS SE LEEN CERRADAS, COMO LA DEL SUBSIDIO
//
// Los dos criterios salían de un ternario —`=== 'pago' ? 'pago' : 'devengo'`—
// y ahí vivía un defecto que no se ve mirando el camino feliz. `pending
// define` acepta respuesta LIBRE a propósito («A free-form value is
// accepted», policy-service.ts), así que el despacho puede contestar `pagos`
// o `mensual` y la fila queda 'resolved' con ese valor. El ternario lo
// colapsaba al valor de OMISIÓN y el resultado seguía informando
// `provisionDefinida: true` / `causacionIsnDefinida: true`: el sistema
// aplicaba su omisión y la firmaba como criterio del despacho, que es
// exactamente lo que este tramo dice no hacer.
//
// La consecuencia es una fecha: con un periodo que cruza el fin de mes, la
// diferencia entre devengo y pago es el MES al que pertenece el ISN y, con
// él, su fecha límite. Un pasivo apuntado un mes antes de lo que el despacho
// decidió no se distingue de uno correcto hasta que llega el requerimiento.
//
// Se lanza en vez de avisar, y no contradice el «NO LANZA» de
// `acumularPasivoPatronal`: eso vale para lo que falta de CAPTURAR —una tasa
// que no está—, no para una decisión escrita que nadie está aplicando. Es la
// misma puerta que `leerRegistroDelSubsidio` en este mismo tramo.
// ------------------------------------------------------------

const PROVISIONES_CONOCIDAS: Record<string, CriterioProvision> = {
  por_corrida: 'por_corrida',
  mensual_al_cierre: 'mensual_al_cierre',
};

const CAUSACIONES_CONOCIDAS: Record<string, CriterioCausacionIsn> = {
  devengo: 'devengo',
  pago: 'pago',
};

function exigirCriterio<T extends string>(
  conocidos: Record<string, T>,
  clave: string,
  valor: string,
  consecuencia: string
): T {
  const criterio = conocidos[valor];
  if (!criterio) {
    const admitidos = Object.keys(conocidos);
    throw new ValidationError(
      `La política ${clave} vale "${valor}" y este motor sólo entiende ` +
        `${admitidos.join(', ')}. No se elige uno por ti: ${consecuencia} ` +
        `Corrígela con \`mnemosine pending define ${clave} <${admitidos.join('|')}>\`.`,
      clave
    );
  }
  return criterio;
}

export function criterioProvisionDe(valor: string): CriterioProvision {
  return exigirCriterio(
    PROVISIONES_CONOCIDAS,
    'provision_cuotas_patronales',
    valor,
    'de esa respuesta depende si las cuotas patronales se apuntan con cada corrida o una ' +
      'vez al mes, y aplicar la omisión como si fuera tu criterio deja el pasivo del mes ' +
      'repartido entre dos formas de contarlo.'
  );
}

export function criterioCausacionDe(valor: string): CriterioCausacionIsn {
  return exigirCriterio(
    CAUSACIONES_CONOCIDAS,
    'isn_momento_de_causacion',
    valor,
    'de esa respuesta depende a qué MES pertenece el ISN de una nómina que cruza el fin de ' +
      'mes, y con él su fecha límite: un pasivo apuntado un mes antes de lo decidido no se ' +
      'distingue de uno correcto hasta que llega el requerimiento.'
  );
}

export interface RenglonPasivo {
  taxType: string;
  jurisdiction: string;
  /** 'YYYY-MM-DD'. */
  periodStart: string;
  periodEnd: string;
  /** Importe tal como quedó en la tabla, dos decimales. */
  importe: string;
  fechaLimite: string;
  frecuencia: string;
  /** null en el renglón mensual, que no pertenece a una corrida sola. */
  payRunId: string | null;
  accion: AccionPasivo;
}

export interface ResultadoAcumulacion {
  entityId: string;
  criterioProvision: CriterioProvision;
  /** false = nadie contestó la política; se está usando su omisión. */
  provisionDefinida: boolean;
  criterioCausacionIsn: CriterioCausacionIsn;
  causacionIsnDefinida: boolean;
  criterioEstadoIsn: CriterioEstadoIsn;
  estadoIsnDefinido: boolean;
  renglones: RenglonPasivo[];
  hallazgos: HallazgoNomina[];
}

export interface EntradaAcumulacion {
  tenantId: string;
  payRunId: string;
}

// ------------------------------------------------------------
// FECHAS LÍMITE
//
// Las tres que este archivo necesita salen de la misma regla legal —día 17 del
// mes siguiente— y NO se ajustan a día hábil: el ajuste del art. 12 del CFF
// necesita un calendario de días inhábiles que este sistema no tiene, y
// moverla «al lunes» a ojo produciría una fecha que parece cierta.
//
// El ISN es el caso incómodo: cada estado publica su propio calendario y
// varios no usan el 17. Ese dato no está en mx_isn_tasas_estatales y no se
// puede inventar por estado; se usa la regla general y ÉSTE es el único lugar
// donde habrá que cambiarlo cuando el calendario estatal se capture.
// ------------------------------------------------------------

function partesDeFecha(fecha: string): { anio: number; mes: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(fecha);
  if (!m) {
    throw new ValidationError(
      `Se esperaba una fecha 'YYYY-MM-DD' y llegó "${fecha}": una fecha ilegible aquí ` +
        'produciría una fecha límite plausible y falsa.',
      'fecha'
    );
  }
  return { anio: Number(m[1]), mes: Number(m[2]) };
}

/** Date.UTC normaliza el desbordamiento: mes 13 es enero del año siguiente. */
function isoUtc(anio: number, mes: number, dia: number): string {
  return new Date(Date.UTC(anio, mes - 1, dia)).toISOString().slice(0, 10);
}

export function inicioDeMes(fecha: string): string {
  const { anio, mes } = partesDeFecha(fecha);
  return isoUtc(anio, mes, 1);
}

export function finDeMes(fecha: string): string {
  const { anio, mes } = partesDeFecha(fecha);
  // Día 0 del mes siguiente = último día de éste, sin tabla de meses ni bisiestos.
  return isoUtc(anio, mes + 1, 0);
}

/** IMSS e ISN: día 17 del mes siguiente al que cierra el periodo (LSS art. 39). */
export function fechaLimiteDia17(finPeriodo: string): string {
  const { anio, mes } = partesDeFecha(finPeriodo);
  return isoUtc(anio, mes + 1, 17);
}

/**
 * INFONAVIT (y el RCV que viaja con él): BIMESTRAL. Los bimestres son
 * ene-feb, mar-abr, … y se pagan el 17 del mes siguiente al que cierra el
 * bimestre — una nómina de enero no vence en febrero, vence el 17 de marzo.
 */
export function fechaLimiteBimestral(finPeriodo: string): string {
  const { anio, mes } = partesDeFecha(finPeriodo);
  const cierreDelBimestre = mes % 2 === 0 ? mes : mes + 1;
  return isoUtc(anio, cierreDelBimestre + 1, 17);
}

// ------------------------------------------------------------
// ESCRITURA
// ------------------------------------------------------------

interface FilaPasivo {
  tenantId: string;
  entityId: string;
  payRunId: string | null;
  taxType: string;
  jurisdiction: string;
  periodStart: string;
  periodEnd: string;
  /** Ya redondeado a dos decimales. */
  importe: string;
  fechaLimite: string;
  frecuencia: string;
}

/**
 * El renglón de UNA corrida, apoyado en el índice único parcial de la 067.
 *
 * `xmax = 0` distingue la fila insertada de la actualizada en el RETURNING de
 * un ON CONFLICT: es sólo para el reporte —el llamador quiere saber si esto
 * creó o refrescó—, nunca para decidir nada.
 */
async function apuntarPorCorrida(
  client: pg.PoolClient,
  f: FilaPasivo
): Promise<{ accion: AccionPasivo | null; reubicados: number }> {
  const r = await client.query<{ insertado: boolean }>(
    `INSERT INTO employer_tax_liabilities (
       tenant_id, entity_id, pay_run_id, tax_type, jurisdiction,
       period_start, period_end, amount, due_date, deposit_frequency, status
     ) VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9::date, $10, 'pending')
     ON CONFLICT (tenant_id, entity_id, pay_run_id, tax_type, jurisdiction, period_start)
       WHERE pay_run_id IS NOT NULL
     DO UPDATE SET amount = EXCLUDED.amount,
                   period_end = EXCLUDED.period_end,
                   due_date = EXCLUDED.due_date,
                   deposit_frequency = EXCLUDED.deposit_frequency
       WHERE employer_tax_liabilities.status = 'pending'
     RETURNING (xmax = 0) AS insertado`,
    [
      f.tenantId, f.entityId, f.payRunId, f.taxType, f.jurisdiction,
      f.periodStart, f.periodEnd, f.importe, f.fechaLimite, f.frecuencia,
    ]
  );
  if (r.rowCount === 0) return { accion: 'intacto', reubicados: 0 };

  // EL MISMO IMPUESTO DE LA MISMA CORRIDA NO SE DEBE DOS VECES, NI AUNQUE
  // CAMBIE DE MES.
  //
  // El índice único de la 067 lleva `period_start` en la llave, y hace bien:
  // es lo que distingue el pasivo de enero del de febrero. Pero `period_start`
  // del ISN no lo fija el calendario, lo fija `isn_momento_de_causacion`: con
  // devengo es el mes en que cierra el periodo y con pago el mes en que sale
  // el dinero. Contestar esa política DESPUÉS de un primer cierre y volver a
  // cerrar mueve la llave, el ON CONFLICT ya no encuentra a quién pisar, e
  // inserta un SEGUNDO renglón — dos ISN por la misma nómina, el doble de
  // pasivo, cada uno en un mes.
  //
  // Se barre sólo cuando acaba de escribirse el reemplazo, sólo dentro de la
  // MISMA corrida y el mismo impuesto y jurisdicción, y sólo si el viejo
  // sigue en 'pending': un renglón ya depositado es evidencia de un pago y no
  // se toca ni para reubicarlo.
  const viejos = await client.query(
    `DELETE FROM employer_tax_liabilities
      WHERE tenant_id = $1 AND entity_id = $2 AND pay_run_id = $3
        AND tax_type = $4 AND jurisdiction = $5
        AND period_start <> $6::date AND status = 'pending'`,
    [f.tenantId, f.entityId, f.payRunId, f.taxType, f.jurisdiction, f.periodStart]
  );

  return {
    accion: r.rows[0].insertado ? 'creado' : 'actualizado',
    reubicados: viejos.rowCount ?? 0,
  };
}

/**
 * El renglón MENSUAL, que no pertenece a una corrida y por eso el índice
 * parcial no lo cubre. Se recalcula y se sobreescribe; el candado contra dos
 * cierres a la vez es un lock consultivo de la transacción, que vive en la
 * base y por tanto lo comparten todas las instancias de la app.
 */
async function apuntarMensual(
  client: pg.PoolClient,
  f: FilaPasivo,
  importeEsCero: boolean
): Promise<AccionPasivo | null> {
  const llave = [f.tenantId, f.entityId, f.taxType, f.jurisdiction, f.periodStart].join('|');
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [llave]);

  const upd = await client.query(
    `UPDATE employer_tax_liabilities
        SET amount = $6, period_end = $7::date, due_date = $8::date, deposit_frequency = $9
      WHERE tenant_id = $1 AND entity_id = $2 AND pay_run_id IS NULL
        AND tax_type = $3 AND jurisdiction = $4 AND period_start = $5::date
        AND status = 'pending'`,
    [
      f.tenantId, f.entityId, f.taxType, f.jurisdiction, f.periodStart,
      f.importe, f.periodEnd, f.fechaLimite, f.frecuencia,
    ]
  );
  if ((upd.rowCount ?? 0) > 0) return 'actualizado';

  // No se actualizó: o no existe, o existe y ya está depositado.
  const ya = await client.query(
    `SELECT status FROM employer_tax_liabilities
      WHERE tenant_id = $1 AND entity_id = $2 AND pay_run_id IS NULL
        AND tax_type = $3 AND jurisdiction = $4 AND period_start = $5::date`,
    [f.tenantId, f.entityId, f.taxType, f.jurisdiction, f.periodStart]
  );
  if ((ya.rowCount ?? 0) > 0) return 'intacto';
  if (importeEsCero) return null;

  await client.query(
    `INSERT INTO employer_tax_liabilities (
       tenant_id, entity_id, pay_run_id, tax_type, jurisdiction,
       period_start, period_end, amount, due_date, deposit_frequency, status
     ) VALUES ($1, $2, NULL, $3, $4, $5::date, $6::date, $7, $8::date, $9, 'pending')`,
    [
      f.tenantId, f.entityId, f.taxType, f.jurisdiction,
      f.periodStart, f.periodEnd, f.importe, f.fechaLimite, f.frecuencia,
    ]
  );
  return 'creado';
}

function aColumna(importe: string): string {
  return new Decimal(importe).toDecimalPlaces(ESCALA_COLUMNA, Decimal.ROUND_HALF_UP).toFixed(
    ESCALA_COLUMNA
  );
}

// ------------------------------------------------------------
// ACUMULACIÓN
// ------------------------------------------------------------

/**
 * Acumula el pasivo patronal de una corrida ya aprobada.
 *
 * NO LANZA por lo que falta de capturar: devuelve los hallazgos y deja que el
 * llamador decida. La razón es la misma que en el motor de la DIOT: con gente
 * en cinco estados, lanzar al primero que no tiene tasa obliga a capturar una,
 * volver a correr y descubrir la siguiente. Sí lanza por lo que es un error de
 * uso —corrida inexistente, o en un estado que todavía no debe nada—, porque
 * eso no es un dato que falte sino una llamada equivocada.
 *
 * `client` permite acumular DENTRO de la transacción que aprueba la corrida:
 * el pasivo y el cambio de estado entran juntos o no entra ninguno.
 */
export async function acumularPasivoPatronal(
  entrada: EntradaAcumulacion,
  client?: pg.PoolClient
): Promise<ResultadoAcumulacion> {
  if (client) return acumular(client, entrada);
  return withTransaction((c) => acumular(c, entrada));
}

async function acumular(
  client: pg.PoolClient,
  entrada: EntradaAcumulacion
): Promise<ResultadoAcumulacion> {
  const { tenantId, payRunId } = entrada;

  // La corrida se BLOQUEA mientras se acumula: dos cierres simultáneos de la
  // misma corrida se ponen en fila, y el segundo ve lo que escribió el
  // primero en vez de competir con él por el índice único.
  //
  // La entidad NO viene del llamador: sale de la corrida por su calendario
  // (pay_runs no tiene entity_id; pay_schedules sí). Un entity_id de
  // parámetro es un entity_id que se puede equivocar, y employer_tax_liabilities
  // lo lleva como NOT NULL con llave foránea.
  //
  // Las fechas salen como texto: sin setTypeParser el driver devuelve un Date
  // a medianoche local y el mes de causación se corre en cuanto la máquina no
  // está en UTC.
  const corrida = await client.query<{
    status: string;
    entity_id: string;
    period_start: string;
    period_end: string;
    pay_date: string;
  }>(
    `SELECT pr.status,
            ps.entity_id,
            pp.period_start::text AS period_start,
            pp.period_end::text AS period_end,
            pp.pay_date::text AS pay_date
       FROM pay_runs pr
       JOIN pay_periods pp ON pp.id = pr.pay_period_id AND pp.tenant_id = pr.tenant_id
       JOIN pay_schedules ps ON ps.id = pp.pay_schedule_id AND ps.tenant_id = pp.tenant_id
      WHERE pr.id = $1 AND pr.tenant_id = $2
      FOR UPDATE OF pr`,
    [payRunId, tenantId]
  );
  if (corrida.rowCount === 0) {
    throw new ValidationError(
      `No existe la corrida de nómina ${payRunId} en este inquilino.`,
      'pay_run_id'
    );
  }
  const c = corrida.rows[0];
  if (c.status !== 'approved' && c.status !== 'paid') {
    throw new ValidationError(
      `La corrida ${payRunId} está en estado "${c.status}": el pasivo patronal se apunta ` +
        'cuando la corrida se cierra (approved o paid), no antes. Apuntarlo sobre números ' +
        'que todavía pueden cambiar deja un pasivo que no corresponde a ningún recibo.',
      'status'
    );
  }
  const entityId = c.entity_id;
  const ctxPolitica = { tenantId, entityId };

  const [pProvision, pCausacion] = await Promise.all([
    getPolicy(ctxPolitica, 'provision_cuotas_patronales', client),
    getPolicy(ctxPolitica, 'isn_momento_de_causacion', client),
  ]);
  const criterioProvision = criterioProvisionDe(pProvision.value);
  const criterioCausacionIsn = criterioCausacionDe(pCausacion.value);

  const renglones: RenglonPasivo[] = [];
  const hallazgos: HallazgoNomina[] = [];
  /** Renglones de esta corrida que este cierre movió de mes. Ver apuntarPorCorrida. */
  let reubicados = 0;

  // ---- IMSS e INFONAVIT patronales, de los recibos de ESTA corrida ----
  //
  // El FILTER por entidad y el conteo de los AJENOS van en la misma consulta a
  // propósito: la entidad sale del calendario de la corrida, y si algún recibo
  // pertenece a un trabajador de OTRA entidad, acotar por entidad —que hay que
  // hacerlo, porque el pasivo es de una— lo dejaría fuera sin que nada lo diga.
  // Un recibo que no acumula pasivo es la misma omisión que esta pieza repara,
  // en pequeño; se cuenta y se avisa.
  const propios = await client.query<{
    imss: string;
    infonavit: string;
    recibos: number;
    ajenos: number;
  }>(
    `SELECT COALESCE(SUM(p.imss_employer) FILTER (WHERE e.entity_id = $3), 0)::text AS imss,
            COALESCE(SUM(p.infonavit_employer) FILTER (WHERE e.entity_id = $3), 0)::text AS infonavit,
            COUNT(*) FILTER (WHERE e.entity_id = $3)::int AS recibos,
            COUNT(*) FILTER (WHERE e.entity_id <> $3)::int AS ajenos
       FROM paychecks p
       JOIN employees e ON e.id = p.employee_id AND e.tenant_id = p.tenant_id
      WHERE p.tenant_id = $1 AND p.pay_run_id = $2
        AND e.country_code = 'MX'`,
    [tenantId, payRunId, entityId]
  );
  const recibosMx = propios.rows[0]?.recibos ?? 0;
  const recibosAjenos = propios.rows[0]?.ajenos ?? 0;
  if (recibosAjenos > 0) {
    hallazgos.push({
      codigo: 'recibos_de_otra_entidad_en_la_corrida',
      severidad: 'aviso',
      periodo: `${c.period_start} a ${c.period_end}`,
      mensaje:
        `${recibosAjenos} recibo(s) mexicanos de esta corrida son de trabajadores de OTRA ` +
        `entidad legal y no entran en el pasivo de ${entityId}, que es la del calendario de ` +
        'la corrida. Su IMSS, INFONAVIT e ISN no quedan acumulados en ninguna parte.',
    });
  }
  const imssPropio = new Decimal(propios.rows[0]?.imss ?? '0');
  const infonavitPropio = new Decimal(propios.rows[0]?.infonavit ?? '0');

  // Recibos mexicanos sin un peso de cuota patronal es un síntoma, no un
  // resultado: casi siempre significa que el SBC del trabajador no está
  // capturado, y entonces el costo laboral de la corrida está incompleto.
  if (recibosMx > 0 && imssPropio.isZero()) {
    hallazgos.push({
      codigo: 'imss_patronal_en_cero',
      severidad: 'aviso',
      periodo: `${c.period_start} a ${c.period_end}`,
      mensaje:
        `La corrida tiene ${recibosMx} recibo(s) mexicanos y el IMSS patronal suma cero. ` +
        'Revisa el SBC de esos trabajadores: sin él no hay cuota que acumular y el costo ' +
        'laboral de la corrida queda corto.',
    });
  }

  const mesInicio = inicioDeMes(c.period_end);
  const mesFin = finDeMes(c.period_end);

  if (criterioProvision === 'mensual_al_cierre') {
    // EL MISMO MES NO SE PROVISIONA POR LAS DOS VÍAS.
    //
    // `provision_cuotas_patronales` es una respuesta del panel, y una respuesta
    // se puede dar DESPUÉS del primer cierre. Cuando esta corrida ya dejó sus
    // renglones por corrida y ahora el criterio dice «mensual», el renglón del
    // mes se escribe unas líneas más abajo recalculado desde TODOS los recibos
    // del mes —incluidos los de esta corrida—, así que dejar los por corrida
    // en pie cuenta el IMSS patronal dos veces: una en su renglón y otra
    // dentro del agregado. Se barren aquí, antes de escribir el reemplazo, y
    // sólo los que siguen en 'pending'.
    const barridos = await client.query(
      `DELETE FROM employer_tax_liabilities
        WHERE tenant_id = $1 AND entity_id = $2 AND pay_run_id = $3
          AND tax_type IN ('imss_employer', 'infonavit_employer')
          AND status = 'pending'`,
      [tenantId, entityId, payRunId]
    );
    if ((barridos.rowCount ?? 0) > 0) {
      hallazgos.push({
        codigo: 'pasivo_por_corrida_absorbido_por_el_mensual',
        severidad: 'aviso',
        periodo: `${c.period_start} a ${c.period_end}`,
        mensaje:
          `${barridos.rowCount} renglón(es) de cuotas patronales que esta corrida había ` +
          'apuntado por su cuenta se retiraron: `provision_cuotas_patronales` dice ahora ' +
          '«mensual_al_cierre» y el renglón del mes ya los incluye. Dejarlos habría ' +
          'duplicado el IMSS patronal del mes.',
      });
    }

    // El importe del mes se RECALCULA desde todos los recibos aprobados cuyo
    // periodo cierra dentro del mes —incluida esta corrida, que ya está
    // aprobada dentro de esta transacción—. Recalcular en vez de sumar es lo
    // que hace la operación idempotente sin depender de ningún índice.
    const delMes = await client.query<{ imss: string; infonavit: string }>(
      `SELECT COALESCE(SUM(p.imss_employer), 0)::text AS imss,
              COALESCE(SUM(p.infonavit_employer), 0)::text AS infonavit
         FROM paychecks p
         JOIN pay_runs pr ON pr.id = p.pay_run_id AND pr.tenant_id = p.tenant_id
         JOIN pay_periods pp ON pp.id = pr.pay_period_id AND pp.tenant_id = pr.tenant_id
         JOIN pay_schedules ps ON ps.id = pp.pay_schedule_id AND ps.tenant_id = pp.tenant_id
         JOIN employees e ON e.id = p.employee_id AND e.tenant_id = p.tenant_id
        WHERE p.tenant_id = $1 AND e.country_code = 'MX'
          -- LAS DOS ENTIDADES, la del calendario de la corrida y la del
          -- trabajador, y por la misma razón que en el camino por corrida: si
          -- sólo se acotara por el calendario, el recibo de un trabajador de la
          -- entidad hermana entraría en ESTE pasivo mensual, y el aviso de
          -- recibos_de_otra_entidad_en_la_corrida estaría diciendo que quedó
          -- fuera mientras el renglón del mes lo lleva dentro.
          AND ps.entity_id = $2 AND e.entity_id = $2
          AND pr.status IN ('approved', 'paid')
          AND pp.period_end >= $3::date AND pp.period_end <= $4::date`,
      [tenantId, entityId, mesInicio, mesFin]
    );
    const imssMes = aColumna(delMes.rows[0]?.imss ?? '0');
    const infonavitMes = aColumna(delMes.rows[0]?.infonavit ?? '0');

    for (const [taxType, importe, frecuencia, limite] of [
      ['imss_employer', imssMes, 'monthly', fechaLimiteDia17(mesFin)],
      ['infonavit_employer', infonavitMes, 'bimestral', fechaLimiteBimestral(mesFin)],
    ] as const) {
      const fila: FilaPasivo = {
        tenantId, entityId, payRunId: null, taxType, jurisdiction: 'MX',
        periodStart: mesInicio, periodEnd: mesFin, importe,
        fechaLimite: limite, frecuencia,
      };
      const accion = await apuntarMensual(client, fila, new Decimal(importe).isZero());
      if (accion) renglones.push({ ...fila, accion });
    }
  } else {
    // LA DIRECCIÓN CONTRARIA NO SE PUEDE BARRER, Y POR ESO SE DICE EN VOZ ALTA.
    //
    // Si el criterio era «mensual_al_cierre» y ahora es «por_corrida», existe
    // un renglón del mes con pay_run_id NULL que agrega VARIAS corridas —no
    // sólo ésta—, así que borrarlo se llevaría por delante el pasivo de las
    // demás. Escribir los renglones por corrida encima de él cuenta este mes
    // dos veces, y eso es una cifra falsa: se declara bloqueante para que
    // nadie presente el pasivo del mes sin resolver antes el solape a mano.
    const mensualVivo = await client.query<{ tax_type: string; amount: string }>(
      `SELECT tax_type, amount::text FROM employer_tax_liabilities
        WHERE tenant_id = $1 AND entity_id = $2 AND pay_run_id IS NULL
          AND tax_type IN ('imss_employer', 'infonavit_employer')
          AND period_start = $3::date AND status = 'pending'`,
      [tenantId, entityId, mesInicio]
    );
    if ((mensualVivo.rowCount ?? 0) > 0) {
      hallazgos.push({
        codigo: 'pasivo_mensual_y_por_corrida_a_la_vez',
        severidad: 'bloqueante',
        periodo: `${mesInicio} a ${mesFin}`,
        mensaje:
          `El mes ${mesInicio} ya tiene ${mensualVivo.rowCount} renglón(es) de cuotas ` +
          'patronales provisionados AL CIERRE DEL MES (' +
          mensualVivo.rows.map((x) => `${x.tax_type} ${x.amount}`).join(', ') +
          '), y esta corrida los está apuntando además POR CORRIDA porque ' +
          '`provision_cuotas_patronales` cambió a «por_corrida». El mes queda contado dos ' +
          'veces. El renglón mensual agrega varias corridas y este cierre no lo puede ' +
          'retirar sin llevarse el pasivo de las demás: resuélvelo a mano antes de declarar.',
      });
    }

    for (const [taxType, importe, frecuencia, limite] of [
      ['imss_employer', aColumna(imssPropio.toFixed(4)), 'monthly', fechaLimiteDia17(c.period_end)],
      [
        'infonavit_employer',
        aColumna(infonavitPropio.toFixed(4)),
        'bimestral',
        fechaLimiteBimestral(c.period_end),
      ],
    ] as const) {
      if (new Decimal(importe).isZero()) continue;
      const fila: FilaPasivo = {
        tenantId, entityId, payRunId, taxType, jurisdiction: 'MX',
        periodStart: c.period_start, periodEnd: c.period_end, importe,
        fechaLimite: limite, frecuencia,
      };
      const r = await apuntarPorCorrida(client, fila);
      reubicados += r.reubicados;
      if (r.accion) renglones.push({ ...fila, accion: r.accion });
    }
  }

  // ---- ISN, uno por estado ----
  //
  // El ISN no lo gobierna `provision_cuotas_patronales`: esa política habla de
  // las cuotas de seguridad social. El ISN se apunta siempre con su corrida, y
  // lo que `isn_momento_de_causacion` mueve es EL MES al que pertenece — el
  // devengo lo manda al mes en que cierra el periodo; el pago, al mes en que
  // sale el dinero. Con un periodo que cruza el fin de mes, las dos respuestas
  // dan meses distintos, y por eso es una decisión del despacho y no del motor.
  const causacion = criterioCausacionIsn === 'pago' ? c.pay_date : c.period_end;
  const isnInicio = inicioDeMes(causacion);
  const isnFin = finDeMes(causacion);

  const { criterio: criterioEstadoIsn, criterioDefinido, bases } = await basesIsnDeCorrida({
    tenantId, entityId, payRunId, client,
  });
  const isn = await calcularIsn({
    bases,
    periodoInicio: c.period_start,
    periodoFin: c.period_end,
    fechaCausacion: causacion,
    client,
  });
  hallazgos.push(...isn.hallazgos);

  for (const r of isn.porEstado) {
    const importe = aColumna(r.importe);
    if (new Decimal(importe).isZero()) continue;
    const fila: FilaPasivo = {
      tenantId, entityId, payRunId,
      taxType: 'isn',
      // La jurisdicción lleva el estado, como 'US-CA' en el lado americano:
      // es lo que hace que dos estados sean dos renglones y no una suma.
      jurisdiction: `MX-${r.estado}`,
      periodStart: isnInicio, periodEnd: isnFin, importe,
      fechaLimite: fechaLimiteDia17(isnFin), frecuencia: 'monthly',
    };
    const r2 = await apuntarPorCorrida(client, fila);
    reubicados += r2.reubicados;
    if (r2.accion) renglones.push({ ...fila, accion: r2.accion });
  }

  // Un renglón que cambió de mes no es una duplicación evitada en silencio:
  // el pasivo del mes viejo baja y el del nuevo sube, y quien ya hubiera
  // mirado el calendario de vencimientos tiene que volver a mirarlo.
  if (reubicados > 0) {
    hallazgos.push({
      codigo: 'pasivo_reubicado_de_mes',
      severidad: 'aviso',
      periodo: `${c.period_start} a ${c.period_end}`,
      mensaje:
        `${reubicados} renglón(es) de pasivo de esta corrida cambiaron de mes en este cierre ` +
        'y el apunte anterior se retiró: la respuesta de `isn_momento_de_causacion` mueve el ' +
        'ISN al mes del devengo o al del pago, y dejar los dos habría duplicado el impuesto. ' +
        'Revisa las fechas límite del mes que se vació y del que se llenó.',
    });
  }

  const intactos = renglones.filter((r) => r.accion === 'intacto');
  if (intactos.length > 0) {
    hallazgos.push({
      codigo: 'pasivo_ya_depositado_no_se_toca',
      severidad: 'aviso',
      mensaje:
        `${intactos.length} renglón(es) de pasivo ya no están en 'pending' —depositados, ` +
        'dispensados o marcados como tardíos— y NO se reescribieron: ' +
        `${intactos.map((r) => `${r.taxType}/${r.jurisdiction}`).join(', ')}. ` +
        'Cambiarles el importe borraría la evidencia de lo que se pagó.',
    });
  }

  return {
    entityId,
    criterioProvision,
    provisionDefinida: pProvision.defined,
    criterioCausacionIsn,
    causacionIsnDefinida: pCausacion.defined,
    criterioEstadoIsn,
    estadoIsnDefinido: criterioDefinido,
    renglones,
    hallazgos,
  };
}

export { hallazgosQueBloquean };
export type { HallazgoNomina, CriterioEstadoIsn };
