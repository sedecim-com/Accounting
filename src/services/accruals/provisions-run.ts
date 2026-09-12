import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, withTransaction } from '../../database/connection.js';
import { createJournalEntry, attestEntryAsync } from '../accounting/posting.js';
import {
  periodoDeLaCorrida,
  type PeriodoDeCorrida,
} from '../accounting/periodo-de-corrida.js';
import { getPolicy, getPolicyNumber, exigirPisoLegal } from '../policy/policy-service.js';
import { ValidationError } from '../../utils/errors.js';
import { JournalEntryType, FiscalPeriodStatus } from '../../types/index.js';
import { salarioDiarioDesdeSueldoAnual } from '../payroll/mx/finiquito-math.js';
import { RENGLON_VIGENTE, inquilinoDeLaEntidad } from './prepaid-service.js';
import {
  calcularProvisionMensual,
  esBaseSalarial,
  esConvencionDeVacaciones,
  esProvisionCero,
  type BaseSalarial,
  type ConvencionVacaciones,
  type ProvisionMensual,
} from './provisions-math.js';

// ============================================================
// LA CORRIDA MENSUAL DE PROVISIONES DE PRESTACIONES (D1 · NIF D-3)
//
// UN DESPACHO QUE PAGA EL AGUINALDO EN DICIEMBRE Y NO LO PROVISIONA durante el
// año publica once meses de utilidad inflada y un diciembre catastrófico, y
// ninguno de los doce estados es firmable. La NIF D-3 reconoce el beneficio
// directo a corto plazo CONFORME EL TRABAJADOR PRESTA EL SERVICIO: el pasivo
// nace el día trabajado, no el día del pago.
//
// La aritmética vive en `provisions-math.ts` y no toca Postgres a propósito —el
// mes del aniversario partido en dos escalones del art. 76, el denominador del
// año bisiesto, la baja a mitad de mes: mil maneras de equivocarse que ninguna
// prueba de integración vería—. Aquí queda lo que SÓLO se puede hacer contra la
// base: leer la nómina real, resolver las cuentas por rol, postear un asiento y
// dejar escrito de quién es cada peso del pasivo.
//
// ── LO QUE HACE DIFERENTE A ESTA CORRIDA ────────────────────────────────
//
// UN SOLO ASIENTO POR CORRIDA, no uno por trabajador. La amortización postea un
// asiento por anticipo porque cada anticipo es un contrato con su propia
// cuenta de gasto; aquí una plantilla de doscientas personas produciría
// doscientos asientos idénticos en fecha y concepto, y el mayor de diciembre
// sería ilegible. El desglose por persona es la cédula
// (`benefit_provision_schedules`), y todas las filas del mes apuntan al mismo
// asiento.
//
// EL PANEL SE LEE PARA APLICAR, NO PARA ANOTAR — al revés que en la
// amortización. Allí la convención se congela en el alta del anticipo porque
// recortar de otra manera un calendario cuyos primeros meses ya están posteados
// dejaría el total sin cuadrar. Aquí no hay calendario que recortar: cada mes es
// un devengo nuevo y completo, así que el panel gobierna desde el día en que se
// contesta y los meses ya posteados no se tocan (el mayor es inmutable, 041).
// Lo que sí se hereda de allí es la obligación de ANOTAR con qué se calculó:
// `calculation_metadata` lleva la base salarial, la convención y los tramos, y
// sin eso el importe es un número que nadie puede reconstruir.
//
// ── LO QUE ESTA CORRIDA NO HACE, Y ESTÁ DECLARADO ───────────────────────
//
//   · LA PTU. La política `provision_ptu_mensual` existe y por omisión está
//     APAGADA. La 2205 no se toca, y el resultado lo DICE: un cero silencioso y
//     una ausencia declarada no son lo mismo. Y si el panel la enciende, esta
//     corrida sigue sin tocarla y lo dice más fuerte todavía —la PTU es el 10 %
//     de la renta gravable DE LA ENTIDAD (LFT 120), no una proporción del
//     salario de una persona: no hay prorrateo por trabajador que la ley mande,
//     y fabricar uno sería inventar el pasivo—.
//   · LA PRIMA DE ANTIGÜEDAD (LFT 162). Beneficio por terminación de largo
//     plazo que la NIF D-3 manda valuar ACTUARIALMENTE. Está declarada fuera de
//     alcance en `ai/docs/nif-registro.md` y no tiene ni cuenta ni línea aquí.
//   · DESCONTAR LOS DÍAS DE SUSPENSIÓN O DE PERMISO SIN GOCE. No es una
//     omisión de criterio: el esquema no guarda las FECHAS de una incapacidad
//     ni de un permiso —`employees.status` dice 'on_leave' y no desde cuándo—,
//     así que no hay dato con el que descontarlos. Se devenga por relación viva,
//     y el día que el esquema guarde esas fechas, la bifurcación es del panel.
//
// TODA LECTURA Y ESCRITURA ACOTADA POR ENTIDAD DENTRO DEL SQL, y además en las
// foráneas compuestas de la 079: el esquema es la segunda línea, no la primera.
// ============================================================

/** El nombre de esta corrida en los mensajes de error del periodo. */
const MOTOR = 'provisiones de prestaciones';

