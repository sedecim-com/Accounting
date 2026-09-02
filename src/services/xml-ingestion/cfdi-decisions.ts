import type { CfdiFacts } from './cfdi-facts.js';

// ============================================================
// DECISION POINTS
// Scenarios where the SAME XML admits several valid records
// depending on information that is NOT in the document. The
// system must not choose on its own: it asks with concrete
// options. Each answer is stored as a precedent (ai_questions).
// ============================================================

export type DecisionSeverity =
  /** Blocks the record: without an answer it cannot be posted. */
  | 'blocking'
  /** Can be recorded with the default, but confirming is advisable. */
  | 'advisory';

export interface DecisionOption {
  value: string;
  label: string;
  /** Account role implied by this option, if applicable. */
  role?: string;
}

export interface DecisionPoint {
  id: string;
  severity: DecisionSeverity;
  question: string;
  /** Context shown to the human so they can decide. */
  context: (f: CfdiFacts) => string;
  options: DecisionOption[];
  /** Default option when the decision is advisory. */
  default?: string;
  /** Slug for precedent lookup: if already resolved, do not ask again. */
  topic: (f: CfdiFacts) => string;
  /** When this decision applies, given the effective policy thresholds. */
  applies: (f: CfdiFacts, thresholds?: PolicyThresholds) => boolean;
  /** Legal or accounting basis. */
  basis?: string;
}

const money = (n: number, moneda = 'MXN') =>
  `${n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${moneda}`;

/**
 * DEFAULT capitalization threshold. The effective value comes from the
 * 'umbral_capitalizacion_mxn' policy (see `mnemosine pending`): this
 * constant only applies when evaluating without tenant context.
 */
export const CAPITALIZATION_THRESHOLD_MXN = 20_000;

/**
 * Policy-resolved thresholds injected by the classifier. Without them the
 * defaults are used, and the decision stays visible as pending.
 */
export interface PolicyThresholds {
  capitalizationThreshold: number;
  restaurantPolicy: string;
  iepsTreatment: string;
  inventoryPolicy: string;
}

export const DEFAULT_THRESHOLDS: PolicyThresholds = {
  capitalizationThreshold: CAPITALIZATION_THRESHOLD_MXN,
  restaurantPolicy: 'split_85',
  iepsTreatment: 'costo',
  inventoryPolicy: 'directo',
};
/** Cash payments above this amount are not deductible (LISR 27-III). */
export const CASH_DEDUCTION_LIMIT_MXN = 2_000;
/** Restaurant meals: only 8.5% deductible (LISR 28-XX). */
export const RESTAURANT_DEDUCTIBLE_RATE = 0.085;

/** c_ClaveProdServ keys that usually indicate a fixed asset (SAT chapters). */
const ACTIVO_FIJO_PREFIXES = ['4321', '5611', '5612', '2411', '2513', '4610', '3910'];
/** Food/restaurant keys. */
const RESTAURANTE_PREFIXES = ['9011', '9012', '5010'];
/** Fuel keys. */
const COMBUSTIBLE_PREFIXES = ['1510'];

