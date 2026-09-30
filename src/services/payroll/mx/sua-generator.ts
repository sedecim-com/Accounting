import Decimal from 'decimal.js';
import { query } from '../../../database/connection.js';
import { ValidationError } from '../../../utils/errors.js';
import { splitByContributionMonth } from '../tax-engine/tax-tables.js';

// ============================================================
// SUA (Sistema Unico de Autodeterminacion — IMSS self-determination system) — IMSS monthly file
// Fixed-width TXT layout. Reference: IMSS SUA manual.
// One record per employee per period.
// ============================================================

function pad(value: string | number, len: number, left = false, fill = ' '): string {
  const s = String(value);
  if (s.length > len) return s.slice(0, len);
  return left ? fill.repeat(len - s.length) + s : s + fill.repeat(len - s.length);
}

function padN(n: number, len: number): string {
  return pad(Math.round(n).toString(), len, true, '0');
}

/**
 * EL COTEJO CONTRA EL PASIVO YA APUNTADO, Y POR QUÉ NO SE CANCELA SOLO (#92).
 *
 * El archivo del SUA suma los recibos al vuelo. `employer_tax_liabilities`
 * lleva lo que el patrón APUNTÓ que debe, escrito por otro camino y en otro
 * momento —al aprobar la corrida, desde `acumularPasivoPatronal`—. Son dos
 * caminos independientes hacia la misma cifra, así que cotejarlos mide de
 * verdad; una ida y vuelta por el mismo código no mediría nada.
 *
 * Both paths attribute a period that straddles two months the same way, by the
 * contribution days of each month (`splitByContributionMonth`, #231): before,
 * the liability took it whole by `period_end` while this file demanded the
 * whole period inside the month, and a straddling week was 500.00 the books
 * declared and the IMSS file did not.
 *
 * Ausencia y discrepancia NO son lo mismo, y por eso se tratan distinto. Que no
 * haya pasivo apuntado significa «no hay contra qué cotejar» —corridas
 * aprobadas antes de que existiera el acumulador—: se NOMBRA y se sigue. Que
 * haya y no cuadre significa que una de las dos cifras es falsa, y entonces no
 * se entrega el archivo: se dice cuál es cada una.
 */
export interface HallazgoSua {
  codigo: 'sin_pasivo_que_cotejar' | 'el_archivo_no_cuadra_con_el_pasivo';
  concepto: 'imss_employer' | 'infonavit_employer';
  detalle: string;
  bloquea: boolean;
}

interface SuaEmployee {
  nss: string;
  rfc: string;
  curp: string;
  last_name: string;
  second_last_name: string;
  first_name: string;
  sbc: number;
  days_worked: number;
  imss_employer_amount: number;
  imss_employee_amount: number;
  infonavit_employer_amount: number;
  infonavit_employee_amount: number;
}