/**
 * 'YYYY-MM-DD' desde los componentes LOCALES del `Date`.
 *
 * Los `Date` de este módulo vienen de `medianocheLocal`, así que sus
 * componentes locales SON el día que la columna DATE guardaba. Leerlos con
 * `toISOString()` los convertiría a UTC y correría la fecha un día entero en
 * cualquier huso al oeste de Greenwich, que es donde está México.
 */
function fechaISO(f: Date): string {
  const mes = String(f.getMonth() + 1).padStart(2, '0');
  const dia = String(f.getDate()).padStart(2, '0');
  return `${f.getFullYear()}-${mes}-${dia}`;
}

/**
 * LOS ROLES, QUE ES COMO SE NOMBRAN LAS CUENTAS AQUÍ.
 *
 * Un `'2202'` literal en este archivo sería un defecto: el catálogo de un
 * despacho que llegó con su propia numeración no tiene por qué usar esos
 * códigos, y el mapa de roles es justo la capa que traduce. Los cuatro se
 * siembran en `account-roles-seed.ts` para toda entidad mexicana.
 */
const ROL_GASTO = 'provision_prestaciones_gasto';
const ROL_AGUINALDO = 'provision_aguinaldo';
const ROL_VACACIONES = 'provision_vacaciones';
const ROL_PRIMA = 'provision_prima_vacacional';

export interface CuentasDeProvision {
  gasto: string;
  aguinaldo: string;
  vacaciones: string;
  prima_vacacional: string;
}

/**
 * Las cuatro cuentas, POR ROL y acotadas por entidad.
 *
 * SE EXIGEN LAS CUATRO AUNQUE EL MES SÓLO MUEVA UNA, y no es rigidez. Bajo la
 * convención `aniversario` las vacaciones valen cero once meses de cada doce:
 * pedir sólo las cuentas de los conceptos con importe dejaría que una entidad
 * a la que le falta la 2203 corriera once meses en verde y reventara en el
 * duodécimo, que es el peor momento posible para descubrirlo. Fallar el primer
 * día y decir qué falta es más barato que fallar en el cierre anual.
 *
 * SE EXPORTA PARA LA VISTA PREVIA de `payroll accrue`, no por comodidad: un
 * asiento que se enseña con UUIDs no se puede revisar, y una segunda consulta
 * de roles escrita en el CLI sería una segunda definición de «las cuatro
 * cuentas del devengo» —la que se enseña y la que se postea— con licencia para
 * divergir. La previa pregunta lo mismo que la corrida, y falla con el mismo
 * mensaje si falta un rol.
 */
export async function cuentasDeProvisiones(entityId: string): Promise<CuentasDeProvision> {
  const roles = [ROL_GASTO, ROL_AGUINALDO, ROL_VACACIONES, ROL_PRIMA];
  const r = await query<{ role: string; account_id: string }>(
    `SELECT role, account_id FROM account_roles
      WHERE entity_id = $1 AND role = ANY($2) AND qualifier IS NULL`,
    [entityId, roles]
  );
  const mapa = new Map(r.rows.map((f) => [f.role, f.account_id]));
  const faltan = roles.filter((rol) => !mapa.has(rol));
  if (faltan.length > 0) {
    throw new ValidationError(
      `No hay cuenta mapeada a ${faltan.length === 1 ? 'el rol' : 'los roles'} ` +
        `${faltan.map((f) => `"${f}"`).join(', ')} en esta entidad, así que la provisión de ` +
        'prestaciones no tiene dónde escribirse. Siémbralas con: mnemosine init --section ' +
        'identity (o revisa qué falta con: mnemosine doctor).'
    );
  }
  return {
    gasto: mapa.get(ROL_GASTO) as string,
    aguinaldo: mapa.get(ROL_AGUINALDO) as string,
    vacaciones: mapa.get(ROL_VACACIONES) as string,
    prima_vacacional: mapa.get(ROL_PRIMA) as string,
  };
}

// ============================================================
// El panel, resuelto una vez por corrida
// ============================================================

export interface CriteriosDeProvision {
  base_salarial: BaseSalarial;
  convencion_vacaciones: ConvencionVacaciones;
  dias_aguinaldo: number;
  prima_vacacional_pct: string;
  /** Lo que dice hoy `provision_ptu_mensual`: 'no' (omisión) o 'si'. */
  ptu_mensual: string;
  /** Qué claves están contestadas de verdad y cuáles corren por omisión. */
  definidas: Record<string, boolean>;
}

/**
 * LAS CINCO CLAVES QUE GOBIERNAN EL IMPORTE, LEÍDAS UNA SOLA VEZ.
 *
 * Por corrida y no por trabajador: son decisiones de la entidad, y releerlas
 * doscientas veces no sólo cuesta doscientas consultas —abre la puerta a que
 * una corrida larga use dos criterios distintos si alguien contesta el panel a
 * la mitad, y entonces el asiento no diría con qué se calculó—.
 *
 * UN VALOR FUERA DEL VOCABULARIO DETIENE LA CORRIDA ENTERA, no cae al valor por
 * omisión. Elegir en silencio la otra base salarial es lo que hace que un
 * pasivo equivocado se descubra un año después: entre `nominal` e `integrado`
 * hay un 20 % de diferencia en el importe de cada mes.
 */
