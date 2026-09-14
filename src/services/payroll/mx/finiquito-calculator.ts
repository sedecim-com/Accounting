import { query } from '../../../database/connection.js';
import { NotFoundError, ValidationError } from '../../../utils/errors.js';
import { getPolicy, getPolicyNumber, exigirPisoLegal, type PolicyContext } from '../../policy/policy-service.js';
import {
  aFechaUtc,
  aniosDeServicioCumplidos,
  calcularFiniquito,
  diasDeVacacionesPorAnio,
  salarioDiarioDesdeSbc,
  salarioDiarioDesdeSueldoAnual,
  type DesgloseFiniquito,
  type MotivoDeBaja,
} from './finiquito-math.js';
import { getTaxParameters } from '../tax-engine/tax-tables.js';

// ============================================================
// MX — Finiquito (termination settlement)
// Pays accrued amounts: pending salary + proportional aguinaldo (year-end bonus) +
// proportional prima vacacional (vacation premium) + pending vacation days.
// Reference: LFT Art. 76, 79, 80, 87.
//
// ESTE ARCHIVO YA NO CALCULA NADA. Habla con Postgres y con el panel de
// políticas, y le pasa números resueltos a `finiquito-math.ts`. La aritmética
// se sacó de aquí en D1a porque estaba encerrada detrás de una conexión: para
// comprobar un tramo de la tabla del art. 76 había que sembrar un empleado, y
// por eso la tabla llevaba años pagando de menos sin que nadie lo notara.
// ============================================================

/** Los cuatro supuestos que el cálculo distingue, para validarlos en frontera. */
export const MOTIVOS_DE_BAJA: readonly MotivoDeBaja[] = [
  'renuncia',
  'despido',
  'rescision_por_el_trabajador',
  'muerte',
];

export interface FiniquitoInput {
  employee_id: string;
  termination_date: string;
  /**
   * POR QUÉ SE SEPARA. Obligatorio: decide si hay prima de antigüedad, que en
   * un trabajador antiguo es la prestación más grande del finiquito. La
   * renuncia la paga sólo con quince años cumplidos; el despido la paga
   * siempre, justificado o no (LFT art. 162 fr. III).
   */
  termination_reason: MotivoDeBaja;
  last_paid_through: string;
  pending_vacation_days?: number;
  // AQUÍ NO VA NINGÚN CRITERIO CONTABLE (T6 · #93).
  //
  // Hubo `aguinaldo_days_per_year` y `prima_vacacional_pct`, y su comentario
  // decía que sobrescribían el panel «cuando el llamador ya tiene el dato del
  // contrato». Ese llamador no existía: el único de producción es
  // `POST /finiquito`, que pasa `req.body` entero. O sea que el «llamador con
  // el dato del contrato» era el cliente HTTP, y cualquiera con
  // `payroll:create` fijaba por petición un porcentaje de prestación que NO
  // puede fijar en el panel —nada escribe `policy_decisions` por REST—, sin
  // autor, sin fecha, sin nota y sin fila. Medido: `prima_vacacional_pct: 25`
  // en el cuerpo pagaba 275.000,00 donde tocaban 2.750,00.
  //
  // No se validan como el panel: se van. Son la MISMA decisión que el panel ya
  // contesta, dicha por segunda vez y por un sitio donde no queda escrita, y
  // `basis` devuelve el valor sin su procedencia, así que dos finiquitos con
  // el mismo `basis` podían venir uno del criterio del despacho y otro del
  // teclado de quien llamó. Con ellos fuera, TODO valor llega a la aritmética
  // por `getPolicy`, y basta una guarda para las tres rutas.
  //
  // Lo que esto NO resuelve, y no se promete: la prestación pactada POR
  // EMPLEADO —30 días a un director en un despacho de 15— sigue sin dónde
  // vivir. Era el hueco que estos dos campos tapaban mal. Queda declarado.
}

/**
 * Los importes son CADENAS de cuatro decimales, no `number`.
 *
 * Lo anterior devolvía `Math.round(x * 100) / 100` sobre aritmética de coma
 * flotante. En un finiquito eso no es un redondeo de presentación: es lo que
 * se le deposita a una persona el día que se va.
 */
export interface FiniquitoResult {
  salary_pending_days: number;
  salary_pending_amount: string;
  aguinaldo_days: string;
  aguinaldo_amount: string;
  prima_vacacional_days: string;
  prima_vacacional_amount: string;
  vacation_pending_amount: string;
  /** Días de prima de antigüedad: 12 por año de servicio (LFT art. 162 fr. I). */
  seniority_premium_days: number;
  /** Base diaria ya topada por el art. 486, o null si no se pudo calcular. */
  seniority_premium_daily_base: string | null;
  seniority_premium_amount: string;
  /** Por qué vale lo que vale — o por qué no se pudo calcular. */
  seniority_premium_note: string;
  total: string;
  /** Cómo se llegó al número: qué antigüedad, qué tabla y qué salario diario. */
  basis: {
    years_of_service: number;
    service_year: number;
    vacation_days_art_76: number;
    daily_wage: string;
    daily_wage_source: 'annual_salary' | 'sbc_desintegrado';
    aguinaldo_days_per_year: number;
    prima_vacacional_pct: string;
    aguinaldo_days_worked: number;
  };
}