export async function generateSuaFile(
  tenantId: string,
  entityId: string,
  year: number,
  month: number
): Promise<{
  content: string;
  filename: string;
  employee_count: number;
  hallazgos: HallazgoSua[];
}> {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  const periodStart = start.toISOString().slice(0, 10);
  const periodEnd = end.toISOString().slice(0, 10);

  const result = await query<{
    employee_id: string;
    nss: string;
    rfc: string;
    curp: string;
    last_name: string;
    second_last_name: string | null;
    first_name: string;
    sbc: string;
    imss_employee: string | null;
    imss_employer: string | null;
    infonavit_withheld: string | null;
    infonavit_employer: string | null;
    period_start: string | null;
    period_end: string | null;
  }>(
    // EL MES Y EL ESTADO ACOTAN LOS RECIBOS, NO LOS ADORNAN (#92).
    //
    // La consulta anterior ponía esas dos condiciones en los `ON` de dos
    // `LEFT JOIN` POSTERIORES al de `paychecks`, y ahí no descartan nada: un
    // recibo de otro mes, o de una corrida en borrador, sobrevivía con `pr` y
    // `pp` en NULL y `p` intacto. Los `SUM(p.imss_*)` sumaban entonces la
    // HISTORIA ENTERA del empleado, mientras los días —que salen de `pp`, el
    // que sí se anula— sí quedaban acotados al mes. Medido: dos años de
    // antigüedad en quincenal daban 3.500,00 de cuota patronal junto a 31 días
    // cotizados, en el mismo renglón. Y ese archivo es el que el patrón carga
    // en el SUA para pagarle al IMSS y al INFONAVIT.
    //
    // El arreglo no es mover un `AND`: es que los filtros vivan donde filtran.
    // Los movimientos del mes se arman en una tabla derivada con JOINs
    // INTERNOS —ahí una condición que no se cumple sí elimina la fila— y el
    // empleado se le cuelga por fuera con `LEFT JOIN`, para que la plantilla
    // siga saliendo completa: quien no tuvo movimientos en el mes aparece en
    // ceros, que es lo que el SUA espera, y no desaparece del archivo.
    //
    // A PERIOD THAT OVERLAPS THE MONTH ENTERS, NOT ONLY ONE INSIDE IT (#231).
    // A week straddling two months used to meet neither bound and was declared
    // in no month. Each payslip now comes back whole with its period, and
    // `splitByContributionMonth` keeps only this month's contribution days and
    // their share of every amount — the same split the liability books.
    `SELECT
       e.id AS employee_id, e.nss, e.rfc, e.curp,
       e.last_name, e.second_last_name, e.first_name,
       e.sbc,
       m.imss_employee::text, m.imss_employer::text,
       m.infonavit_withheld::text, m.infonavit_employer::text,
       m.period_start, m.period_end
     FROM employees e
     LEFT JOIN (
       SELECT p.employee_id,
              p.imss_employee, p.imss_employer,
              p.infonavit_withheld, p.infonavit_employer,
              pp.period_start::text AS period_start, pp.period_end::text AS period_end
         FROM paychecks p
         JOIN pay_runs pr ON pr.id = p.pay_run_id
         JOIN pay_periods pp ON pp.id = pr.pay_period_id
        WHERE pr.status IN ('approved', 'paid')
          AND pp.period_start <= $4 AND pp.period_end >= $3
     ) m ON m.employee_id = e.id
     WHERE e.tenant_id = $1 AND e.entity_id = $2 AND e.country_code = 'MX'`,
    [tenantId, entityId, periodStart, periodEnd]
  );

  const records: string[] = [];
  const byEmployee = new Map<string, SuaEmployee>();
  for (const r of result.rows) {
    let e = byEmployee.get(r.employee_id);
    if (!e) {
      e = {
        nss: r.nss || '',
        rfc: r.rfc || '',
        curp: r.curp || '',
        last_name: r.last_name,
        second_last_name: r.second_last_name || '',
        first_name: r.first_name,
        sbc: parseFloat(r.sbc),
        days_worked: 0,
        imss_employer_amount: 0,
        imss_employee_amount: 0,
        infonavit_employer_amount: 0,
        infonavit_employee_amount: 0,
      };
      byEmployee.set(r.employee_id, e);
    }
    if (!r.period_start || !r.period_end) continue;
    const share = (amount: string | null) => {
      const s = splitByContributionMonth(r.period_start!, r.period_end!, amount ?? '0').find(
        (x) => x.start >= periodStart && x.start <= periodEnd
      );
      return s ?? { days: 0, amount: new Decimal(0) };
    };
    // Added through Decimal: float sums of cents drift, and the cross-check
    // below compares these totals with `equals`.
    const add = (acc: number, amount: string | null) => share(amount).amount.plus(acc).toNumber();
    e.days_worked += share(r.imss_employer).days;
    e.imss_employer_amount = add(e.imss_employer_amount, r.imss_employer);
    e.imss_employee_amount = add(e.imss_employee_amount, r.imss_employee);
    e.infonavit_employer_amount = add(e.infonavit_employer_amount, r.infonavit_employer);
    e.infonavit_employee_amount = add(e.infonavit_employee_amount, r.infonavit_withheld);
  }
  const employees = [...byEmployee.values()];

  for (const e of employees) {
    // Simplified SUA layout (real SUA has ~150 fixed positions per record).
    // This captures the critical positions for integration testing.
    const line =
      pad(e.nss, 11) +                                        // 1-11   NSS
      pad(e.rfc, 13) +                                        // 12-24  RFC
      pad(e.curp, 18) +                                       // 25-42  CURP
      pad(e.last_name, 27) +                                  // 43-69
      pad(e.second_last_name, 27) +                           // 70-96
      pad(e.first_name, 27) +                                 // 97-123
      padN(e.sbc * 100, 8) +                                  // SBC cents
      padN(e.days_worked, 2) +                                // Days worked
      padN(e.imss_employer_amount * 100, 10) +                // IMSS employer
      padN(e.imss_employee_amount * 100, 10) +                // IMSS employee
      padN(e.infonavit_employer_amount * 100, 10) +           // INFONAVIT employer
      padN(e.infonavit_employee_amount * 100, 10);            // INFONAVIT employee
    records.push(line);
  }

  const content = records.join('\r\n') + '\r\n';
  const filename = `SUA_${entityId.slice(0, 8)}_${year}${String(month).padStart(2, '0')}.txt`;

  const totales = {
    imss_employer: employees.reduce((s, e) => s.plus(e.imss_employer_amount), new Decimal(0)),
    infonavit_employer: employees.reduce((s, e) => s.plus(e.infonavit_employer_amount), new Decimal(0)),
  };
  const hallazgos = await cotejarContraElPasivo(
    tenantId, entityId, periodStart, periodEnd, totales
  );
  const bloqueantes = hallazgos.filter((h) => h.bloquea);
  if (bloqueantes.length > 0) {
    // No se entrega, y NO se persiste la declaración: un `tax_form_filings` en
    // 'draft' con una cifra que no cuadra es exactamente el archivo que alguien
    // acaba subiendo al SUA sin volver a mirarlo.
    throw new ValidationError(
      `El archivo del SUA no cuadra con el pasivo patronal ya apuntado, así que no se entrega: ` +
        bloqueantes.map((h) => h.detalle).join(' · ')
    );
  }

  await query(
    `INSERT INTO tax_form_filings (tenant_id, entity_id, form_type, tax_year, period, status, data)
     VALUES ($1, $2, 'sua', $3, $4, 'draft', $5::jsonb)`,
    [tenantId, entityId, year, String(month).padStart(2, '0'), JSON.stringify({
      employee_count: employees.length,
      hallazgos,
      totals: {
        imss_employer: employees.reduce((s, e) => s + e.imss_employer_amount, 0),
        imss_employee: employees.reduce((s, e) => s + e.imss_employee_amount, 0),
        infonavit_employer: employees.reduce((s, e) => s + e.infonavit_employer_amount, 0),
        infonavit_employee: employees.reduce((s, e) => s + e.infonavit_employee_amount, 0),
      },
    })]
  );

  return { content, filename, employee_count: employees.length, hallazgos };
}