export async function criteriosDeLaProvision(
  tenantId: string,
  entityId: string,
  /**
   * La fecha del HECHO, para comprobar el piso de la ley (T6 · #93). Es el
   * cierre del periodo que se devenga, no hoy: una corrida de un mes viejo se
   * mide contra la ley que regía ese mes.
   */
  enFecha: string
): Promise<CriteriosDeProvision> {
  const ctx = { tenantId, entityId };
  const base = await getPolicy(ctx, 'provision_base_salarial');
  if (!esBaseSalarial(base.value)) {
    throw new ValidationError(
      `La política provision_base_salarial vale "${base.value}", que no es ninguna de las ` +
        'declaradas (nominal, integrado). Ningún importe se puede calcular con ella, y elegir ' +
        'una en silencio movería la provisión de todos los meses.'
    );
  }
  const convencion = await getPolicy(ctx, 'devengo_vacaciones');
  if (!esConvencionDeVacaciones(convencion.value)) {
    throw new ValidationError(
      `La política devengo_vacaciones vale "${convencion.value}", que no es ninguna de las ` +
        'declaradas (proporcional, aniversario).'
    );
  }
  const ptu = await getPolicy(ctx, 'provision_ptu_mensual');
  // EL PISO DE LA LEY TAMBIÉN AQUÍ, y no es redundante con el finiquito: éste
  // es el único camino de estas dos claves que ESCRIBE EN LOS LIBROS, y postea
  // solo. Blindar el finiquito y dejar esto abierto sería acreditar al mayor un
  // aguinaldo ilegal mes tras mes, en silencio.
  const primaCruda = await getPolicy(ctx, 'prima_vacacional_pct');
  const prima = { ...primaCruda, value: await exigirPisoLegal('prima_vacacional_pct', primaCruda.value, enFecha) };
  const dias = Number(
    await exigirPisoLegal('dias_aguinaldo', String(await getPolicyNumber(ctx, 'dias_aguinaldo')), enFecha)
  );

  return {
    base_salarial: base.value,
    convencion_vacaciones: convencion.value,
    dias_aguinaldo: dias,
    prima_vacacional_pct: prima.value,
    ptu_mensual: ptu.value,
    definidas: {
      provision_base_salarial: base.defined,
      devengo_vacaciones: convencion.defined,
      dias_aguinaldo: (await getPolicy(ctx, 'dias_aguinaldo')).defined,
      prima_vacacional_pct: prima.defined,
      provision_ptu_mensual: ptu.defined,
    },
  };
}

// ============================================================
// La plantilla que devenga
// ============================================================

export interface TrabajadorParaProvision {
  id: string;
  employee_number: string;
  nombre: string;
  hire_date: Date;
  termination_date: Date | null;
  status: string;
  annual_salary: string | null;
  sbc: string | null;
}

/**
 * LOS TRABAJADORES QUE PUDIERON DEVENGAR ALGO EN ESTE PERIODO.
 *
 * El recorte va DENTRO del SQL y por tres razones distintas:
 *
 *   · `entity_id`: la frontera, que en este proyecto no se delega a un filtro
 *     posterior ni a la foránea.
 *   · `country_code = 'MX'`: el aguinaldo (LFT 87) y la prima vacacional (80)
 *     son prestaciones de la ley mexicana. Una entidad con nómina mixta existe
 *     —el módulo de nómina tiene carril MX y carril US—, y provisionar
 *     aguinaldo a un empleado de Texas sería inventarle un pasivo al patrón.
 *   · Las fechas: quien todavía no entra y quien ya salió no devengan. Se hace
 *     aquí y no en la aritmética para no traerse la plantilla histórica entera
 *     de un despacho con veinte años de rotación.
 *
 * `status` NO filtra. Un 'terminated' con `termination_date` dentro del mes SÍ
 * devengó los días que trabajó, y un 'on_leave' sigue teniendo relación viva.
 * El único caso que el motor rechaza —arriba, con nombre— es el 'terminated'
 * SIN fecha de baja: es una ficha incoherente, y devengarle el mes entero le
 * seguiría cargando pasivo al patrón por alguien que ya no está.
 */
export async function plantillaQueDevenga(
  entityId: string,
  periodo: PeriodoDeCorrida
): Promise<TrabajadorParaProvision[]> {
  const r = await query<TrabajadorParaProvision>(
    `SELECT e.id,
            e.employee_number,
            TRIM(CONCAT_WS(' ', e.first_name, e.last_name)) AS nombre,
            e.hire_date,
            e.termination_date,
            e.status,
            e.annual_salary::text AS annual_salary,
            e.sbc::text AS sbc
       FROM employees e
      WHERE e.entity_id = $1
        AND e.country_code = 'MX'
        AND e.hire_date <= $3::date
        AND (e.termination_date IS NULL OR e.termination_date >= $2::date)
      ORDER BY e.employee_number`,
    // CADENAS 'YYYY-MM-DD', NO `Date`. Comparar una columna DATE contra un
    // `Date` de JavaScript la promueve a timestamptz a medianoche LOCAL del
    // cliente, y con el servidor en UTC ese instante cae a las 06:00 del mismo
    // día: la baja del día 1 del mes salía FUERA del `>=` y el trabajador que
    // se fue ese día perdía el día que sí trabajó. Una cadena de fecha no tiene
    // hora y no puede desplazarse.
    [entityId, fechaISO(periodo.inicio), fechaISO(periodo.fin)]
  );
  return r.rows;
}

// ============================================================
// El resultado
// ============================================================

