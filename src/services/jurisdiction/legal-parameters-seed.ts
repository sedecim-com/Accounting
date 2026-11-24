import type pg from 'pg';
import { query } from '../../database/connection.js';
import type { JurisdictionCode } from './jurisdiction.js';

// ============================================================
// LA SEMILLA DE LA LEY: POCAS FILAS, TODAS CON FUENTE (J0.2)
//
// `legal_parameters` necesita escritor —una tabla sin escritor es una promesa,
// y `doctor` la acusa (src/ai/orphan-scan.ts)— y el escritor necesita datos
// ciertos. `source_url` es NOT NULL en la 080 por una razón que se cumple
// aquí y no en el esquema: un parámetro legal sin fuente oficial es una cifra
// inventada con mejor presentación, y la presentación es justo lo que hace que
// nadie la revise.
//
// ── POR QUÉ POCAS FILAS Y NO VEINTE ────────────────────────────────────
//
// It was born with six rows; the LFT minimums (T6 · #93) and the five rows of
// the 2026 employment subsidy (#298) and the two of its excess over the ISR
// (#600) have joined since, each with its source.
// The rule below still holds: a row enters when its figure is verified.
//
// El grueso de la ley lo carga J0.4 —UMA de cada año, tarifas del art. 96,
// subsidio, wage base, FUTA, FMW, CCPA— con su puerta (`parametros import`,
// §3.4) y su comprobación en `doctor`. Lo que este tramo tiene que demostrar
// es que la tabla TIENE ESCRITOR, y eso se demuestra igual con seis filas
// ciertas que con veinte a medio verificar. Una tabla de referencia con una
// cifra inventada es peor que una tabla vacía: la vacía falla cerrado y se ve;
// la inventada cuadra.
//
// DE DÓNDE SALE CADA MITAD, porque no son la misma y conviene no mezclarlas:
//
//   · EL VALOR lo trae el informe normativo YA AUDITADO del repositorio
//     —docs/investigacion/2026-09-06-normas-y-motores/normas/fiscal-mx.md, con
//     su tabla de fuentes verificadas una por una: la UMA de 117.31 es su
//     fuente 19, los salarios mínimos su fuente 21, y el 2,000 y el 8.5 % sus
//     renglones de LISR 27-III y 28-XX—.
//   · LA FECHA DE ENTRADA sólo la trae para dos: la UMA («vigente 01-02-2026»)
//     y los salarios mínimos («vigente 01-01-2026»). Para el IVA su columna de
//     vigencia dice «16 % estable» y para los dos umbrales de la LISR repite
//     el artículo — es decir, no fecha nada. Esas tres se comprobaron contra
//     la ficha de reformas de la Cámara de Diputados (la del IVA nombra el
//     decreto del DOF 07-12-2009) y contra el índice de leyes federales (la
//     LISR vigente es la publicada el 11-12-2013). Cada `sourceNote` dice
//     cuál es y por qué.
//
// Ninguna de las dos mitades se escribió de memoria. Y que un informe de
// cifras deje la fecha sin decir en tres de seis renglones es, precisamente,
// el hueco que esta tabla existe para cerrar.
//
// ── LAS CLAVES NACEN EN INGLÉS, Y EL DOCUMENTO RECTOR NO ───────────────
//
// docs/jurisdicciones.md §3.4 nombra las claves en español (`iva.tasa_general`,
// `lisr.efectivo_max`). Se escribió antes de que el épico #141 fusionara I0 e
// I5: desde entonces la identidad de máquina —y una clave de tabla lo es—
// nace en inglés. Se cambia AQUÍ y no después porque lo persistido no se
// renombra: una clave que ya tiene filas sembradas y lectores encima deja de
// poder cambiar de nombre sin migración. Los nombres propios no se traducen:
// la UMA se llama UMA.
// ============================================================

/** Las unidades que hoy hacen falta. El valor es cadena; la unidad es lo que
 *  lo hace significar algo. */
