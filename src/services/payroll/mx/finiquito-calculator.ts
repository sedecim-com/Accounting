import Decimal from 'decimal.js';
import { query } from '../../../database/connection.js';
import { NotFoundError } from '../../../utils/errors.js';
import { getPolicy, getPolicyNumber, type PolicyContext } from '../../policy/policy-service.js';
import {
  aFechaUtc,
  aniosDeServicioCumplidos,
  calcularFiniquito,
  diasDeVacacionesPorAnio,
  salarioDiarioDesdeSbc,
  type DesgloseFiniquito,
} from './finiquito-math.js';

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

export interface FiniquitoInput {
  employee_id: string;
  termination_date: string;
  last_paid_through: string;
  pending_vacation_days?: number;
  /**
   * Sobrescriben el panel cuando el llamador ya tiene el dato del contrato.
   * Ausentes —el caso normal— se leen de `dias_aguinaldo` y
   * `prima_vacacional_pct`. Antes eran parámetros muertos: nadie los pasaba y
   * no había de dónde leerlos, así que los mínimos legales quedaban clavados
   * en el código aunque el despacho hubiera contestado otra cosa.
   */
  aguinaldo_days_per_year?: number;
  prima_vacacional_pct?: number;
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
  const result = await query<FilaEmpleado>(
    // El inquilino va DENTRO del SQL, no en un filtro posterior: la consulta
    // anterior buscaba por `id` a secas, así que un id adivinado devolvía el
    // empleado de otro despacho con su salario dentro.
    `SELECT sbc, hire_date, annual_salary, entity_id
       FROM employees
      WHERE id = $1 AND tenant_id = $2`,
    [input.employee_id, ctx.tenantId]
  );
  if (result.rows.length === 0) throw new NotFoundError('Employee');
  const e = result.rows[0];

  // La entidad la manda el EMPLEADO, no la petición: una política contestada
  // por entidad tiene que regir a quien pertenece a esa entidad, aunque la
  // llamada venga con otro alcance en el token.
  const panel: PolicyContext = { tenantId: ctx.tenantId, entityId: e.entity_id ?? ctx.entityId };

  const diasAguinaldo =
    input.aguinaldo_days_per_year ?? (await getPolicyNumber(panel, 'dias_aguinaldo'));
  const primaPct =
    input.prima_vacacional_pct !== undefined
      ? String(input.prima_vacacional_pct)
      : (await getPolicy(panel, 'prima_vacacional_pct')).value;

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
    // Decimal, no `Number(x) / 365`: el salario diario es el multiplicador de
    // TODOS los conceptos, y un float aquí se propaga al total.
    salarioDiario = new Decimal(e.annual_salary).dividedBy(365).toFixed(4);
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

  const d: DesgloseFiniquito = calcularFiniquito({
    fecha_alta: e.hire_date,
    fecha_baja: input.termination_date,
    pagado_hasta: input.last_paid_through,
    salario_diario: salarioDiario,
    dias_vacaciones_pendientes: input.pending_vacation_days ?? 0,
    dias_aguinaldo_por_anio: diasAguinaldo,
    prima_vacacional_pct: primaPct,
  });

  return {
    salary_pending_days: d.salario_pendiente_dias,
    salary_pending_amount: d.salario_pendiente_importe,
    aguinaldo_days: d.aguinaldo_dias,
    aguinaldo_amount: d.aguinaldo_importe,
    prima_vacacional_days: d.prima_vacacional_dias,
    prima_vacacional_amount: d.prima_vacacional_importe,
    vacation_pending_amount: d.vacaciones_pendientes_importe,
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