/**
 * LA AUSENCIA DE LA PTU, DECLARADA.
 *
 * Este objeto existe para que la corrida no pueda callarse sobre la 2205. Un
 * resultado que simplemente no la mencionara sería indistinguible de una
 * corrida que la provisionó en cero, y son dos hechos distintos: uno es «no
 * toca» y el otro es «tocaba y salió cero».
 */
export interface DeclaracionDePtu {
  /** Lo que dice hoy la política `provision_ptu_mensual`. */
  panel: string;
  /** ¿El despacho la encendió? Por omisión, no. */
  encendida: boolean;
  /** Siempre false: este motor no la calcula. Ver `nota`. */
  provisionada: false;
  /** Siempre false: la 2205 no aparece en el asiento. */
  cuenta_tocada: false;
  nota: string;
}

export interface ResultadoDeProvisiones {
  /** Trabajadores con renglón escrito y posteado en esta corrida. */
  processed: number;
  /** Sin devengo en el mes, o con el mes ya corrido. */
  skipped: number;
  /** Total abonado a las tres provisiones. String, como todo el dinero. */
  total: string;
  errors: string[];
  /** Desglose por concepto, para que el resultado cuadre con el asiento. */
  aguinaldo: string;
  vacaciones: string;
  prima_vacacional: string;
  /** El asiento único de la corrida. `null` si no había nada que postear. */
  journalEntryId: string | null;
  ptu: DeclaracionDePtu;
  criterios: CriteriosDeProvision;
}

/**
 * SE EXPORTA PARA QUE LA HOJA LA DIGA ANTES, no sólo después.
 *
 * El resultado de la corrida ya llevaba esta declaración, pero un operador que
 * la lee cuando el asiento ya está posteado la lee tarde: la pregunta «¿y la
 * PTU?» se hace mirando el ensayo. La nota viaja desde aquí y no se reescribe
 * en el CLI porque es una afirmación LEGAL —por qué la 2205 no se toca— y dos
 * copias de una afirmación legal divergen el día que alguien retoque una.
 */
export function declararPtu(panel: string): DeclaracionDePtu {
  const encendida = panel === 'si';
  return {
    panel,
    encendida,
    provisionada: false,
    cuenta_tocada: false,
    nota: encendida
      ? 'La política provision_ptu_mensual está ENCENDIDA y esta corrida NO ha provisionado ' +
        'PTU: la cuenta de Provisión de PTU queda intacta. No es un olvido — la PTU es el 10 % ' +
        'de la renta gravable DE LA ENTIDAD (LFT art. 120), no una proporción del salario de ' +
        'cada trabajador, así que no se puede prorratear por persona ni por días trabajados. ' +
        'Necesita una estimación de la utilidad fiscal del ejercicio, que es otro módulo. ' +
        'Mientras tanto, la PTU del ejercicio se reconoce al cierre.'
      : 'La política provision_ptu_mensual está en «no» (el valor por omisión): la PTU se ' +
        'reconoce al cierre del ejercicio, cuando la renta gravable existe, y esta corrida no ' +
        'toca la cuenta de Provisión de PTU.',
  };
}

// ============================================================
// La cédula, calculada antes de que exista el asiento
// ============================================================

/** De dónde salió la base diaria de un trabajador, tal como la anota la cédula. */
export interface SalaryOfRecord {
  diario: string | undefined;
  sbc: string | undefined;
  fuente: string;
}

/** Un trabajador que SÍ devenga este mes, con su importe ya calculado. */
export interface ProvisionPlanRow {
  worker: TrabajadorParaProvision;
  provision: ProvisionMensual;
  salary: SalaryOfRecord;
}

/** Un trabajador que no entra, y por cuál de las dos razones legítimas. */
export interface ProvisionPlanSkip {
  worker: TrabajadorParaProvision;
  /**
   * `already-accrued`: ya tiene renglón vigente de este mes, y lo frena la
   * misma consulta que frena la doble corrida. `zero-month`: la aritmética dio
   * cero —once meses de cada doce bajo la convención `aniversario`, o una ficha
   * en salario cero—, y un renglón que documenta que no pasó nada no documenta
   * nada.
   */
  reason: 'already-accrued' | 'zero-month';
}

export interface ProvisionPlan {
  /** El inquilino de la entidad, resuelto una vez y reutilizado por la corrida. */
  tenantId: string;
  periodo: PeriodoDeCorrida;
  criterios: CriteriosDeProvision;
  rows: ProvisionPlanRow[];
  skipped: ProvisionPlanSkip[];
  /** Un renglón por trabajador cuya ficha impide calcularle el devengo. */
  errors: string[];
  aguinaldo: string;
  vacaciones: string;
  prima_vacacional: string;
  total: string;
}

