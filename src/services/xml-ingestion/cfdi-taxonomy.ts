import { TIPO_RELACION, type CfdiFacts } from './cfdi-facts.js';

// ============================================================
// CFDI TAXONOMY → ACCOUNTING TREATMENT
// Declarative matrix: (type, direction, characteristics) → entry.
// Accounts are expressed as abstract ROLES; the role→account mapping
// lives per entity (account_roles table), so the same taxonomy works
// for any chart of accounts.
// ============================================================

export type AccountRole =
  // Revenue and collections
  | 'ingreso' | 'devolucion_ventas' | 'anticipo_clientes' | 'cxc' | 'banco'
  // Ingresos que no son ventas: hoy sólo el remanente de un pago corto que se
  // decide tratar como ganancia (política `pago_corto_residual`). Separado de
  // `ingreso` a propósito — meterlo en 4100 inflaría las ventas con algo que
  // nadie compró, y es justo la cifra que el despacho compara contra el CFDI.
  | 'otros_ingresos'
  // VAT owed to the SAT. Under PPD, VAT is TRIGGERED on collection, not on invoicing.
  | 'iva_trasladado' | 'iva_trasladado_no_cobrado'
  // Purchases, expenses and assets
  | 'gasto' | 'gasto_no_deducible' | 'gasto_anticipado' | 'inventario' | 'activo_fijo'
  | 'devolucion_compras' | 'anticipo_proveedores' | 'cxp'
  // Creditable VAT. Under PPD it is credited when PAYING (with the REP), not on receipt.
  | 'iva_acreditable' | 'iva_pendiente_acreditar'
  // Withholdings: as withholder (liability) or as withheld party (asset in favor)
  | 'isr_retenido_por_pagar' | 'iva_retenido_por_pagar'
  | 'isr_retenido_a_favor' | 'iva_retenido_a_favor'
  // Other taxes
  | 'ieps_acreditable' | 'ieps_por_pagar'
  | 'impuestos_locales_gasto' | 'impuestos_locales_por_pagar'
  // Payroll
  | 'sueldos_gasto' | 'sueldos_por_pagar' | 'isr_nomina_por_pagar' | 'imss_por_pagar'
  // Exchange differences
  | 'utilidad_cambiaria' | 'perdida_cambiaria'
  // Tesorería (F05d): lo que cuesta mover el dinero y lo que el dinero produce.
  // Ninguno de los dos va a la cuenta genérica que le quedaría cerca —6300 es
  // pérdida cambiaria y 4300 es «otros ingresos»—: mezclarlos esconde
  // exactamente las dos líneas que un tesorero mira.
  | 'comision_bancaria' | 'producto_financiero';

export interface PostingLine {
  role: AccountRole;
  side: 'debit' | 'credit';
  /** Which CFDI fact the amount comes from. */
  amount: (f: CfdiFacts) => number;
  description: string;
  /** If the amount is 0, the line is omitted (keeps the journal entry clean). */
  omitIfZero?: boolean;
}

export interface CfdiCase {
  id: string;
  label: string;
  tipos: string[];
  directions: Array<CfdiFacts['direction']>;
  /** Extra condition; without it the case applies to every (type, direction). */
  when?: (f: CfdiFacts) => boolean;
  /**
   * null = generates NO journal entry (transfers, informational). An
   * explicit decision, not an omission.
   */
  posting: PostingLine[] | null;
  /** Decisions that must be resolved before posting. */
  decisions?: string[];
  /** Requires linking to prior documents (payments, credit notes). */
  requiresLinkage?: boolean;
  notes: string;
  /** More specific wins: the classifier sorts by priority desc. */
  priority: number;
}

// Amount shortcuts
const A = {
  subtotalNeto: (f: CfdiFacts) => f.subtotal - f.descuento,
  total: (f: CfdiFacts) => f.total,
  ivaTrasladado: (f: CfdiFacts) => f.ivaTrasladado16 + f.ivaTrasladado8,
  ieps: (f: CfdiFacts) => f.iepsTrasladado,
  isrRet: (f: CfdiFacts) => f.isrRetenido,
  ivaRet: (f: CfdiFacts) => f.ivaRetenido,
  localesTras: (f: CfdiFacts) => f.impuestosLocalesTrasladados,
  pagado: (f: CfdiFacts) => f.docsRelacionados.reduce((s, d) => s + d.impPagado, 0),
};