/**
 * Lo que el patrón YA APUNTÓ que debe este mes, por el camino del acumulador.
 *
 * Read by `period_end` inside the month: the accumulator writes one row per
 * month a period touches, each ending inside its own month (#231), and the
 * month-end row ends on the month's last day.
 */
async function cotejarContraElPasivo(
  tenantId: string,
  entityId: string,
  mesInicio: string,
  mesFin: string,
  totales: { imss_employer: Decimal; infonavit_employer: Decimal }
): Promise<HallazgoSua[]> {
  const apuntado = await query<{ tax_type: string; total: string }>(
    `SELECT tax_type, COALESCE(SUM(amount), 0)::text AS total
       FROM employer_tax_liabilities
      WHERE tenant_id = $1 AND entity_id = $2
        AND tax_type IN ('imss_employer', 'infonavit_employer')
        AND period_end >= $3::date AND period_end <= $4::date
      GROUP BY tax_type`,
    [tenantId, entityId, mesInicio, mesFin]
  );
  const porConcepto = new Map(apuntado.rows.map((r) => [r.tax_type, new Decimal(r.total)]));

  const hallazgos: HallazgoSua[] = [];
  for (const concepto of ['imss_employer', 'infonavit_employer'] as const) {
    const enElArchivo = totales[concepto];
    const enLosLibros = porConcepto.get(concepto);
    if (enLosLibros === undefined) {
      // Si el archivo tampoco declara nada, no hay nada que cotejar ni nada
      // que avisar: un mes sin nómina es un mes sin nómina.
      if (enElArchivo.isZero()) continue;
      hallazgos.push({
        codigo: 'sin_pasivo_que_cotejar',
        concepto,
        detalle:
          `el archivo declara ${enElArchivo.toFixed(2)} de ${concepto} y no hay ningún renglón ` +
          `de pasivo apuntado para ${mesInicio}..${mesFin} contra el que cotejarlo: la cifra ` +
          `sale de un solo camino y nadie la confirma`,
        bloquea: false,
      });
      continue;
    }
    if (!enElArchivo.equals(enLosLibros)) {
      hallazgos.push({
        codigo: 'el_archivo_no_cuadra_con_el_pasivo',
        concepto,
        detalle:
          `${concepto}: el archivo declara ${enElArchivo.toFixed(2)} y el pasivo apuntado dice ` +
          `${enLosLibros.toFixed(2)} (diferencia ${enLosLibros.minus(enElArchivo).toFixed(2)}). ` +
          `Si un periodo cruza el cambio de mes y su pasivo se apuntó antes del reparto por ` +
          `días cotizados, ese renglón lo lleva entero en un solo mes`,
        bloquea: true,
      });
    }
  }
  return hallazgos;
}