/**
 * LA CÉDULA DEL MES, CALCULADA SIN ESCRIBIR UNA SOLA FILA.
 *
 * Existe porque el mayor es inmutable (041): un devengo que sólo se puede
 * mirar DESPUÉS de postearlo obliga a reversar para revisarlo, y una reversa
 * deja dos asientos más en un libro que nadie limpia. `payroll accrue
 * --dry-run` enseña esto —quién devenga, cuántos días y cuánto por concepto—
 * y no toca la base.
 *
 * Y ES LA MISMA FUNCIÓN QUE USA LA CORRIDA, no una copia suya. El motor gemelo
 * dejó escrito el defecto que aquí se evita: la hoja de la amortización arma su
 * previa con las funciones puras del motor y reconoce que «queda un cálculo
 * repetido», de modo que la previa y la corrida pueden separarse en silencio y
 * hay que compararlas al final para enterarse. Aquí no hay dos bucles:
 * `runMonthlyProvisions` llama a éste y postea exactamente lo que éste
 * devuelve. Lo único que un ensayo no puede prometer es que el mundo no cambie
 * entre mirar y postear —alguien da de alta a un trabajador, alguien contesta
 * el panel—, y de eso se ocupa la hoja comparando al terminar.
 *
 * LAS GUARDAS SE QUEDAN AQUÍ Y NO EN EL TECLADO. El periodo 13 se rechaza y la
 * plantilla vacía devuelve una cédula vacía: son reglas del devengo, no de la
 * terminal, y volver a escribirlas en el CLI es exactamente cómo dos copias de
 * una regla acaban diciendo cosas distintas.
 */
export async function planMonthlyProvisions(
  entityId: string,
  fiscalPeriodId: string
): Promise<ProvisionPlan> {
  const errors: string[] = [];
  const skipped: ProvisionPlanSkip[] = [];
  const rows: ProvisionPlanRow[] = [];
  let aguinaldo = new Decimal(0);
  let vacaciones = new Decimal(0);
  let prima = new Decimal(0);

  const periodo = await periodoDeLaCorrida(entityId, fiscalPeriodId, MOTOR);
  const tenantId = await inquilinoDeLaEntidad(entityId);
  const criterios = await criteriosDeLaProvision(tenantId, entityId, fechaISO(periodo.fin));

  const cerrar = (): ProvisionPlan => ({
    tenantId,
    periodo,
    criterios,
    rows,
    skipped,
    errors,
    aguinaldo: aguinaldo.toFixed(4),
    vacaciones: vacaciones.toFixed(4),
    prima_vacacional: prima.toFixed(4),
    total: aguinaldo.plus(vacaciones).plus(prima).toFixed(4),
  });

  // EL PERIODO 13 NO ES UN MES DE OPERACIÓN.
  //
  // El calendario admite un periodo 13 de ajustes (CHECK de la 001) y sus
  // fechas se solapan con las de diciembre o se reducen al 31. Devengar ahí
  // volvería a contar días que el periodo 12 ya provisionó, y el pasivo saldría
  // duplicado sin que el balance dejara de cuadrar —la forma exacta del defecto
  // que este tramo vino a cerrar—. Los ajustes anuales caben en el periodo 13;
  // el devengo mes a mes, no.
  //
  // SE RECHAZA TAMBIÉN EN EL ENSAYO, y a propósito: un `--dry-run` que
  // enseñara la cédula de un periodo sobre el que la corrida se va a negar le
  // enseñaría al operador un mes que no va a existir.
  if (periodo.tipo !== 'regular') {
    throw new ValidationError(
      `El periodo "${periodo.nombre}" es de tipo "${periodo.tipo}", no un mes de operación. La ` +
        'provisión de prestaciones se devenga por días trabajados, y correrla sobre un periodo ' +
        'de ajuste volvería a contar los días que su mes de calendario ya provisionó.'
    );
  }

  // UN MES CERRADO TAMPOCO ES UN MES DE OPERACIÓN, Y POR LA MISMA RAZÓN.
  //
  // El rechazo del mes cerrado vive en `validateJournalEntry` (regla
  // `periodStatus`), que sólo corre DENTRO de `createJournalEntry`. Es decir,
  // sólo en la corrida: el ensayo no postea, así que nunca llegaba a la regla y
  // salía 0 de un mes en el que la corrida sale 4. Es exactamente la misma
  // divergencia que este tramo cerró para la ficha rota, por otra puerta —y la
  // guarda de arriba ya dice por qué no se tolera: «un `--dry-run` que enseñara
  // la cédula de un periodo sobre el que la corrida se va a negar le enseñaría
  // al operador un mes que no va a existir».
  //
  // Se bloquea EXACTAMENTE en los dos estados que `periodStatus` trata como
  // error, ni uno más: `soft_close` y `future` sólo levantan advertencia allí y
  // el asiento SÍ se postea, así que negarse aquí sería negar un mes que la
  // corrida habría devengado —la divergencia al revés—.
  if (
    periodo.estado === FiscalPeriodStatus.HARD_CLOSE ||
    periodo.estado === FiscalPeriodStatus.LOCKED
  ) {
    throw new ValidationError(
      `El periodo "${periodo.nombre}" está en "${periodo.estado}" y el mayor no admite asientos ` +
        'ahí, así que la provisión no se puede escribir. Reabre el periodo si el devengo de ese ' +
        'mes falta de verdad; si ya se devengó antes de cerrarlo, no hay nada que hacer.'
    );
  }

  const plantilla = await plantillaQueDevenga(entityId, periodo);
  // SIN TRABAJADORES NO HAY NADA QUE POSTEAR. Un asiento en cero —o peor, un
  // asiento de una sola línea que no cuadra— es ruido en el mayor, y la
  // ausencia se lee igual de bien en una cédula sin renglones. La consulta de
  // roles ni siquiera se hace: una entidad sin nómina mexicana no tiene por qué
  // fallar por unas cuentas que no va a usar.
  if (plantilla.length === 0) return cerrar();

  // El freno de doble corrida, resuelto de una sola consulta para todo el mes.
  const yaCorridos = await trabajadoresYaProvisionados(entityId, periodo.id);

  for (const t of plantilla) {
    const etiqueta = `${t.employee_number} ${t.nombre}`.trim();
    try {
      if (yaCorridos.has(t.id)) {
        skipped.push({ worker: t, reason: 'already-accrued' });
        continue;
      }
      if (t.status === 'terminated' && !t.termination_date) {
        throw new ValidationError(
          'su ficha dice «terminated» y no tiene fecha de baja: no hay manera de saber hasta ' +
            'qué día devengó, y suponer el mes entero le carga al patrón un pasivo por alguien ' +
            'que ya no está.'
        );
      }
      const salary = salarioDelTrabajador(t);
      const provision = calcularProvisionMensual({
        fecha_alta: t.hire_date,
        fecha_baja: t.termination_date,
        periodo: { inicio: periodo.inicio, fin: periodo.fin },
        salario_diario: salary.diario,
        sbc: salary.sbc,
        dias_aguinaldo_por_anio: criterios.dias_aguinaldo,
        prima_vacacional_pct: criterios.prima_vacacional_pct,
        base_salarial: criterios.base_salarial,
        convencion_vacaciones: criterios.convencion_vacaciones,
      });
      // UN MES EN CERO NO ES UNA FILA. Pasa de verdad y por dos motivos
      // legítimos: bajo la convención `aniversario`, once meses de cada doce; y
      // con una ficha en salario cero —un permiso sin goce, una captura a
      // medias—. Escribir la fila obligaría a levantar el CHECK
      // `provision_no_vacia` de la 079, y un renglón que documenta que no pasó
      // nada no documenta nada.
      if (esProvisionCero(provision)) {
        skipped.push({ worker: t, reason: 'zero-month' });
        continue;
      }
      rows.push({ worker: t, provision, salary });
      aguinaldo = aguinaldo.plus(provision.aguinaldo);
      vacaciones = vacaciones.plus(provision.vacaciones);
      prima = prima.plus(provision.prima_vacacional);
    } catch (err) {
      errors.push(`Trabajador ${etiqueta}: ${(err as Error).message}`);
    }
  }

  return cerrar();
}