// `days` entra con T6 (#93): el mínimo de aguinaldo del art. 87 LFT se cuenta
// en días, y sin unidad `value` es un número sin significado — que es
// exactamente el defecto que ese tramo cerró en el panel.
// `UMA` enters with MNE-001-375 (#194): the separation cap of LISR art. 93
// fr. XIII is counted in UMA per year of service, as migrations 094, 106 and
// 164 already store the other art. 93 caps.
type LegalParameterUnit = 'rate' | 'MXN' | 'days' | 'UMA';

/** Una fila de la semilla: lo que la 080 exige, con la fuente obligatoria. */
export interface LegalParameterSeedRow {
  jurisdiction: JurisdictionCode;
  key: string;
  /** 'YYYY-MM-DD'. La fecha REAL de entrada en vigor, no la de captura. */
  effectiveFrom: string;
  /** Cadena a 4 decimales, como todo el dinero y todas las tasas de la casa. */
  value: string;
  unit: LegalParameterUnit;
  sourceUrl: string;
  /** Qué artículo y qué decreto. Es lo que se lee cuando alguien pregunta
   *  «¿de dónde sacaste esto?» tres años después. */
  sourceNote: string;
}

const LISR_PDF = 'https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf';
const LIVA_PDF = 'https://www.diputados.gob.mx/LeyesBiblio/pdf/LIVA.pdf';
const LFT_PDF = 'https://www.diputados.gob.mx/LeyesBiblio/pdf/LFT.pdf';
const SUBSIDY_DECREE_2024 = 'https://dof.gob.mx/nota_detalle.php?codigo=5725287&fecha=01/05/2024';
const SUBSIDY_DECREE_2026 = 'https://dof.gob.mx/nota_detalle.php?codigo=5777649&fecha=31/12/2025';

/**
 * Lo que se siembra, y sólo lo que se pudo fundamentar.
 *
 * TODO MÉXICO Y NADA DE ESTADOS UNIDOS, a propósito: el informe normativo de
 * EE. UU. está hecho pero sus cifras —wage base, FUTA, FMW, CCPA— entran con
 * J0.4 junto a las mexicanas del mismo lote. Sembrar hoy dos jurisdicciones a
 * medias haría creer que la tabla ya contesta por las dos.
 */
