import Decimal from 'decimal.js';
import { sumarDesgloses, DECIMALES_DIOT } from './desglose.js';
import type { DiotConstruida, RenglonDiot } from './modelo.js';
import { RFC_GENERICO_EXTRANJERO, RFC_GENERICO_NACIONAL } from './rfc.js';
import { OPERATIONS_BY_PARTY_TYPE } from './tercero.js';

// ============================================================
// MNE-001-055 · #307 · THE DIOT BATCH FILE THE SAT RECEIVES
//
// CONTRACT: this module writes the .txt the taxpayer uploads through «Agregar
// desde archivo» in the DIOT portal. Every choice below is grounded in ONE
// official document, cited with the date it was consulted. The source is
// data, not memory: the repository once shipped an invented DIOT layout
// (`generateDIOT`, deleted) and this file exists so that never happens again.
//
// The criterion `E1.2 diot-sat-layout-cited` (src/plan/criteria/e1-2.ts)
// turns red if the citation below disappears.
//
// VERSIONED BY VALIDITY, NOT OVERWRITTEN (issue #307): the SAT replaced the
// 2024 layout for fiscal years 2025 onward. `SAT_BATCH_LAYOUTS` lists each
// layout with the first fiscal year it governs; a period before the first one
// is refused (DiotFormatoNoFundamentado, raised by the caller), never written
// in the newer shape.
//
// Presenting stays a human act: this module returns a string. Nothing here
// opens a connection, signs, or uploads.
// ============================================================

export const SAT_SOURCE = Object.freeze({
  title:
    'SAT · Instructivo para el armado del archivo de carga masiva, Declaración Informativa de ' +
    'Operaciones con Terceros (DIOT), Enero 2025',
  url: 'https://www.sat.gob.mx/cs/Satellite?blobcol=urldata&blobkey=id&blobtable=MungoBlobs&blobwhere=1461176417476&ssbinary=true',
  consulted: '2026-09-29',
});

export interface LayoutAnswer {
  question: string;
  answer: string;
  /** Section of `SAT_SOURCE` that grounds the answer. */
  section: string;
}

/**
 * The seven questions that kept the serializer refusing (issue #307), each
 * answered from `SAT_SOURCE`. The answers are what `serializeSatBatch` does.
 */
export const LAYOUT_ANSWERS: readonly LayoutAnswer[] = Object.freeze([
  {
    question: 'Field order and count of each record.',
    answer:
      '54 pipe-separated fields per record, in the order of sections 3.1 (7 third-party fields), ' +
      '3.2 (10 values of acts), 3.3 (10 creditable IVA), 3.4 (20 non-creditable IVA) and 3.5 (7 ' +
      'additional data).',
    section: '§3, §3.1–§3.5',
  },
  {
    question: 'Rounding of amounts.',
    answer:
      'Every amount is "Numérico máximo 14 posiciones · No permite decimales". The layout names no ' +
      'rule. CFF art. 20 governs the payment of contributions, not informative values, so it is ' +
      'applied BY ANALOGY (1–50 cents go down, 51–99 go up): the reason is consistency with the ' +
      'monthly IVA return, whose amounts are adjusted the same way.',
    section: '§3.2–§3.5',
  },
  {
    question: 'Header record.',
    answer:
      'None. The file starts with the first third party; taxpayer, year and period are chosen in ' +
      'the portal, and the example in §3.6 opens with "04|02|…".',
    section: '§3.1, §3.6',
  },
  {
    question: 'Where withheld IVA goes.',
    answer: 'In the third party\'s own record: field 48, "IVA retenido por el contribuyente".',
    section: '§3.5',
  },
  {
    question: 'Border region (8 %) and imports.',
    answer:
      'Each has its own fields: northern border region, southern border region, 16 %, customs ' +
      'import of tangible goods at 16 %, and import of intangibles and services at 16 % — a value ' +
      'and a returns field in §3.2, two IVA boxes in §3.3 and four in §3.4. Exempt imports have ' +
      'their own field in §3.5.',
    section: '§3.2–§3.5',
  },
  {
    question: 'Record terminator, encoding and trailing pipe.',
    answer:
      'UTF-8 (§2 tells Notepad users to switch from ANSI to UTF-8). The example in §3.6 ends each ' +
      'record at its last value, with no trailing pipe. The layout names no terminator; the file ' +
      'is written as Notepad saves it — CRLF between records, none after the last one.',
    section: '§2, §3.6',
  },
  {
    question: 'A third party with several rates.',
    answer:
      'One record with every box: the rates are columns of the record, not a key that repeats ' +
      'it. The §3.6 example fills 16 %, border and import boxes on a single line. For the same ' +
      'reason one key (third-party type, operation type, RFC or foreign tax id) is one record: ' +
      'vendor records that share it — every global (15) supplier, or two records with one RFC — ' +
      'are added up before rounding. A negative net (returns larger than purchases) is refused: ' +
      'it belongs in the §3.2 "devoluciones, descuentos y bonificaciones" fields, which this file ' +
      'does not fill yet.',
    section: '§3.2, §3.6',
  },
]);