export const DECISIONS: DecisionPoint[] = [
  // ── Classification of the disbursement ──
  {
    id: 'gasto_vs_activo',
    severity: 'blocking',
    question: 'Is this disbursement capitalized as a fixed asset or recorded as a period expense?',
    context: (f) =>
      `${f.emisorNombre} · ${money(f.subtotal, f.moneda)} · "${f.conceptosDescripcion.slice(0, 160)}"\n` +
      `The amount exceeds the effective capitalization threshold ` +
      `or the product key suggests a fixed-asset good.\n` +
      `Note: capitalizing books the amount to the fixed-asset account. To depreciate it, ` +
      `register the asset card afterwards (mnemosine asset create --contabilizacion ya_contabilizado) ` +
      `and the monthly run will pick it up: the deduction does not appear without the card.`,
    options: [
      // HISTORIA DE ESTA ETIQUETA, porque cambió dos veces y las dos por
      // honestidad. Decía «capitalized and depreciated» cuando nada depreciaba
      // —runMonthlyDepreciation sin llamador y ni un INSERT INTO fixed_assets
      // en todo src—, así que se degradó a «depreciation NOT computed yet»:
      // prometer una deducción que nadie calcula es peor que no ofrecerla.
      // F06a entregó el alta y la corrida, y la etiqueta vuelve a subir — pero
      // sólo hasta donde es verdad: capitalizar NO da de alta la ficha. El
      // paso que falta se nombra, porque la deducción sigue sin aparecer sola.
      {
        value: 'activo_fijo',
        label: 'Fixed asset (capitalized; register the card with `asset create` so the monthly run depreciates it)',
        role: 'activo_fijo',
      },
      { value: 'gasto', label: 'Period expense (immediate deduction)', role: 'gasto' },
      { value: 'inventario', label: 'Inventory (good for resale)', role: 'inventario' },
    ],
    topic: (f) => `clasificacion_desembolso:${f.emisorRfc}`,
    applies: (f, t = DEFAULT_THRESHOLDS) =>
      f.direction === 'recibido' &&
      f.tipo === 'I' &&
      (f.subtotal >= t.capitalizationThreshold ||
        f.clavesProdServ.some((c) => ACTIVO_FIJO_PREFIXES.some((p) => c.startsWith(p)))),
    basis:
      'LISR arts. 31-38 (investments and depreciation). The threshold is company policy. ' +
      'The depreciation engine exists (services/assets/depreciation.ts) but has no caller and ' +
      'no way to register an asset, so capitalizing here is a posting, not a schedule.',
  },
  {
    id: 'gasto_vs_anticipado',
    severity: 'advisory',
    question: 'Does the expense cover several periods? Is it accrued, or recorded in full this month?',
    context: (f) =>
      `${f.emisorNombre} · ${money(f.subtotal, f.moneda)} · "${f.conceptosDescripcion.slice(0, 160)}"\n` +
      `The description suggests a service with annual or multi-year coverage (insurance, subscription, prepaid rent).`,
    options: [
      { value: 'gasto', label: 'Full period expense', role: 'gasto' },
      { value: 'gasto_anticipado', label: 'Prepaid expenses (accrued month by month)', role: 'gasto_anticipado' },
    ],
    default: 'gasto',
    topic: (f) => `devengo:${f.emisorRfc}`,
    applies: (f) =>
      f.direction === 'recibido' &&
      f.tipo === 'I' &&
      // Matches Spanish wording in real invoice descriptions — do not translate.
      /\b(seguro|p[oó]liza|anual|suscripci[oó]n|licencia|mantenimiento anual|renta anticipada|prima)\b/i.test(
        f.conceptosDescripcion
      ),
    basis: 'NIF A-2 (accrual accounting).',
  },

  // ── Deductibility ──
  {
    id: 'efectivo_no_deducible',
    severity: 'blocking',
    question:
      `The payment was made in cash for more than ${money(CASH_DEDUCTION_LIMIT_MXN)}. ` +
      `How should the expense be recorded?`,
    context: (f) =>
      `${f.emisorNombre} · ${money(f.total, f.moneda)} · payment method 01 (cash)\n` +
      `The LISR does not allow deducting cash payments exceeding ${money(CASH_DEDUCTION_LIMIT_MXN)}. ` +
      `The VAT would not be creditable either.`,
    options: [
      { value: 'no_deducible', label: 'Non-deductible expense (and no VAT crediting)', role: 'gasto_no_deducible' },
      { value: 'gasto', label: 'Deductible — the CFDI payment method is wrong and will be corrected', role: 'gasto' },
    ],
    topic: (f) => `efectivo_no_deducible:${f.emisorRfc}`,
    applies: (f) =>
      f.direction === 'recibido' && f.pagadoEnEfectivo && f.total > CASH_DEDUCTION_LIMIT_MXN,
    basis: 'LISR art. 27 sec. III; LIVA art. 5 sec. I.',
  },
  {
    id: 'consumo_restaurante',
    severity: 'advisory',
    question: 'Restaurant meal: only 8.5% is deductible. How should I record it?',
    context: (f) =>
      `${f.emisorNombre} · ${money(f.subtotal, f.moneda)}\n` +
      `Deductible: ${money(f.subtotal * RESTAURANT_DEDUCTIBLE_RATE)} · ` +
      `Non-deductible: ${money(f.subtotal * (1 - RESTAURANT_DEDUCTIBLE_RATE))}`,
    options: [
      { value: 'split_85', label: 'Split 8.5% deductible / 91.5% non-deductible' },
      { value: 'no_deducible', label: 'Entirely non-deductible', role: 'gasto_no_deducible' },
      { value: 'gasto', label: 'Entirely deductible (per diem or travel expense meeting requirements)', role: 'gasto' },
    ],
    default: 'split_85',
    topic: (f) => `restaurante:${f.emisorRfc}`,
    applies: (f) =>
      f.direction === 'recibido' &&
      f.tipo === 'I' &&
      (f.clavesProdServ.some((c) => RESTAURANTE_PREFIXES.some((p) => c.startsWith(p))) ||
        // Matches Spanish wording in real invoice descriptions — do not translate.
        /\b(restaurante|consumo de alimentos|comida)\b/i.test(f.conceptosDescripcion)),
    basis: 'LISR art. 28 sec. XX.',
  },
  {
    id: 'combustible_efectivo',
    severity: 'blocking',
    question: 'Fuel paid in cash: not deductible regardless of the amount. How should I record it?',
    context: (f) => `${f.emisorNombre} · ${money(f.total, f.moneda)} · payment method 01 (cash)`,
    options: [
      { value: 'no_deducible', label: 'Non-deductible expense', role: 'gasto_no_deducible' },
      { value: 'gasto', label: 'Deductible — the payment method will be corrected', role: 'gasto' },
    ],
    topic: (f) => `combustible_efectivo:${f.emisorRfc}`,
    applies: (f) =>
      f.direction === 'recibido' &&
      f.pagadoEnEfectivo &&
      f.clavesProdServ.some((c) => COMBUSTIBLE_PREFIXES.some((p) => c.startsWith(p))),
    basis: 'LISR art. 27 sec. III (fuel: always through banking channels).',
  },

  // ── Account and dimensions ──
  {
    id: 'cuenta_ambigua',
    severity: 'advisory',
    question: 'Which expense account does this belong to? The CFDI description is generic.',
    context: (f) =>
      `${f.emisorNombre} · ${money(f.subtotal, f.moneda)} · "${f.conceptosDescripcion.slice(0, 160)}"\n` +
      `No precedent for this vendor and the description does not identify the nature of the expense.`,
    options: [], // filled at runtime with candidate accounts from the chart of accounts
    topic: (f) => `cuenta_gasto:${f.emisorRfc}`,
    applies: (f) =>
      f.direction === 'recibido' &&
      f.tipo === 'I' &&
      // Matches Spanish wording in real invoice descriptions — do not translate.
      /\b(servicios? profesionales?|honorarios?|servicios? varios|asesor[íi]a|consultor[íi]a)\b/i.test(
        f.conceptosDescripcion
      ),
    basis: 'Firm criteria.',
  },

  // ── Advance payments ──
  {
    id: 'anticipo_o_gasto',
    severity: 'blocking',
    question: 'Is it an advance payment to the vendor, or an expense already accrued?',
    context: (f) =>
      `${f.emisorNombre} · ${money(f.total, f.moneda)}\n` +
      `The CFDI uses the advance-payment key (84111506) or its description indicates one. An advance is ` +
      `an ASSET (a right to receive the good/service), not an expense; it is cancelled when the final CFDI arrives.`,
    options: [
      { value: 'anticipo', label: 'Advance to vendor (asset)', role: 'anticipo_proveedores' },
      { value: 'gasto', label: 'Accrued expense (the service was already received)', role: 'gasto' },
    ],
    topic: (f) => `anticipo:${f.emisorRfc}`,
    applies: (f) => f.direction === 'recibido' && f.esAnticipo,
    basis: 'Anexo 20 filling guide, appendix 6 (advance payments).',
  },

  // ── IEPS ──
  {
    id: 'ieps_acreditable',
    severity: 'advisory',
    question: 'The CFDI carries transferred IEPS. Is it creditable, or part of the cost?',
    context: (f) =>
      `${f.emisorNombre} · IEPS: ${money(f.iepsTrasladado, f.moneda)}\n` +
      `IEPS is only creditable if the company is a taxpayer of that tax and will pass it on; ` +
      `otherwise it is part of the cost of the good.`,
    options: [
      { value: 'costo', label: 'Part of the cost (not creditable)', role: 'gasto' },
      { value: 'acreditable', label: 'Creditable IEPS', role: 'ieps_acreditable' },
    ],
    default: 'costo',
    topic: () => 'ieps_tratamiento',
    applies: (f) => f.direction === 'recibido' && f.iepsTrasladado > 0,
    basis: 'LIEPS art. 4 (crediting limited to taxpayers of the tax).',
  },

  // ── Third parties ──
  {
    id: 'por_cuenta_terceros',
    severity: 'blocking',
    question: 'The CFDI has the "On behalf of third parties" complement. Whose expense is it?',
    context: (f) =>
      `${f.emisorNombre} · ${money(f.total, f.moneda)}\n` +
      `An expense on behalf of a third party is NOT the company's own expense: it is a receivable from that third party.`,
    options: [
      { value: 'cxc_tercero', label: 'Receivable from the third party (not our own expense)', role: 'cxc' },
      { value: 'gasto', label: 'Own expense (the complement does not apply here)', role: 'gasto' },
    ],
    topic: () => 'por_cuenta_terceros',
    applies: (f) => f.direction === 'recibido' && f.complementos.includes('Terceros'),
    basis: 'RMF rule 2.7.1.13 (expenses on behalf of third parties).',
  },

  // ── Vendor / customer ──
  {
    id: 'proveedor_nuevo',
    severity: 'blocking',
    question: 'Should I register this issuer as a new vendor?',
    context: (f) =>
      `${f.emisorNombre} (${f.emisorRfc}) is not in the vendor catalog.\n` +
      `Before creating it: verify it is not the same vendor under another RFC (change of legal name).`,
    options: [
      { value: 'crear', label: 'Create the vendor with the CFDI data' },
      { value: 'existente', label: 'Already exists under another name/RFC — I will point to it' },
      { value: 'sin_proveedor', label: 'Record without a vendor (direct expense)' },
    ],
    topic: (f) => `proveedor_nuevo:${f.emisorRfc}`,
    applies: () => false, // activated by the classifier when there is no match
    basis: 'Internal control.',
  },

  // ── Period ──
  {
    id: 'periodo_cerrado',
    severity: 'blocking',
    question: 'The CFDI belongs to an already-closed period. Which period should I record it in?',
    context: (f) =>
      `CFDI date: ${f.fecha.toISOString().split('T')[0]} · ${f.emisorNombre} · ${money(f.total, f.moneda)}\n` +
      `The period for that date is closed; recording it there would require reopening it.`,
    options: [
      { value: 'periodo_actual', label: 'Record in the currently open period' },
      { value: 'reabrir', label: 'Reopen the original period (requires authorization)' },
      { value: 'rechazar', label: 'Do not record for now' },
    ],
    topic: () => 'cfdi_periodo_cerrado',
    applies: () => false, // activated by the classifier when validating the period
    basis: 'NIF B-1 / closing policy.',
  },

  // ── SAT status ──
  {
    id: 'cfdi_cancelado',
    severity: 'blocking',
    question: 'The SAT reports this CFDI as cancelled or not in force. Should I record it?',
    context: (f) => `UUID ${f.uuid} · ${f.emisorNombre} · ${money(f.total, f.moneda)}`,
    options: [
      { value: 'rechazar', label: 'Do not record (the right call in most cases)' },
      { value: 'registrar', label: 'Record anyway (a substitution is pending)' },
    ],
    default: 'rechazar',
    topic: () => 'cfdi_cancelado',
    applies: () => false, // activated by the SAT validation
    basis: 'CFF art. 29-A (a cancelled CFDI does not support a deduction).',
  },
];

export function decisionsFor(
  facts: CfdiFacts,
  thresholds: PolicyThresholds = DEFAULT_THRESHOLDS
): DecisionPoint[] {
  return DECISIONS.filter((d) => d.applies(facts, thresholds));
}

export function getDecision(id: string): DecisionPoint | undefined {
  return DECISIONS.find((d) => d.id === id);
}