export const LEGAL_PARAMETERS_SEED: readonly LegalParameterSeedRow[] = [
  // ── MÍNIMOS DE LA LFT (T6 · #93) ───────────────────────────────────────
  //
  // Viven AQUÍ y no en el catálogo del panel, y la razón la escribe el propio
  // catálogo en su cabecera: lo que allí se declara es criterio del despacho,
  // y «la ley fija los mínimos —y ésos viven en la tabla de parámetros
  // legales, no aquí—». Un `min` en una PolicySpec sería una constante de
  // TypeScript sin fecha de entrada y sin fuente; estas dos tienen las dos.
  //
  // La fecha es la de la LEY, no la de captura. Las dos fracciones vienen del
  // texto original de la LFT de 1970, en vigor el 1 de mayo de 1970: fechar
  // esto en 2026 haría que todo finiquito con baja anterior se topara con
  // `not_yet_in_force` y dejara de calcularse.
  {
    jurisdiction: 'MX',
    key: 'aguinaldo.minimum_days',
    effectiveFrom: '1970-05-01',
    // Cuatro decimales aunque sean días: la casa guarda TODO valor legal así,
    // y hay una prueba que lo exige. Un formato uniforme es lo que permite
    // compararlos con decimal.js sin preguntarse de qué clase es cada uno.
    value: '15.0000',
    unit: 'days',
    sourceUrl: LFT_PDF,
    sourceNote:
      'LFT art. 87: «Los trabajadores tendrán derecho a un aguinaldo anual que deberá pagarse antes ' +
      'del día veinte de diciembre, equivalente a quince días de salario, por lo menos». The minimum ' +
      'is the law\'s; how many days the firm pays above it is the firm\'s own criterion and lives in ' +
      'the panel (`dias_aguinaldo`).',
  },
  {
    jurisdiction: 'MX',
    key: 'vacation_premium.minimum_rate',
    effectiveFrom: '1970-05-01',
    value: '0.2500',
    unit: 'rate',
    sourceUrl: LFT_PDF,
    sourceNote:
      'LFT art. 80: «Los trabajadores tendrán derecho a una prima no menor de veinticinco por ciento ' +
      'sobre los salarios que les correspondan durante el período de vacaciones». It is a minimum, and ' +
      'the article sets NO ceiling: paying more is a benefit, and it goes in the panel ' +
      '(`prima_vacacional_pct`).',
  },
  // ── IVA ────────────────────────────────────────────────────────────────
  {
    jurisdiction: 'MX',
    key: 'vat.standard_rate',
    // El 16 % no nació con la ley: la LIVA de 1978 llegó a 2009 con el 15 %.
    // Ésta es exactamente la clase de fecha que la tabla existe para guardar,
    // y la que una constante `IVA = 0.16` no puede contestar.
    effectiveFrom: '2010-01-01',
    value: '0.1600',
    unit: 'rate',
    sourceUrl: LIVA_PDF,
    sourceNote:
      'LIVA art. 1. The general rate went from 15 % to 16 % by the decree published in the DOF on ' +
      '07-12-2009, in force on 1 January 2010 (reform record: ' +
      'https://www.diputados.gob.mx/LeyesBiblio/ref/liva.htm). The 8 % rate of the border strip is ' +
      'NOT seeded here: it is not a LIVA rate —art. 2 is repealed— but a 50 % credit by an incentives ' +
      'decree, with a list of municipalities, and it comes with J0.4.',
  },

  // ── ISR: los dos umbrales que hoy están quemados en la ingesta ─────────
  {
    jurisdiction: 'MX',
    key: 'income_tax.cash_payment_deduction_limit',
    // La LISR vigente se publicó en el DOF el 11-12-2013 y entró en vigor el
    // 1 de enero de 2014 (art. Primero Transitorio). El límite venía del art.
    // 31-III de la ley anterior con el mismo importe; se fecha en la ley que
    // hoy rige y que es la que la fuente cita, no en la derogada.
    effectiveFrom: '2014-01-01',
    value: '2000.0000',
    unit: 'MXN',
    sourceUrl: LISR_PDF,
    sourceNote:
      'LISR art. 27 fr. III: payments over $2,000.00 are deductible only by transfer, nominative ' +
      'cheque, card or e-wallet. Law published in the DOF on 11-12-2013, in force since 1 January ' +
      '2014. The fuel exception —which applies even below that amount— is a RULE, not a parameter, ' +
      'and does not fit in this table. Today the figure is hard-coded in ' +
      'src/services/xml-ingestion/cfdi-decisions.ts (CASH_DEDUCTION_LIMIT_MXN).',
  },
  {
    jurisdiction: 'MX',
    key: 'income_tax.restaurant_deductible_rate',
    effectiveFrom: '2014-01-01',
    value: '0.0850',
    unit: 'rate',
    sourceUrl: LISR_PDF,
    sourceNote:
      'LISR art. 28 fr. XX: 91.5 % of restaurant consumption is not deductible, so the deductible ' +
      'share is 8.5 %, and only when paid by card, nominative cheque or e-wallet. Law in force since ' +
      '1 January 2014. Today the rate is hard-coded TWICE: cfdi-decisions.ts ' +
      '(RESTAURANT_DEDUCTIBLE_RATE) and policy-preview.ts.',
  },

  // ── UMA: la fila que justifica el tramo entero ─────────────────────────
  {
    jurisdiction: 'MX',
    key: 'uma.daily',
    // AQUÍ SE VE POR QUÉ `tax_parameters` NO BASTABA. Su llave es
    // UNIQUE(jurisdiction, tax_year): un valor por ejercicio. Pero la UMA no
    // entra en vigor el 1 de enero sino el 1 de FEBRERO, así que en 2026 hay
    // un mes entero —del 1 al 31 de enero— que se rige por la UMA del año
    // anterior. Con una fila por año esa pregunta no tiene respuesta; con
    // fecha de entrada, la tiene sola.
    effectiveFrom: '2026-02-01',
    value: '117.3100',
    unit: 'MXN',
    sourceUrl: 'https://dof.gob.mx/nota_detalle.php?codigo=5778072&fecha=09/01/2026',
    sourceNote:
      'Daily UMA 2026: $117.31 (monthly 3,566.22; annual 42,794.64), published by INEGI in the DOF ' +
      'on 09-01-2026. It governs from 1 FEBRUARY 2026, not from January: so says art. 5 of the Ley ' +
      'para Determinar el Valor de la UMA ' +
      '(https://www.diputados.gob.mx/LeyesBiblio/pdf/LDVUMA_301216.pdf), which gives INEGI the first ' +
      'ten days of January to publish it and sets its entry into force on 1 February. January 2026 ' +
      'is governed by the 2025 UMA, which this tranche does NOT seed: asking for a January date ' +
      'fails closed, which is the right answer while that row does not exist.',
  },

  // ── Subsidio al empleo 2026 (#298) ─────────────────────────────────────
  //
  // The same five rows migration 095 loads — the payroll engine reads them on
  // every Mexican paycheck, so an install that only migrates must have them
  // too (the 082 reason). The MONTHLY UMA is the published figure, not
  // `uma.daily × 30.4`: the decree names the monthly value, and rounding it
  // here would be a second rounding under the one the policy
  // `subsidio_al_empleo_redondeo` declares.
  {
    jurisdiction: 'MX',
    key: 'uma.monthly',
    effectiveFrom: '2025-02-01',
    value: '3439.4600',
    unit: 'MXN',
    sourceUrl: 'https://dof.gob.mx/nota_detalle.php?codigo=5746930&fecha=10/01/2025',
    sourceNote:
      'UMA 2025 published by INEGI in the DOF on 10-01-2025: daily 113.14, monthly 3,439.46, annual ' +
      '41,273.52, in force from 1 February 2025 (LDVUMA art. 5). It governs January 2026, which is why ' +
      'the January 2026 subsidy rate is applied to it.',
  },
  {
    jurisdiction: 'MX',
    key: 'uma.monthly',
    effectiveFrom: '2026-02-01',
    value: '3566.2200',
    unit: 'MXN',
    sourceUrl: 'https://dof.gob.mx/nota_detalle.php?codigo=5778072&fecha=09/01/2026',
    sourceNote:
      'UMA 2026 published by INEGI in the DOF on 09-01-2026: daily 117.31, monthly 3,566.22, annual ' +
      '42,794.64, in force from 1 February 2026 (LDVUMA art. 5).',
  },
  {
    jurisdiction: 'MX',
    key: 'employment_subsidy.uma_monthly_rate',
    effectiveFrom: '2026-01-01',
    value: '0.1559',
    unit: 'rate',
    sourceUrl: SUBSIDY_DECREE_2026,
    sourceNote:
      'Decreto que modifica el subsidio para el empleo, DOF 31-12-2025, Segundo transitorio: in January ' +
      '2026 the monthly subsidy is 15.59 % of the monthly UMA in force, which is still the 2025 UMA ' +
      '(= 536.21 rounded once to the cent).',
  },
  {
    jurisdiction: 'MX',
    key: 'employment_subsidy.uma_monthly_rate',
    effectiveFrom: '2026-02-01',
    value: '0.1502',
    unit: 'rate',
    sourceUrl: SUBSIDY_DECREE_2026,
    sourceNote:
      'Decreto que modifica el subsidio para el empleo, DOF 31-12-2025: the monthly subsidy is 15.02 % ' +
      'of the monthly UMA (= 535.65 with the 2026 UMA); for periods shorter than a month it is divided ' +
      'by 30.4 and multiplied by the days. How to round is the policy subsidio_al_empleo_redondeo.',
  },
  {
    jurisdiction: 'MX',
    key: 'employment_subsidy.monthly_income_cap',
    effectiveFrom: '2026-01-01',
    value: '11492.6600',
    unit: 'MXN',
    sourceUrl: SUBSIDY_DECREE_2026,
    sourceNote:
      'Decreto que modifica el subsidio para el empleo, DOF 31-12-2025: only workers whose monthly ' +
      'income does not exceed 11,492.66 receive the subsidy. Replaces the 10,171.00 of the DOF ' +
      '31-12-2024 decree.',
  },

  // ── The subsidy in excess of the ISR (#600, MNE-001-440) ───────────────
  //
  // The same two rows migration 329 loads. The share of the subsidy in excess
  // of the ISR that the employer pays to the worker in cash: all of it until
  // 30 April 2024, none of it since. Law with a date, not a policy of the firm.
  {
    jurisdiction: 'MX',
    key: 'employment_subsidy.excess_over_isr_paid_share',
    effectiveFrom: '2014-01-01',
    value: '1.0000',
    unit: 'rate',
    sourceUrl: LISR_PDF,
    sourceNote:
      'Decreto DOF 11-12-2013 (the one that issues the LISR), Artículo Décimo, fracción I, in force 1 ' +
      'January 2014 (its Transitorio Primero): when the ISR of art. 96 is smaller than the employment ' +
      'subsidy, «el retenedor deberá entregar al contribuyente la diferencia que se obtenga», and may ' +
      'credit what it hands over against its own ISR or the ISR withheld from others. 1 = the whole ' +
      'excess over the ISR is paid to the worker in cash.',
  },
  {
    jurisdiction: 'MX',
    key: 'employment_subsidy.excess_over_isr_paid_share',
    effectiveFrom: '2024-05-01',
    value: '0.0000',
    unit: 'rate',
    sourceUrl: SUBSIDY_DECREE_2024,
    sourceNote:
      'Decreto que otorga el subsidio para el empleo, DOF 01-05-2024, Artículo Segundo, in force 1 May ' +
      '2024 (its Transitorio Primero): when the ISR is smaller than the subsidy, «la diferencia no ' +
      'podrá aplicarse contra el impuesto que resulte a su cargo posteriormente, ni se entregará ' +
      'cantidad alguna por concepto del subsidio para el empleo». 0 = nothing of the excess over the ' +
      'ISR is paid; it replaces the Artículo Décimo of the DOF 11-12-2013 decree.',
  },

  // ── The separation exemption (MNE-001-375 · #194) ──────────────────────
  //
  // Seeded here and not migrated, by the coordinator's decision on #194: an
  // install without the law seed computes its settlements without the
  // exemption, and the settlement says which row is missing
  // (separation-isr.ts). The value is in UMA, not pesos: the peso figure moves
  // every February with the UMA, and is computed at the termination date.
  {
    jurisdiction: 'MX',
    key: 'income_tax.exempt_cap.separation_uma_per_year_of_service',
    effectiveFrom: '2016-01-28',
    value: '90.0000',
    unit: 'UMA',
    sourceUrl: LISR_PDF,
    sourceNote:
      'LISR art. 93 fr. XIII: seniority premiums, retirement, indemnities and other separation payments ' +
      'are exempt «hasta por el equivalente a noventa veces el salario mínimo general del área geográfica ' +
      'del contribuyente por cada año de servicio»; «Toda fracción de más de seis meses se considerará un ' +
      'año completo»; the excess is taxed. Text of the LISR in force since 2014-01-01 (DOF 11-12-2013). ' +
      'In UMA since the desindexation decree (DOF 27-01-2016, third transitory article), in force the ' +
      'next day, as the other art. 93 caps (migrations 094, 106, 164).',
  },

  // ── Salarios mínimos ───────────────────────────────────────────────────
  {
    jurisdiction: 'MX',
    key: 'minimum_wage.daily_general',
    effectiveFrom: '2026-01-01',
    value: '315.0400',
    unit: 'MXN',
    sourceUrl: 'https://dof.gob.mx/nota_detalle.php?codigo=5775534&fecha=09/12/2025',
    sourceNote:
      'General minimum wage 2026: $315.04 a day, set by CONASAMI and published in the DOF on ' +
      '09-12-2025, in force since 1 January 2026 (a 13 % increase: 6.5 % plus the Monto ' +
      'Independiente de Recuperación of 17.01).',
  },
  {
    jurisdiction: 'MX',
    key: 'minimum_wage.daily_border_zone',
    effectiveFrom: '2026-01-01',
    value: '440.8700',
    unit: 'MXN',
    sourceUrl: 'https://dof.gob.mx/nota_detalle.php?codigo=5775534&fecha=09/12/2025',
    sourceNote:
      'Minimum wage of the Zona Libre de la Frontera Norte 2026: $440.87 a day (a 5 % increase), ' +
      'same CONASAMI resolution published in the DOF on 09-12-2025, in force since 1 January 2026.',
  },
];