export interface SatBatchLayout {
  /** First fiscal year the layout governs. */
  firstYear: number;
  fields: number;
}

/** Newest first. A period older than the last entry has no grounded layout. */
export const SAT_BATCH_LAYOUTS: readonly SatBatchLayout[] = Object.freeze([
  { firstYear: 2025, fields: 54 },
]);

export function layoutForYear(year: number): SatBatchLayout | null {
  return SAT_BATCH_LAYOUTS.find((l) => year >= l.firstYear) ?? null;
}

/** Operation types §3.1 accepts for each third-party type (2025 layout). */
const OPERATIONS: Readonly<Record<string, readonly string[]>> = OPERATIONS_BY_PARTY_TYPE;

/** Country key "ZZZ (Otro)" needs a free-text jurisdiction the vendor record does not hold. */
const OTHER_COUNTRY = 'ZZZ';
const SEP = '|';
const EOL = '\r\n';
const MAX_DIGITS = 14;

/** Country keys of §5 are three uppercase letters (USA, CAN, … and ZZZ for other). */
const COUNTRY_KEY = /^[A-Z]{3}$/;

/** A reason one third party cannot be written. Collected, never thrown one by one. */
export interface SatBatchRefusal {
  /** The vendor records behind the refused record; empty for a file-wide refusal. */
  vendorIds: string[];
  message: string;
}

export interface SatBatchOptions {
  /** `diot_creditable_iva_proportion`: 'taxed_only' | 'block'. */
  proportion: string;
}

/** CFF art. 20 by analogy: 1–50 cents go to the lower peso, 51–99 to the upper one. */
export function toWholeUnits(amount: string): string {
  const units = new Decimal(amount)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_DOWN)
    .toFixed(0);
  // A few negative cents round to zero, not to a signed "-0".
  return units === '-0' ? '0' : units;
}

function clean(value: string): string {
  return value.replace(/[|\r\n]+/g, ' ').trim();
}

function operationOf(r: RenglonDiot): string {
  return r.tercero.tipoTercero === '15' ? '87' : r.tercero.tipoOperacion;
}

/** The identity of a record in the file: what the SAT treats as a duplicate. */
function recordKey(r: RenglonDiot): string {
  const t = r.tercero;
  const id = t.tipoTercero === '05' ? (t.idFiscalExtranjero ?? '') : (t.rfc ?? '');
  return `${t.tipoTercero}|${operationOf(r)}|${id}`;
}

interface Group {
  row: RenglonDiot;
  vendorIds: string[];
}

/**
 * One record per key. `construirDiot` builds one row per vendor record, and
 * every global supplier (15) — or two vendor records with one RFC — would
 * otherwise repeat the key, which the SAT rejects as a duplicate at upload.
 * Amounts are added in Decimal BEFORE rounding, so the record declares the
 * rounded sum and not the sum of rounded parts.
 */
function groupByKey(rows: readonly RenglonDiot[]): Group[] {
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const key = recordKey(r);
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { row: r, vendorIds: [r.tercero.vendorId] });
      continue;
    }
    g.row = {
      tercero: g.row.tercero,
      desglose: sumarDesgloses(g.row.desglose, r.desglose),
      ivaRetenido: new Decimal(g.row.ivaRetenido)
        .plus(r.ivaRetenido)
        .toDecimalPlaces(DECIMALES_DIOT)
        .toFixed(DECIMALES_DIOT),
      documentos: [...g.row.documentos, ...r.documentos],
    };
    g.vendorIds.push(r.tercero.vendorId);
  }
  return [...groups.values()];
}