// ============================================================
// La corrida
// ============================================================

/**
 * LA CORRIDA MENSUAL: un renglón de cédula por trabajador y UN asiento.
 *
 * Devuelve lo procesado y los errores por trabajador en vez de abortar entera:
 * una ficha sin salario capturado no puede impedir que los otros ciento noventa
 * y nueve devenguen, y el hueco se ve porque el trabajador sale nombrado en
 * `errors` y sin fila en la cédula.
 *
 * NO CALCULA NADA POR SU CUENTA: la cédula la arma `planMonthlyProvisions`, que
 * es la misma que enseña el ensayo de la hoja. Lo que queda aquí es lo único
 * que sólo la corrida hace: resolver las cuentas, postear el asiento y escribir
 * los renglones.
 */
export async function runMonthlyProvisions(
  entityId: string,
  fiscalPeriodId: string,
  userId: string
): Promise<ResultadoDeProvisiones> {
  const plan = await planMonthlyProvisions(entityId, fiscalPeriodId);
  const { periodo, criterios, tenantId, errors } = plan;
  const skipped = plan.skipped.length;

  const vacio: ResultadoDeProvisiones = {
    processed: 0,
    skipped,
    total: '0.0000',
    errors,
    aguinaldo: '0.0000',
    vacaciones: '0.0000',
    prima_vacacional: '0.0000',
    journalEntryId: null,
    ptu: declararPtu(criterios.ptu_mensual),
    criterios,
  };

  // SIN NÓMINA QUE DEVENGAR NO SE POSTEA. Sin plantilla, todos omitidos, todos
  // en cero, o todos con ficha rota: en los cuatro casos el asiento sería de
  // importe cero.
  if (plan.rows.length === 0) return vacio;

  const renglones = plan.rows;
  const aguinaldo = new Decimal(plan.aguinaldo);
  const vacaciones = new Decimal(plan.vacaciones);
  const prima = new Decimal(plan.prima_vacacional);
  const total = new Decimal(plan.total);
  const cuentas = await cuentasDeProvisiones(entityId);

  const entryId = await withTransaction(async (client) => {
    // EL ASIENTO PRIMERO Y LAS FILAS DESPUÉS con su id: lo exige el CHECK
    // `provision_posteada_con_asiento` de la 079, y es el orden correcto — una
    // fila que dice estar en el mayor sin poder decir dónde es indistinguible
    // de una marcada a mano.
    //
    // ES UN ASIENTO DE AJUSTE ('adjusting') y no un tipo propio, por lo mismo
    // que la amortización: el vocabulario de `entry_type` lo fija un CHECK de la
    // 001, y contablemente un devengo de fin de mes ES un ajuste. Quien busque
    // estos asientos los encuentra por `source_type = 'benefit_provision'`, que
    // es más específico que cualquier tipo nuevo.
    //
    // LAS LÍNEAS EN CERO NO SE ESCRIBEN: los CHECK de `journal_entry_lines`
    // exigen importes estrictamente positivos, y bajo la convención
    // `aniversario` las vacaciones valen cero once meses de cada doce.
    const lineas = [
      {
        account_id: cuentas.gasto,
        debit_amount: total.toFixed(4),
        credit_amount: null,
        description: `Benefit provisions - ${renglones.length} employee(s)`,
      },
      ...(aguinaldo.isZero()
        ? []
        : [
            {
              account_id: cuentas.aguinaldo,
              debit_amount: null,
              credit_amount: aguinaldo.toFixed(4),
              description: 'Aguinaldo accrual (LFT art. 87)',
            },
          ]),
      ...(vacaciones.isZero()
        ? []
        : [
            {
              account_id: cuentas.vacaciones,
              debit_amount: null,
              credit_amount: vacaciones.toFixed(4),
              description: 'Vacation accrual (LFT art. 76)',
            },
          ]),
      ...(prima.isZero()
        ? []
        : [
            {
              account_id: cuentas.prima_vacacional,
              debit_amount: null,
              credit_amount: prima.toFixed(4),
              description: 'Vacation premium accrual (LFT art. 80)',
            },
          ]),
    ];

    const je = await createJournalEntry(
      entityId,
      // La fecha es la del PERIODO QUE SE CORRE, el último día: el devengo es
      // de mes cerrado. `createJournalEntry` deduce el periodo fiscal DE LA
      // FECHA, así que cualquier otra colgaría el asiento de otro periodo que
      // el de su propia cédula (defecto B de F06a).
      periodo.fin,
      JournalEntryType.ADJUSTING,
      `Benefit provisions ${periodo.nombre}`,
      lineas,
      userId,
      // Mismo client: el asiento y las N filas confirman —o abortan— juntos.
      {
        sourceType: 'benefit_provision',
        sourceId: fiscalPeriodId,
        autoPost: true,
        client,
      }
    );

    for (const r of renglones) {
      // EL RENGLÓN ANULADO SE RETIRA ANTES DE ESCRIBIR EL NUEVO.
      //
      // La UNIQUE (trabajador, periodo) dice —bien— que un mes es UNA fila.
      // Tras una reversa, la que hay documenta un devengo que ya no existe, y
      // sin quitarla la reposición chocaría contra la propia UNIQUE. No se
      // pierde nada: la historia completa está en el mayor, que sí es inmutable
      // (041) —el asiento, su espejo y el vínculo `reverses_entry_id` entre los
      // dos—. Lo que se borra es la copia de trabajo, no el hecho.
      //
      // La condición del espejo va DENTRO del DELETE: una fila vigente no se
      // toca aquí ni por una carrera entre dos corridas del mismo mes. Si la
      // hubiera, no se borra nada, la UNIQUE rechaza el INSERT y la transacción
      // entera se deshace, que es la respuesta correcta.
      await client.query(
        `DELETE FROM benefit_provision_schedules s
          USING journal_entries je
          WHERE s.employee_id = $1
            AND s.fiscal_period_id = $2
            AND s.entity_id = $3
            AND je.id = s.journal_entry_id
            AND (je.reversed_by_entry_id IS NOT NULL OR je.status <> 'posted')`,
        [r.worker.id, periodo.id, entityId]
      );

      // EL ALCANCE POR ENTIDAD DENTRO DEL SQL: el id del trabajador no entra
      // crudo al INSERT «porque la foránea ya lo validaba» —ésa es la frase de
      // la cuarta fuga—, sino que la fila sólo nace si el trabajador es de esta
      // entidad.
      const insercion = await client.query(
        `INSERT INTO benefit_provision_schedules (
           id, entity_id, employee_id, fiscal_period_id, provision_date,
           days_accrued, aguinaldo_amount, vacaciones_amount, prima_vacacional_amount,
           is_posted, journal_entry_id, calculation_metadata
         )
         SELECT $1, e.entity_id, e.id, $4, $5::date, $6, $7, $8, $9, true, $10, $11::jsonb
           FROM employees e
          WHERE e.id = $2 AND e.entity_id = $3`,
        [
          uuidv4(),
          r.worker.id,
          entityId,
          periodo.id,
          fechaISO(periodo.fin),
          r.provision.dias_devengados,
          r.provision.aguinaldo,
          r.provision.vacaciones,
          r.provision.prima_vacacional,
          je.id,
          JSON.stringify(
            metadatosDeProvision({
              provision: r.provision,
              criterios,
              salario: r.salary,
              periodo,
            })
          ),
        ]
      );
      if (insercion.rowCount !== 1) {
        throw new ValidationError(
          `El trabajador ${r.worker.employee_number} no es de esta entidad: no se escribió ` +
            'su renglón, y la corrida entera se deshace en vez de postear un asiento cuya cédula ' +
            'no cuadra.'
        );
      }
    }

    return je.id;
  });

  // Client del llamador significa atestiguación del llamador, DESPUÉS del
  // commit: la cadena tiene que ver datos confirmados.
  attestEntryAsync(tenantId, entityId, entryId);

  return {
    processed: renglones.length,
    skipped,
    total: total.toFixed(4),
    errors,
    aguinaldo: aguinaldo.toFixed(4),
    vacaciones: vacaciones.toFixed(4),
    prima_vacacional: prima.toFixed(4),
    journalEntryId: entryId,
    ptu: declararPtu(criterios.ptu_mensual),
    criterios,
  };
}