// ============================================================
// CASES
// ============================================================

export const CASES: CfdiCase[] = [
  // ─────────────────────────────────────────────────────────
  // BLOCKS (maximum priority)
  // ─────────────────────────────────────────────────────────
  {
    id: 'ajeno',
    label: 'CFDI that does not belong to the entity',
    tipos: ['I', 'E', 'T', 'N', 'P', 'R'],
    directions: ['ajeno'],
    posting: null,
    notes:
      'Neither the issuer nor the receiver is the entity RFC. Not recorded: it was probably ' +
      'loaded into the wrong entity.',
    priority: 1000,
  },
  {
    id: 'sin_timbre',
    label: 'CFDI without fiscal stamp',
    tipos: ['I', 'E', 'T', 'N', 'P'],
    directions: ['emitido', 'recibido'],
    when: (f) => !f.uuid,
    posting: null,
    notes: 'Without a TimbreFiscalDigital UUID it is not a valid document before the SAT.',
    priority: 999,
  },

  // ─────────────────────────────────────────────────────────
  // I — INGRESO, RECEIVED (purchases and expenses)
  // ─────────────────────────────────────────────────────────
  {
    id: 'ingreso_recibido_anticipo',
    label: 'Advance payment made to vendor',
    tipos: ['I'],
    directions: ['recibido'],
    when: (f) => f.esAnticipo,
    posting: [
      { role: 'anticipo_proveedores', side: 'debit', amount: A.subtotalNeto, description: 'Advance to vendor' },
      { role: 'iva_acreditable', side: 'debit', amount: A.ivaTrasladado, description: 'Creditable VAT on the advance', omitIfZero: true },
      { role: 'cxp', side: 'credit', amount: A.total, description: 'Vendor payable for advance' },
    ],
    decisions: ['anticipo_o_gasto'],
    notes:
      'An advance is an ASSET (a right to receive), not an expense. It is cancelled against the ' +
      'final CFDI, which will arrive together with an egreso carrying TipoRelacion 07.',
    priority: 90,
  },
  {
    id: 'ingreso_recibido_ppd',
    label: 'Purchase/expense on credit (PPD)',
    tipos: ['I'],
    directions: ['recibido'],
    when: (f) => f.metodoPago === 'PPD',
    posting: [
      { role: 'gasto', side: 'debit', amount: A.subtotalNeto, description: 'Expense/purchase' },
      { role: 'ieps_acreditable', side: 'debit', amount: A.ieps, description: 'IEPS', omitIfZero: true },
      { role: 'impuestos_locales_gasto', side: 'debit', amount: A.localesTras, description: 'Local taxes', omitIfZero: true },
      // The key difference vs PUE: the VAT is NOT creditable yet.
      { role: 'iva_pendiente_acreditar', side: 'debit', amount: A.ivaTrasladado, description: 'VAT pending crediting (credited with the REP)', omitIfZero: true },
      { role: 'isr_retenido_por_pagar', side: 'credit', amount: A.isrRet, description: 'ISR withheld from vendor', omitIfZero: true },
      { role: 'iva_retenido_por_pagar', side: 'credit', amount: A.ivaRet, description: 'VAT withheld from vendor', omitIfZero: true },
      { role: 'cxp', side: 'credit', amount: A.total, description: 'Vendor' },
    ],
    decisions: ['gasto_vs_activo', 'gasto_vs_anticipado', 'cuenta_ambigua', 'ieps_acreditable', 'por_cuenta_terceros'],
    notes:
      'Under PPD the VAT is credited when it is PAID (upon receiving the REP), not when the invoice ' +
      'arrives. Recording it as creditable VAT inflates the month\'s crediting and is an audit risk.',
    priority: 80,
  },
  {
    id: 'ingreso_recibido_pue',
    label: 'Cash purchase/expense (PUE)',
    tipos: ['I'],
    directions: ['recibido'],
    posting: [
      { role: 'gasto', side: 'debit', amount: A.subtotalNeto, description: 'Expense/purchase' },
      { role: 'ieps_acreditable', side: 'debit', amount: A.ieps, description: 'IEPS', omitIfZero: true },
      { role: 'impuestos_locales_gasto', side: 'debit', amount: A.localesTras, description: 'Local taxes', omitIfZero: true },
      { role: 'iva_acreditable', side: 'debit', amount: A.ivaTrasladado, description: 'Creditable VAT', omitIfZero: true },
      { role: 'isr_retenido_por_pagar', side: 'credit', amount: A.isrRet, description: 'ISR withheld from vendor', omitIfZero: true },
      { role: 'iva_retenido_por_pagar', side: 'credit', amount: A.ivaRet, description: 'VAT withheld from vendor', omitIfZero: true },
      { role: 'cxp', side: 'credit', amount: A.total, description: 'Vendor' },
    ],
    decisions: [
      'gasto_vs_activo', 'gasto_vs_anticipado', 'cuenta_ambigua', 'efectivo_no_deducible',
      'consumo_restaurante', 'combustible_efectivo', 'ieps_acreditable', 'por_cuenta_terceros',
    ],
    notes:
      'Credited to vendors and not to banks: the payment shows up when reconciling the bank ' +
      'statement. Crediting banks directly would double the outflow when the bank movement arrives.',
    priority: 70,
  },

  // ─────────────────────────────────────────────────────────
  // I — INGRESO, ISSUED (sales)
  // ─────────────────────────────────────────────────────────
  {
    id: 'ingreso_emitido_anticipo',
    label: 'Advance payment received from customer',
    tipos: ['I'],
    directions: ['emitido'],
    when: (f) => f.esAnticipo,
    posting: [
      { role: 'cxc', side: 'debit', amount: A.total, description: 'Customer receivable for advance' },
      { role: 'anticipo_clientes', side: 'credit', amount: A.subtotalNeto, description: 'Customer advances' },
      { role: 'iva_trasladado', side: 'credit', amount: A.ivaTrasladado, description: 'Output VAT on the advance', omitIfZero: true },
    ],
    notes: 'A customer advance is a LIABILITY until the revenue is earned.',
    priority: 90,
  },
  {
    id: 'ingreso_emitido_ppd',
    label: 'Sale on credit (PPD)',
    tipos: ['I'],
    directions: ['emitido'],
    when: (f) => f.metodoPago === 'PPD',
    posting: [
      { role: 'cxc', side: 'debit', amount: A.total, description: 'Customer' },
      { role: 'isr_retenido_a_favor', side: 'debit', amount: A.isrRet, description: 'ISR withheld by the customer', omitIfZero: true },
      { role: 'iva_retenido_a_favor', side: 'debit', amount: A.ivaRet, description: 'VAT withheld by the customer', omitIfZero: true },
      { role: 'ingreso', side: 'credit', amount: A.subtotalNeto, description: 'Sale' },
      { role: 'ieps_por_pagar', side: 'credit', amount: A.ieps, description: 'IEPS transferred', omitIfZero: true },
      // Symmetric to received PPD: the VAT is triggered on collection.
      { role: 'iva_trasladado_no_cobrado', side: 'credit', amount: A.ivaTrasladado, description: 'Output VAT not collected (triggered with the REP)', omitIfZero: true },
    ],
    notes:
      'The VAT on a PPD sale is triggered at the moment of collection. Booking it straight to ' +
      'output VAT brings the tax remittance forward.',
    priority: 80,
  },
  {
    id: 'ingreso_emitido_pue',
    label: 'Cash sale (PUE)',
    tipos: ['I'],
    directions: ['emitido'],
    posting: [
      { role: 'cxc', side: 'debit', amount: A.total, description: 'Customer' },
      { role: 'isr_retenido_a_favor', side: 'debit', amount: A.isrRet, description: 'ISR withheld by the customer', omitIfZero: true },
      { role: 'iva_retenido_a_favor', side: 'debit', amount: A.ivaRet, description: 'VAT withheld by the customer', omitIfZero: true },
      { role: 'ingreso', side: 'credit', amount: A.subtotalNeto, description: 'Sale' },
      { role: 'ieps_por_pagar', side: 'credit', amount: A.ieps, description: 'IEPS transferred', omitIfZero: true },
      { role: 'iva_trasladado', side: 'credit', amount: A.ivaTrasladado, description: 'Output VAT', omitIfZero: true },
    ],
    notes: 'Exports (Comercio Exterior complement) carry 0% VAT: there is no output VAT.',
    priority: 70,
  },

  // ─────────────────────────────────────────────────────────
  // E — EGRESO (credit notes, returns, advances)
  // ─────────────────────────────────────────────────────────
  {
    id: 'egreso_recibido_aplicacion_anticipo',
    label: 'Advance payment application (received)',
    tipos: ['E'],
    directions: ['recibido'],
    when: (f) => f.tipoRelacion === TIPO_RELACION.APLICACION_ANTICIPO,
    posting: [
      { role: 'cxp', side: 'debit', amount: A.total, description: 'Cancellation by advance application' },
      { role: 'anticipo_proveedores', side: 'credit', amount: A.subtotalNeto, description: 'Application of the advance' },
      { role: 'iva_acreditable', side: 'credit', amount: A.ivaTrasladado, description: 'Reversal of the advance VAT', omitIfZero: true },
    ],
    requiresLinkage: true,
    notes:
      'TipoRelacion 07: this is NOT a return. It cancels the advance against the final invoice. ' +
      'Treating it as a purchase return would invent revenue.',
    priority: 95,
  },
  {
    id: 'egreso_recibido_sustitucion',
    label: 'Substitution of a cancelled CFDI (received)',
    tipos: ['E'],
    directions: ['recibido'],
    when: (f) => f.tipoRelacion === TIPO_RELACION.SUSTITUCION,
    posting: null,
    requiresLinkage: true,
    notes:
      'TipoRelacion 04: the previous CFDI was cancelled and this one replaces it. The prior ' +
      'record must be reversed, not a new one created. Requires human review.',
    priority: 95,
  },
  {
    id: 'egreso_recibido_nota_credito',
    label: 'Credit note / return on purchases',
    tipos: ['E'],
    directions: ['recibido'],
    posting: [
      { role: 'cxp', side: 'debit', amount: A.total, description: 'Vendor credit note' },
      { role: 'devolucion_compras', side: 'credit', amount: A.subtotalNeto, description: 'Return/discount on purchases' },
      { role: 'iva_acreditable', side: 'credit', amount: A.ivaTrasladado, description: 'Reversal of creditable VAT', omitIfZero: true },
    ],
    requiresLinkage: true,
    notes:
      'Reduces the balance owed to the vendor. If the original invoice was PPD and its VAT sits in ' +
      '"pending crediting", the reversal must go against that same account.',
    priority: 70,
  },
  {
    id: 'egreso_emitido_aplicacion_anticipo',
    label: 'Advance payment application (issued)',
    tipos: ['E'],
    directions: ['emitido'],
    when: (f) => f.tipoRelacion === TIPO_RELACION.APLICACION_ANTICIPO,
    posting: [
      { role: 'anticipo_clientes', side: 'debit', amount: A.subtotalNeto, description: 'Application of the customer advance' },
      { role: 'iva_trasladado', side: 'debit', amount: A.ivaTrasladado, description: 'Reversal of the advance VAT', omitIfZero: true },
      { role: 'cxc', side: 'credit', amount: A.total, description: 'Cancellation against the customer' },
    ],
    requiresLinkage: true,
    notes: 'TipoRelacion 07: cancels the customer advance against the final invoice.',
    priority: 95,
  },
  {
    id: 'egreso_emitido_nota_credito',
    label: 'Credit note / return on sales',
    tipos: ['E'],
    directions: ['emitido'],
    posting: [
      { role: 'devolucion_ventas', side: 'debit', amount: A.subtotalNeto, description: 'Return/discount on sales' },
      { role: 'iva_trasladado', side: 'debit', amount: A.ivaTrasladado, description: 'Reversal of output VAT', omitIfZero: true },
      { role: 'cxc', side: 'credit', amount: A.total, description: 'Credit note to the customer' },
    ],
    requiresLinkage: true,
    notes: 'Sales returns is a results account contra to revenue, not an expense.',
    priority: 70,
  },

  // ─────────────────────────────────────────────────────────
  // P — PAYMENT (Payment Receipt Complement)
  // ─────────────────────────────────────────────────────────
  {
    id: 'pago_recibido',
    label: 'Payment made to vendor (REP received)',
    tipos: ['P'],
    directions: ['recibido'],
    posting: [
      { role: 'cxp', side: 'debit', amount: A.pagado, description: 'Payment applied to the vendor' },
      { role: 'banco', side: 'credit', amount: A.pagado, description: 'Bank outflow' },
    ],
    requiresLinkage: true,
    notes:
      'A type-P CFDI is NOT an expense: it is the application of a payment to prior PPD invoices. ' +
      'Recording it as an expense doubles the cost. NOTE: in production a REP does NOT post through ' +
      'this case — rep-linkage.ts matches it to (or creates) a payment via the payment door, which ' +
      'is what releases the parked VAT through the payment applications. Posting these two lines AND ' +
      'the payment would credit the bank twice. This case remains as the classifier description of ' +
      'the economic fact, not as a posting path.',
    priority: 80,
  },
  {
    id: 'pago_emitido',
    label: 'Collection received from customer (REP issued)',
    tipos: ['P'],
    directions: ['emitido'],
    posting: [
      { role: 'banco', side: 'debit', amount: A.pagado, description: 'Bank inflow' },
      { role: 'cxc', side: 'credit', amount: A.pagado, description: 'Collection applied to the customer' },
    ],
    requiresLinkage: true,
    notes:
      'It is not revenue: the revenue was recognized with the invoice. NOTE: in production a REP does ' +
      'NOT post through this case — rep-linkage.ts routes it through the payment door, which releases ' +
      'the deferred output VAT via the payment allocations. See pago_recibido for why.',
    priority: 80,
  },

  // ─────────────────────────────────────────────────────────
  // T — TRANSFER
  // ─────────────────────────────────────────────────────────
  {
    id: 'traslado',
    label: 'Merchandise transfer (no transfer of ownership)',
    tipos: ['T'],
    directions: ['emitido', 'recibido'],
    posting: null,
    notes:
      'No economic transaction: generates no journal entry. Only a movement between warehouses if ' +
      'the company tracks inventory by location. Usually carries a Carta Porte complement.',
    priority: 70,
  },

  // ─────────────────────────────────────────────────────────
  // N — PAYROLL
  // ─────────────────────────────────────────────────────────
  {
    id: 'nomina_emitida',
    label: 'Payroll receipt issued',
    tipos: ['N'],
    directions: ['emitido'],
    posting: [
      { role: 'sueldos_gasto', side: 'debit', amount: A.subtotalNeto, description: 'Wages and salaries (earnings)' },
      { role: 'isr_nomina_por_pagar', side: 'credit', amount: A.isrRet, description: 'ISR withheld from the employee', omitIfZero: true },
      { role: 'sueldos_por_pagar', side: 'credit', amount: A.total, description: 'Net payable to the employee' },
    ],
    notes:
      'The fine-grained breakdown (employee IMSS, loans, subsidy, sick leave) comes from the ' +
      'Nomina 1.2 complement and is handled by the payroll module. Only the base entry here.',
    priority: 70,
  },
  {
    id: 'nomina_recibida',
    label: 'Payroll receipt received',
    tipos: ['N'],
    directions: ['recibido'],
    posting: null,
    notes:
      'A company does not receive payroll receipts; if one shows up it is because the receiver RFC ' +
      'is an individual. It does not belong in the entity\'s books.',
    priority: 70,
  },

  // ─────────────────────────────────────────────────────────
  // R — WITHHOLDINGS (different XML schema)
  // ─────────────────────────────────────────────────────────
  {
    id: 'retenciones_recibido',
    label: 'Withholding certificate received',
    tipos: ['R'],
    directions: ['recibido'],
    posting: [
      { role: 'isr_retenido_a_favor', side: 'debit', amount: A.isrRet, description: 'ISR withheld in our favor', omitIfZero: true },
      { role: 'iva_retenido_a_favor', side: 'debit', amount: A.ivaRet, description: 'VAT withheld in our favor', omitIfZero: true },
      { role: 'ingreso', side: 'credit', amount: (f) => f.isrRetenido + f.ivaRetenido, description: 'Counterpart of the withholding' },
    ],
    notes:
      'The Withholdings CFDI uses the retenciones:Retenciones schema, NOT cfdi:Comprobante: ' +
      'the current parser would reject it. Needs its own parser.',
    priority: 70,
  },
];

/** Case applicable to these facts: the highest-priority one that matches. */
export function matchCase(facts: CfdiFacts): CfdiCase | undefined {
  return CASES
    .filter((c) => c.tipos.includes(facts.tipo) && c.directions.includes(facts.direction))
    .filter((c) => (c.when ? c.when(facts) : true))
    .sort((a, b) => b.priority - a.priority)[0];
}

export function getCase(id: string): CfdiCase | undefined {
  return CASES.find((c) => c.id === id);
}
