import Decimal from 'decimal.js';
import type { DiotConstruida, RenglonDiot } from './modelo.js';
import { RFC_GENERICO_EXTRANJERO, RFC_GENERICO_NACIONAL } from './rfc.js';

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
      'Every amount is "Numérico máximo 14 posiciones · No permite decimales". The layout does not ' +
      'name a rule, so the one of CFF art. 20 applies: 1–50 cents go down, 51–99 go up.',
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
      'it. The §3.6 example fills 16 %, border and import boxes on a single line.',
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
const OPERATIONS: Readonly<Record<string, readonly string[]>> = {
  '04': ['02', '03', '06', '08', '85'],
  '05': ['02', '03', '07'],
  '15': ['87'],
};

/** Country key "ZZZ (Otro)" needs a free-text jurisdiction the vendor record does not hold. */
const OTHER_COUNTRY = 'ZZZ';
const SEP = '|';
const EOL = '\r\n';
const MAX_DIGITS = 14;

/** A reason one third party cannot be written. Collected, never thrown one by one. */
export interface SatBatchRefusal {
  vendorId: string;
  message: string;
}

export interface SatBatchOptions {
  /** `diot_iva_acreditable_proporcion`: 'solo_gravadas' | 'aplica_proporcion'. */
  proportion: string;
}

/** CFF art. 20: 1–50 cents go to the lower peso, 51–99 to the upper one. */
export function toWholeUnits(amount: string): string {
  return new Decimal(amount)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_DOWN)
    .toFixed(0);
}

function clean(value: string): string {
  return value.replace(/[|\r\n]+/g, ' ').trim();
}

function record(r: RenglonDiot, refuse: (m: string) => void): string[] {
  const t = r.tercero;
  const d = r.desglose;
  const f: string[] = new Array<string>(54).fill('');
  const who = `${t.nombre} (${t.rfc ?? t.idFiscalExtranjero ?? t.vendorId})`;

  const operation = t.tipoTercero === '15' ? '87' : t.tipoOperacion;
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
    f[5] = (t.paisResidencia ?? '').toUpperCase();
    if (f[5] === OTHER_COUNTRY) {
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
    if (units.startsWith('-') || units.length > MAX_DIGITS) {
      refuse(`${who}: el importe ${value} no cabe en un campo numérico de ${MAX_DIGITS} posiciones sin signo.`);
    }
    f[i] = units;
  };
  /** Value of acts and its creditable IVA: the IVA box is filled whenever the value is. */
  const taxed = (valueIndex: number, ivaIndex: number, base: string, iva: string): void => {
    amount(valueIndex, base);
    if (f[valueIndex] !== '') amount(ivaIndex, iva, true);
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
  amount(50, d.tasa0.base);
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
  if (options.proportion !== 'solo_gravadas') {
    refusals.push({
      vendorId: '',
      message:
        `La política diot_iva_acreditable_proporcion vale "${options.proportion}": la entidad ` +
        `aplica la proporción del art. 5 frac. V LIVA, que este sistema no calcula. El IVA ` +
        `acreditable se reparte a mano en el portal.`,
    });
  }
  const lines = diot.renglones.map((r) =>
    record(r, (message) => refusals.push({ vendorId: r.tercero.vendorId, message })).join(SEP)
  );
  return { file: lines.join(EOL), refusals };
}