/**
 * EL FRENO DE DOBLE CORRIDA, DE UNA SOLA CONSULTA.
 *
 * Y SÓLO CUENTA FILAS VIGENTES. Con la pregunta a secas, revertir el asiento de
 * un mes lo dejaba bloqueado para siempre: la fila seguía ahí, el freno seguía
 * mordiendo, y el gasto que la reversa sacó del resultado no volvía nunca. Una
 * reversa es una corrección —la única que el mayor admite (041)—, no una
 * condena. `RENGLON_VIGENTE` se importa de `prepaid-service` en vez de
 * copiarse: es el MISMO invariante escrito sobre el alias `s`, y dos copias de
 * «vigente» pueden divergir el día que alguien añada un tercer estado.
 */
async function trabajadoresYaProvisionados(
  entityId: string,
  fiscalPeriodId: string
): Promise<Set<string>> {
  const r = await query<{ employee_id: string }>(
    `SELECT s.employee_id FROM benefit_provision_schedules s
      WHERE s.entity_id = $1 AND s.fiscal_period_id = $2
        AND ${RENGLON_VIGENTE}`,
    [entityId, fiscalPeriodId]
  );
  return new Set(r.rows.map((f) => f.employee_id));
}

/**
 * DE DÓNDE SALE LA BASE DIARIA, Y POR QUÉ NO SE INVENTA.
 *
 * `employees.annual_salary` es lo contratado y `employees.sbc` es el integrado
 * que conoce el IMSS. Se pasan LOS DOS a la aritmética cuando existen, porque
 * es ella quien sabe cuál usar según la política `provision_base_salarial`, y
 * quien reconstruye el que falte —des-integrando el SBC o integrando el
 * nominal—. Aquí sólo se convierte el sueldo anual a diario, y esa conversión
 * la hace `salarioDiarioDesdeSueldoAnual`, compartida con el finiquito: dos
 * divisores para la misma columna dejarían la provisión de doce meses sin
 * extinguir lo que el finiquito liquida.
 *
 * SIN NINGUNO DE LOS DOS, EL TRABAJADOR SE NOMBRA Y SE SALTA. Provisionar cero
 * en silencio por una ficha sin sueldo es exactamente el hueco que nadie
 * encuentra: la cuenta no cuadra al cierre y no hay pista de por qué.
 */
