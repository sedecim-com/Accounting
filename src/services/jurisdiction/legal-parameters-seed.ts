import type pg from 'pg';
import { query } from '../../database/connection.js';
import type { JurisdictionCode } from './jurisdiction.js';

// ============================================================
// LA SEMILLA DE LA LEY: POCAS FILAS, TODAS CON FUENTE (J0.2)
//
// `legal_parameters` necesita escritor —una tabla sin escritor es una promesa,
// y `doctor` la acusa (src/ai/orphan-scan.ts)— y el escritor necesita datos
// ciertos. `source_url` es NOT NULL en la 075 por una razón que se cumple
// aquí y no en el esquema: un parámetro legal sin fuente oficial es una cifra
// inventada con mejor presentación, y la presentación es justo lo que hace que
// nadie la revise.
//
// ── POR QUÉ SEIS FILAS Y NO VEINTE ─────────────────────────────────────
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
type LegalParameterUnit = 'rate' | 'MXN';

/** Una fila de la semilla: lo que la 075 exige, con la fuente obligatoria. */
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

/**
 * Lo que se siembra, y sólo lo que se pudo fundamentar.
 *
 * TODO MÉXICO Y NADA DE ESTADOS UNIDOS, a propósito: el informe normativo de
 * EE. UU. está hecho pero sus cifras —wage base, FUTA, FMW, CCPA— entran con
 * J0.4 junto a las mexicanas del mismo lote. Sembrar hoy dos jurisdicciones a
 * medias haría creer que la tabla ya contesta por las dos.
 */
export const LEGAL_PARAMETERS_SEED: readonly LegalParameterSeedRow[] = [
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
      'LIVA art. 1. La tasa general pasó de 15 % a 16 % por el decreto publicado en el DOF el ' +
      '07-12-2009, en vigor el 1 de enero de 2010 (ficha de reformas: ' +
      'https://www.diputados.gob.mx/LeyesBiblio/ref/liva.htm). La tasa del 8 % de la franja ' +
      'fronteriza NO se siembra aquí: no es una tasa de la LIVA —el art. 2 está derogado— sino un ' +
      'crédito del 50 % por decreto de estímulos, con lista de municipios, y entra con J0.4.',
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
      'LISR art. 27 fr. III: los pagos cuyo monto exceda de $2,000.00 sólo son deducibles por ' +
      'transferencia, cheque nominativo, tarjeta o monedero. Ley publicada en el DOF el ' +
      '11-12-2013, en vigor desde el 1 de enero de 2014. La excepción de combustibles —que aplica ' +
      'aunque no se exceda el importe— es REGLA, no parámetro, y no cabe en esta tabla. Hoy la ' +
      'cifra está quemada en src/services/xml-ingestion/cfdi-decisions.ts (CASH_DEDUCTION_LIMIT_MXN).',
  },
  {
    jurisdiction: 'MX',
    key: 'income_tax.restaurant_deductible_rate',
    effectiveFrom: '2014-01-01',
    value: '0.0850',
    unit: 'rate',
    sourceUrl: LISR_PDF,
    sourceNote:
      'LISR art. 28 fr. XX: no es deducible el 91.5 % de los consumos en restaurantes, de modo que ' +
      'la parte deducible es el 8.5 %, y sólo si se paga con tarjeta, cheque nominativo o ' +
      'monedero. Ley en vigor desde el 1 de enero de 2014. Hoy la tasa está quemada DOS veces: ' +
      'cfdi-decisions.ts (RESTAURANT_DEDUCTIBLE_RATE) y policy-preview.ts.',
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
      'UMA diaria 2026: $117.31 (mensual 3,566.22; anual 42,794.64), publicada por el INEGI en el ' +
      'DOF el 09-01-2026. Rige desde el 1 de FEBRERO de 2026, no desde enero: lo manda el art. 5 ' +
      'de la Ley para Determinar el Valor de la UMA ' +
      '(https://www.diputados.gob.mx/LeyesBiblio/pdf/LDVUMA_301216.pdf), que da al INEGI los diez ' +
      'primeros días de enero para publicarla y fija su entrada en vigor el 1 de febrero. Enero de ' +
      '2026 se rige por la UMA de 2025, que este tramo NO siembra: preguntar por una fecha de ' +
      'enero falla cerrado, que es la respuesta correcta mientras esa fila no exista.',
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
      'Salario mínimo general 2026: $315.04 diarios, fijado por la CONASAMI y publicado en el DOF ' +
      'el 09-12-2025, en vigor desde el 1 de enero de 2026 (incremento del 13 %: 6.5 % más el ' +
      'Monto Independiente de Recuperación de 17.01).',
  },
  {
    jurisdiction: 'MX',
    key: 'minimum_wage.daily_border_zone',
    effectiveFrom: '2026-01-01',
    value: '440.8700',
    unit: 'MXN',
    sourceUrl: 'https://dof.gob.mx/nota_detalle.php?codigo=5775534&fecha=09/12/2025',
    sourceNote:
      'Salario mínimo de la Zona Libre de la Frontera Norte 2026: $440.87 diarios (incremento del ' +
      '5 %), misma resolución de la CONASAMI publicada en el DOF el 09-12-2025, en vigor desde el ' +
      '1 de enero de 2026.',
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
 * (jurisdiction, key, effective_from), que es la unicidad que la 075 declara.
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