interface FilaEmpleado {
  sbc: string | null;
  hire_date: string | Date;
  annual_salary: string | null;
  entity_id: string | null;
}

export async function calculateFiniquito(
  input: FiniquitoInput,
  ctx: PolicyContext
): Promise<FiniquitoResult> {
  // El inquilino va DENTRO del SQL, no en un filtro posterior: la consulta
  // anterior buscaba por `id` a secas, así que un id adivinado devolvía el
  // empleado de otro despacho con su salario dentro.
  //
  // Y LA ENTIDAD TAMBIÉN (T9c · #96), que el inquilino no acota ese eje.
  // `employees` sí tiene `entity_id`, así que aquí no hace falta ningún
  // camino: basta la columna. Esta ruta es la que desmiente la regla fácil
  // —«con `requireEntityAccess` montado ya está»—: la guarda lleva aquí
  // desde D1a y aun así la sociedad hermana se liquidaba entera, sueldo
  // incluido, con sólo cambiar `x-entity-id`. La guarda valida la entidad
  // DECLARADA; acotar la consulta por ella es otra defensa, y hacen falta
  // las dos.
  //
  // Sin entidad en el contexto se acota sólo por inquilino, que es lo que
  // una `PolicyContext` sin `entityId` significa en toda la casa: «contéstame
  // por el despacho entero». Las rutas nunca llegan así — `requireEntityAccess`
  // las obliga a traerla.
  const porEntidad = ctx.entityId !== undefined;
  const result = await query<FilaEmpleado>(
    `SELECT sbc, hire_date, annual_salary, entity_id
       FROM employees
      WHERE id = $1 AND tenant_id = $2${porEntidad ? ' AND entity_id = $3' : ''}`,
    porEntidad
      ? [input.employee_id, ctx.tenantId, ctx.entityId]
      : [input.employee_id, ctx.tenantId]
  );
  if (result.rows.length === 0) throw new NotFoundError('Employee');
  const e = result.rows[0];

  // La entidad la manda el EMPLEADO, no la petición: una política contestada
  // por entidad tiene que regir a quien pertenece a esa entidad. Desde T9c
  // las dos ya no pueden discrepar cuando el contexto trae entidad —la
  // consulta se niega a devolver al empleado de otra—, pero la fuente sigue
  // siendo la fila, no el token: es el orden correcto, no una coincidencia.
  const panel: PolicyContext = { tenantId: ctx.tenantId, entityId: e.entity_id ?? ctx.entityId };

  // EL PISO DE LA LEY SE COMPRUEBA CON LA FECHA DE LA BAJA, no con la de hoy.
  //
  // El panel es donde el despacho declara su criterio, y por encima del mínimo
  // ese criterio manda. Por DEBAJO no hay criterio que valga: `dias_aguinaldo
  // = 5` se aceptaba y el finiquito pagaba con cinco días, bajo los quince del
  // art. 87 LFT. La comprobación ENVUELVE la lectura en vez de ir detrás,
  // porque un valor que no pasa por ella no puede llegar a la aritmética.
  //
  // Y la fecha es la de la baja: recalcular una liquidación de 2019 contra el
  // mínimo de hoy da otra cifra, y contestar eso es para lo que la 080 le puso
  // vigencia a la ley. Es el mismo criterio con el que este archivo ya lee la
  // tarifa del ejercicio unas líneas más abajo.
  const diasAguinaldo = Number(
    await exigirPisoLegal(
      'dias_aguinaldo',
      String(await getPolicyNumber(panel, 'dias_aguinaldo')),
      input.termination_date
    )
  );
  const primaPct = await exigirPisoLegal(
    'prima_vacacional_pct',
    (await getPolicy(panel, 'prima_vacacional_pct')).value,
    input.termination_date
  );

  // La tabla del art. 76 hace falta ANTES del salario: el factor de
  // integración se arma con los días de vacaciones del año en curso.
  const cumplidos = aniosDeServicioCumplidos(
    aFechaUtc(e.hire_date),
    aFechaUtc(input.termination_date)
  );
  const diasVacaciones = diasDeVacacionesPorAnio(cumplidos + 1);

  // EL SALARIO DIARIO, NO EL INTEGRADO.
  //
  // El orden estaba invertido: se prefería el SBC y sólo se caía al salario
  // contratado si faltaba. El SBC es el salario diario INTEGRADO —lleva dentro
  // el aguinaldo y la prima prorrateados, porque es la base de las cuotas del
  // IMSS (LSS art. 27)—, así que el aguinaldo se calculaba sobre una base
  // inflada: aguinaldo sobre el aguinaldo. Para prestaciones de la LFT rige el
  // salario diario, y el salario contratado es el único que lo dice sin
  // reconstruirlo.
  const prestaciones = {
    dias_aguinaldo: diasAguinaldo,
    dias_vacaciones: diasVacaciones,
    prima_vacacional_pct: primaPct,
  };
  let salarioDiario: string;
  let fuente: FiniquitoResult['basis']['daily_wage_source'];
  if (e.annual_salary) {
    // El divisor ya no vive aquí: lo fija `salarioDiarioDesdeSueldoAnual` en el
    // módulo puro, y lo comparte con el motor de provisiones de D1. Dos
    // divisores para la misma columna dejarían la 2196 con un residuo que el
    // finiquito nunca extingue — la razón completa está en la cabecera de esa
    // función.
    salarioDiario = salarioDiarioDesdeSueldoAnual(e.annual_salary);
    fuente = 'annual_salary';
  } else if (e.sbc) {
    // Respaldo: se des-integra para volver al salario diario. Aproximado —el
    // SBC está topado en 25 UMA— y por eso el resultado dice de dónde salió.
    salarioDiario = salarioDiarioDesdeSbc(e.sbc, prestaciones);
    fuente = 'sbc_desintegrado';
  } else {
    salarioDiario = '0.0000';
    fuente = 'annual_salary';
  }

  // EL MÍNIMO CON EL QUE SE TOPA LA PRIMA, A LA FECHA DE LA BAJA.
  //
  // A la fecha de la baja y no a la de hoy: un finiquito de enero recalculado
  // en marzo tiene que seguir topándose con el mínimo de enero. Y del GENERAL,
  // porque este esquema todavía no guarda la zona donde se presta el trabajo
  // —el art. 486 mide el tope con el mínimo de esa zona— así que el desglose
  // deja dicho con cuál se calculó, en vez de callarlo.
  // EL TIPO NO ES UNA COMPROBACIÓN (WIT-02). `termination_reason` es
  // obligatorio en TypeScript, pero `POST /finiquito` pasa `req.body` tal cual:
  // una petición vieja o mal formada llega con el campo AUSENTE, y
  // `devengaPrimaDeAntiguedad(undefined, años)` lo lee como «no es renuncia» y
  // concede la prima como si fuera un despido. Sobre el caso medido son
  // 113 414.40 pagados de más a quien renunció con menos de quince años.
  //
  // Se valida aquí y no en la ruta porque la cáscara es lo que TODOS los
  // llamadores atraviesan; la ruta sólo traduce el error a 4xx.
  if (!MOTIVOS_DE_BAJA.includes(input.termination_reason)) {
    throw new ValidationError(
      `termination_reason inválido o ausente: se esperaba ${MOTIVOS_DE_BAJA.join(', ')}. ` +
      'Decide si hay prima de antigüedad, que en un trabajador antiguo es la prestación más ' +
      'grande del finiquito, así que no tiene valor por omisión.'
    );
  }

  const anioBaja = new Date(input.termination_date).getUTCFullYear();
  const params = await getTaxParameters('MX', anioBaja, input.termination_date);
  const minimoGeneral = params.salario_minimo_general_diario;
  const salarioMinimo =
    typeof minimoGeneral === 'number' || typeof minimoGeneral === 'string'
      ? String(minimoGeneral)
      : undefined;

  const d: DesgloseFiniquito = calcularFiniquito({
    fecha_alta: e.hire_date,
    fecha_baja: input.termination_date,
    pagado_hasta: input.last_paid_through,
    salario_diario: salarioDiario,
    dias_vacaciones_pendientes: input.pending_vacation_days ?? 0,
    dias_aguinaldo_por_anio: diasAguinaldo,
    prima_vacacional_pct: primaPct,
    motivo_baja: input.termination_reason,
    salario_minimo_diario: salarioMinimo,
  });

  return {
    salary_pending_days: d.salario_pendiente_dias,
    salary_pending_amount: d.salario_pendiente_importe,
    aguinaldo_days: d.aguinaldo_dias,
    aguinaldo_amount: d.aguinaldo_importe,
    prima_vacacional_days: d.prima_vacacional_dias,
    prima_vacacional_amount: d.prima_vacacional_importe,
    vacation_pending_amount: d.vacaciones_pendientes_importe,
    seniority_premium_days: d.prima_antiguedad_dias,
    seniority_premium_daily_base: d.prima_antiguedad_base_diaria,
    seniority_premium_amount: d.prima_antiguedad_importe,
    seniority_premium_note: d.prima_antiguedad_nota,
    total: d.total,
    basis: {
      years_of_service: d.antiguedad_anios_cumplidos,
      service_year: d.anio_de_servicio_en_curso,
      vacation_days_art_76: d.dias_vacaciones_del_anio,
      daily_wage: d.salario_diario,
      daily_wage_source: fuente,
      aguinaldo_days_per_year: diasAguinaldo,
      prima_vacacional_pct: primaPct,
      aguinaldo_days_worked: d.aguinaldo_dias_trabajados,
    },
  };
}