function record(r: RenglonDiot, refuse: (m: string) => void): string[] {
  const t = r.tercero;
  const d = r.desglose;
  const f: string[] = new Array<string>(54).fill('');
  const who = `${t.nombre} (${t.rfc ?? t.idFiscalExtranjero ?? t.vendorId})`;

  const operation = operationOf(r);
  if (!OPERATIONS[t.tipoTercero]?.includes(operation)) {
    refuse(
      `${who}: tipo de tercero ${t.tipoTercero} con tipo de operación ${operation}, que el layout ` +
        `2025 no admite (§3.1: ${(OPERATIONS[t.tipoTercero] ?? []).join(', ')}).`
    );
  }
  f[0] = t.tipoTercero;
  f[1] = operation;
  if (t.tipoTercero === '05') {
    if (t.rfc !== undefined && t.rfc !== RFC_GENERICO_EXTRANJERO) f[2] = t.rfc;
    f[3] = clean(t.idFiscalExtranjero ?? '');
    f[4] = clean(t.nombre);
    f[5] = (t.paisResidencia ?? '').trim().toUpperCase();
    if (!COUNTRY_KEY.test(f[5])) {
      refuse(
        `${who}: el país "${f[5]}" no es una clave de tres letras del catálogo de países del ` +
          `layout (§5, p. ej. USA; ZZZ para otro). Corrige el país de residencia del proveedor.`
      );
    } else if (f[5] === OTHER_COUNTRY) {
      refuse(`${who}: país ZZZ (Otro) exige especificar la jurisdicción, y el expediente no la tiene.`);
    }
    if (f[3].length > 40 || f[4].length > 300) {
      refuse(`${who}: la identificación fiscal pasa de 40 caracteres o el nombre de 300 (§3.1).`);
    }
  } else {
    f[2] = t.tipoTercero === '15' ? RFC_GENERICO_NACIONAL : (t.rfc ?? '');
  }

  const amount = (i: number, value: string, keepZero = false): void => {
    if (!keepZero && new Decimal(value).isZero()) return;
    const units = toWholeUnits(value);
    if (units.startsWith('-')) {
      refuse(
        `${who}: el neto del mes es negativo (${value}, campo ${i + 1}): las devoluciones, ` +
          `descuentos y bonificaciones superan a las compras. El layout los declara en sus ` +
          `propios campos de §3.2 ("devoluciones, descuentos y bonificaciones"), que este ` +
          `archivo todavía no llena; captúralo en el portal.`
      );
    } else if (units.length > MAX_DIGITS) {
      refuse(`${who}: el importe ${value} no cabe en un campo numérico de ${MAX_DIGITS} posiciones.`);
    }
    f[i] = units;
  };
  /**
   * Value of acts and its creditable IVA. §3.3: the IVA box is entered "cuando
   * el valor del campo Valor total … es mayor a cero" — so only then; an IVA
   * with no value to hang from is refused rather than dropped, since the file
   * would stop agreeing with the IVA that `diot check` reconciled.
   */
  const taxed = (valueIndex: number, ivaIndex: number, base: string, iva: string): void => {
    amount(valueIndex, base);
    if (f[valueIndex] !== '' && new Decimal(f[valueIndex]).greaterThan(0)) {
      amount(ivaIndex, iva, true);
    } else if (toWholeUnits(iva) !== '0') {
      refuse(
        `${who}: tiene IVA de ${iva} (campo ${ivaIndex + 1}) sin un valor de los actos mayor a ` +
          `cero en el campo ${valueIndex + 1}, y el layout sólo admite el IVA cuando lo hay (§3.3).`
      );
    }
  };

  if (!new Decimal(d.tasa8.base).isZero() || !new Decimal(d.tasa8.iva).isZero()) {
    refuse(
      `${who}: tiene actos a la tasa del 8 %, y el layout los separa en región fronteriza NORTE ` +
        `(campos 8 y 18) y SUR (10 y 20). El expediente no dice en cuál está el proveedor.`
    );
  }
  if (d.otras.length > 0) {
    refuse(
      `${who}: tiene importes a tasas que el layout no nombra (${d.otras.map((o) => o.etiqueta).join(', ')}).`
    );
  }
  // A foreign supplier does not charge Mexican IVA: the IVA paid on its
  // services is the IVA of importing them (§3.2 fields 16–17, §3.3 26–27).
  if (t.tipoTercero === '05') {
    taxed(15, 25, d.tasa16.base, d.tasa16.iva);
    amount(48, d.exento.base);
  } else {
    taxed(11, 21, d.tasa16.base, d.tasa16.iva);
    amount(49, d.exento.base);
  }
  if (t.tipoTercero === '05') {
    // Field 51 is for DOMESTIC 0 % acts (LIVA art. 2-A). An untaxed bill from a
    // non-resident belongs in field 53 (not subject: no establishment in
    // Mexico), in the import boxes (IVA self-assessed) or in field 49 (exempt
    // import) — a fact of each operation that the ledger does not hold.
    if (!new Decimal(d.tasa0.base).isZero()) {
      refuse(
        `${who}: tiene actos a tasa 0 % (${d.tasa0.base}) de un proveedor extranjero. El campo ` +
          `51 es para actos nacionales a tasa 0 %; lo de un extranjero va en el 53 (no objeto, ` +
          `sin establecimiento en México), en importación de servicios (IVA autodeterminado) ` +
          `o en el 49 (importación exenta), según la operación. Captúralo en el portal.`
      );
    }
  } else {
    amount(50, d.tasa0.base);
  }
  amount(47, r.ivaRetenido);
  // The IVA was credited in the ledger, so the CFDIs were given tax effects.
  f[53] = '01';
  return f;
}

/**
 * The batch file, or the list of every third party that cannot be written.
 * All of them are named at once, for the same reason `construirDiot` collects
 * findings instead of throwing at the first one.
 */
export function serializeSatBatch(
  diot: DiotConstruida,
  options: SatBatchOptions
): { file: string; refusals: SatBatchRefusal[] } {
  const refusals: SatBatchRefusal[] = [];
  if (options.proportion !== 'taxed_only') {
    refusals.push({
      vendorIds: [],
      message:
        `La política diot_creditable_iva_proportion vale "${options.proportion}": la entidad ` +
        `aplica la proporción del art. 5 frac. V LIVA, que este sistema todavía no calcula. El ` +
        `IVA acreditable se reparte a mano en el portal.`,
    });
  }
  const lines = groupByKey(diot.renglones).map((g) =>
    record(g.row, (message) => refusals.push({ vendorIds: g.vendorIds, message })).join(SEP)
  );
  return { file: lines.join(EOL), refusals };
}