function salarioDelTrabajador(t: TrabajadorParaProvision): SalaryOfRecord {
  const diario =
    t.annual_salary !== null ? salarioDiarioDesdeSueldoAnual(t.annual_salary) : undefined;
  const sbc = t.sbc !== null ? new Decimal(t.sbc).toFixed(4) : undefined;
  if (diario === undefined && sbc === undefined) {
    throw new ValidationError(
      'su ficha no tiene sueldo anual ni salario base de cotización. Una provisión sin base es ' +
        'un pasivo inventado, y un cero en silencio es un hueco que sólo aparece al cierre.'
    );
  }
  return {
    diario,
    sbc,
    fuente:
      diario !== undefined && sbc !== undefined
        ? 'annual_salary+sbc'
        : diario !== undefined
          ? 'annual_salary'
          : 'sbc',
  };
}

/**
 * CON QUÉ SE CALCULÓ ESTE RENGLÓN.
 *
 * Va tal cual a `calculation_metadata`. No es telemetría: es lo que permite que
 * un auditor reconstruya el importe sin volver a correr el motor —los tramos
 * del mes con su escalón del art. 76, la base diaria de cada uno, y qué decía
 * el panel ese día—. El importe solo no explica por qué es ése, y el mayor es
 * inmutable: la explicación tiene que nacer con la fila o no nace.
 *
 * `politicas` guarda además si cada clave estaba CONTESTADA o corriendo por
 * omisión. La diferencia importa al leer un ejercicio viejo: «devengamos sobre
 * el nominal» y «nadie contestó y el sistema usó el nominal» son dos frases
 * distintas delante de un auditor.
 */
export function metadatosDeProvision(a: {
  provision: ProvisionMensual;
  criterios: CriteriosDeProvision;
  salario: SalaryOfRecord;
  periodo: PeriodoDeCorrida;
}): Record<string, unknown> {
  return {
    periodo: a.periodo.nombre,
    dias_devengados: a.provision.dias_devengados,
    base_salarial: a.provision.base_salarial,
    convencion_vacaciones: a.provision.convencion_vacaciones,
    salario_diario_contratado: a.salario.diario ?? null,
    sbc: a.salario.sbc ?? null,
    fuente_del_salario: a.salario.fuente,
    tramos: a.provision.tramos,
    politicas: {
      provision_base_salarial: {
        valor: a.criterios.base_salarial,
        definida: a.criterios.definidas.provision_base_salarial,
      },
      devengo_vacaciones: {
        valor: a.criterios.convencion_vacaciones,
        definida: a.criterios.definidas.devengo_vacaciones,
      },
      dias_aguinaldo: {
        valor: a.criterios.dias_aguinaldo,
        definida: a.criterios.definidas.dias_aguinaldo,
      },
      prima_vacacional_pct: {
        valor: a.criterios.prima_vacacional_pct,
        definida: a.criterios.definidas.prima_vacacional_pct,
      },
    },
    // LA PTU Y LA PRIMA DE ANTIGÜEDAD, DECLARADAS EN CADA FILA. Quien lea esta
    // cédula dentro de tres años tiene que poder ver que no se olvidaron: se
    // dejaron fuera, y por qué.
    fuera_de_alcance: {
      ptu: 'LFT 120: 10 % de la renta gravable de la entidad, no del salario de la persona.',
      prima_de_antiguedad:
        'LFT 162: beneficio por terminación de largo plazo, exige valuación actuarial (NIF D-3).',
    },
  };
}