export interface LegalParametersSeedResult {
  /** Cuántas filas trae la semilla. */
  offered: number;
  /** Cuántas se insertaron de verdad en esta corrida. */
  inserted: number;
  /** Las que ya estaban con esa misma fecha de entrada: la semilla es
   *  idempotente y correrla dos veces no duplica ni pisa. */
  alreadyPresent: number;
}

/**
 * Siembra los parámetros legales de arriba. Idempotente por
 * (jurisdiction, key, effective_from), que es la unicidad que la 080 declara.
 *
 * NO PISA LO QUE YA ESTÉ, y es deliberado: `DO NOTHING` en vez de `DO UPDATE`.
 * Si alguien cargó otro valor para esa misma fecha de entrada, esta semilla no
 * lo corrige en silencio — corregir un parámetro legal es un acto con fuente y
 * con razón, no un efecto colateral de volver a sembrar. Y una ley que CAMBIA
 * no se corrige: entra como fila nueva con su propia fecha, y la vieja deja de
 * regir sola. Ése es todo el modelo.
 *
 * @param client para sembrar DENTRO de la transacción del llamador.
 */
export async function seedLegalParameters(
  opts: { client?: pg.PoolClient } = {}
): Promise<LegalParametersSeedResult> {
  const run = opts.client
    ? <T extends pg.QueryResultRow>(sql: string, params: unknown[]) => opts.client!.query<T>(sql, params)
    : query;

  // Un solo INSERT con UNNEST y no seis viajes: la semilla corre en cada
  // `npm run seed` y en las pruebas de integración que necesiten la tabla.
  // El mismo patrón que la siembra del c_CodAgrup (F07a).
  const r = await run(
    `INSERT INTO legal_parameters
       (jurisdiction, key, effective_from, value, unit, source_url, source_note)
     SELECT * FROM UNNEST(
       $1::char(2)[], $2::varchar[], $3::date[], $4::text[],
       $5::varchar[], $6::text[], $7::text[]
     ) AS t(jurisdiction, key, effective_from, value, unit, source_url, source_note)
     ON CONFLICT (jurisdiction, key, effective_from) DO NOTHING`,
    [
      LEGAL_PARAMETERS_SEED.map((p) => p.jurisdiction),
      LEGAL_PARAMETERS_SEED.map((p) => p.key),
      LEGAL_PARAMETERS_SEED.map((p) => p.effectiveFrom),
      LEGAL_PARAMETERS_SEED.map((p) => p.value),
      LEGAL_PARAMETERS_SEED.map((p) => p.unit),
      LEGAL_PARAMETERS_SEED.map((p) => p.sourceUrl),
      LEGAL_PARAMETERS_SEED.map((p) => p.sourceNote),
    ]
  );

  const inserted = r.rowCount ?? 0;
  return {
    offered: LEGAL_PARAMETERS_SEED.length,
    inserted,
    alreadyPresent: LEGAL_PARAMETERS_SEED.length - inserted,
  };
}
