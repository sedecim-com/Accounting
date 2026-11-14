import Decimal from 'decimal.js';
import { query } from '../../database/connection.js';
import { CFDIParser, type CFDIParsed } from './cfdi-parser.js';
import { extractFacts, type CfdiFacts } from './cfdi-facts.js';
import { matchCase, type AccountRole, type CfdiCase } from './cfdi-taxonomy.js';
import {
  decisionsFor, getDecision, DEFAULT_THRESHOLDS,
  type DecisionPoint, type PolicyThresholds,
} from './cfdi-decisions.js';
import { legalParameterAt } from '../jurisdiction/legal-parameters.js';
import {
  isBorderRateFreight, isUnwithheldProfessionalFees, settleWithholding, substituteCfdiFinding,
  unwithheldFeesPolicyOf, withholdingByLaw, withholdingMismatchPolicyOf, withholdingQualifierOf,
  WITHHOLDING_MISMATCH_POLICIES, type LegalParameterReader,
} from './withholding-law.js';

// ============================================================
// CFDI CLASSIFIER
// Joins the three pieces: facts → taxonomy case → concrete
// entry, making the missing decisions explicit.
// It writes nothing: it returns the verdict so the caller
// decides (post, propose a draft, or ask).
// ============================================================

export interface ProposedLine {
  role: AccountRole;
  accountCode: string | null;
  accountName: string | null;
  debit: number | null;
  credit: number | null;
  description: string;
}

export interface PendingDecision {
  id: string;
  severity: DecisionPoint['severity'];
  question: string;
  context: string;
  options: Array<{ value: string; label: string }>;
  default?: string;
  topic: string;
  basis?: string;
}

export type Verdict =
  /** Ready to post: there is a case, accounts, and no blocking decisions. */
  | 'ready'
  /** Blocking decisions or role mappings still need to be resolved. */
  | 'needs_input'
  /** Generates no journal entry by design (transfer, informational). */
  | 'no_posting'
  /** Cannot be recorded (foreign, unstamped, unbalanced). */
  | 'blocked';

export interface Classification {
  facts: CfdiFacts;
  case: CfdiCase | null;
  verdict: Verdict;
  reason: string;
  lines: ProposedLine[];
  decisions: PendingDecision[];
  /** Roles without a configured account in the entity. */
  missingRoles: AccountRole[];
  /** Prior documents that must be linked (payments, credit notes). */
  linkage: Array<{ uuid: string; amount: number }>;
  warnings: string[];
}

const parser = new CFDIParser();

/** Key of a qualified mapping in the role map: `isr_retenido_por_pagar:lease`. */
export const qualifiedRole = (role: string, qualifier: string): string => `${role}:${qualifier}`;

/** Role → account map for the entity (account_roles table), qualified variants included. */
async function loadRoleMap(entityId: string): Promise<Map<string, { code: string; name: string }>> {
  const r = await query<{ role: string; qualifier: string | null; code: string; name: string }>(
    `SELECT ar.role, ar.qualifier, a.code, a.name
     FROM account_roles ar JOIN accounts a ON a.id = ar.account_id
     WHERE ar.entity_id = $1`,
    [entityId]
  );
  return new Map(r.rows.map((x) => [
    x.qualifier == null ? x.role : qualifiedRole(x.role, x.qualifier),
    { code: x.code, name: x.name },
  ]));
}

export interface ClassifyOptions {
  entityId: string;
  entityRfc: string;
  /** Already-known answers: { decisionId: chosenValue }. */
  answers?: Record<string, string>;
  /** If the issuer does not exist as a vendor, the decision is added. */
  vendorExists?: boolean;
  /** Whether the fiscal period for the CFDI date is open. */
  periodOpen?: boolean;
  /** CFDI status at the SAT, if validated. */
  satStatus?: 'vigente' | 'cancelado' | 'no_encontrado' | 'sin_validar';
  roleMap?: Map<string, { code: string; name: string }>;
  /** Policy-resolved thresholds; without them the defaults are used. */
  thresholds?: PolicyThresholds;
  /** Where the withholding rates are read; Postgres' `legal_parameters` by default. */
  readLegalParameter?: LegalParameterReader;
}

export async function classifyXml(xml: string, opts: ClassifyOptions): Promise<Classification> {
  const parsed: CFDIParsed = parser.parse(xml);
  return classifyParsed(parsed, opts);
}

export async function classifyParsed(
  parsed: CFDIParsed,
  opts: ClassifyOptions
): Promise<Classification> {
  const facts = extractFacts(parsed, opts.entityRfc);
  const matched = matchCase(facts) ?? null;
  const roleMap = opts.roleMap ?? (await loadRoleMap(opts.entityId));
  const warnings: string[] = [];

  // ── Arithmetic integrity: if the CFDI does not balance with itself, the
  // journal entry will not balance either. Better to stop it here with the reason.
  const suma = new Decimal(facts.subtotal)
    .minus(facts.descuento)
    .plus(facts.ivaTrasladado16)
    .plus(facts.ivaTrasladado8)
    .plus(facts.iepsTrasladado)
    .plus(facts.impuestosLocalesTrasladados)
    .minus(facts.isrRetenido)
    .minus(facts.ivaRetenido)
    .minus(facts.impuestosLocalesRetenidos);
  if (suma.minus(facts.total).abs().greaterThan('0.05') && facts.tipo !== 'P') {
    return blocked(
      facts, matched,
      `The CFDI does not balance: subtotal − discount + taxes = ${suma.toFixed(2)} but the total says ` +
        `${facts.total.toFixed(2)}. A tax complement may not have been read.`
    );
  }

  if (!matched) {
    return blocked(facts, null, `No rule exists for a CFDI of type "${facts.tipo}" ${facts.direction}.`);
  }
  if (matched.posting === null) {
    const isBlock = matched.priority >= 999 || facts.direction === 'ajeno';
    return {
      facts, case: matched,
      verdict: isBlock ? 'blocked' : 'no_posting',
      reason: matched.notes,
      lines: [], decisions: [], missingRoles: [], linkage: [], warnings,
    };
  }

  // ── MNE-001-148: professional fees that declare no ISR withheld follow the
  // firm's `fees_without_withholding`. By default nothing is proposed and the
  // CFDI waits for a substitute that declares the withholding.
  const feesPolicy = isUnwithheldProfessionalFees(facts)
    ? unwithheldFeesPolicyOf(opts.thresholds?.unwithheldFees)
    : undefined;
  if (feesPolicy) facts.feesWithoutWithholding = feesPolicy;
  if (feesPolicy === 'request_substitute_cfdi') {
    return { ...blocked(facts, matched, substituteCfdiFinding(facts)), verdict: 'needs_input' };
  }

  // ── Withholdings the entity owes by law (MNE-001-056): the rates come from
  // `legal_parameters`, and a missing rate fails closed instead of booking none.
  const law = await withholdingByLaw(
    facts,
    opts.readLegalParameter ?? ((key, onDate) => legalParameterAt('MX', key, onDate)),
    feesPolicy === 'withhold_by_law' ? 'professional_fees' : undefined
  );
  const answers = opts.answers ?? {};
  let heldForReview: string | null = null;
  let mismatchQuestion: PendingDecision | null = null;
  if (law) {
    const settled = settleWithholding(facts, law);
    facts.withholdingDue = settled.due;
    // MNE-001-057: a CFDI whose withholding differs from the law's follows
    // `withholding_mismatch`, the firm's answer to the question below. It is
    // said by name, never as an entry that merely fails to balance, and the
    // CFDI, a third party's, is never corrected.
    const onMismatch = feesPolicy ? null : withholdingMismatchPolicyOf(answers.withholding_mismatch);
    if (settled.mismatch && onMismatch === 'record_as_issued') {
      delete facts.withholdingDue;
      facts.withholdingMismatch = onMismatch;
      warnings.push(
        `${settled.mismatch.replace(/ The law's amounts are booked and the entry is held: .*$/, '')} ` +
          'Recorded as declared by policy withholding_mismatch=record_as_issued: the payer is jointly ' +
          'liable for the difference (CFF 26-I), the expense may not be deductible (LISR 27-V), and the ' +
          `close checklist lists it. ${law.basis}.`
      );
    } else if (settled.mismatch) {
      warnings.push(settled.mismatch);
    }
    if (feesPolicy === 'withhold_by_law') {
      heldForReview =
        'Professional fees with no ISR withheld declared, held for review by policy ' +
        `fees_without_withholding=withhold_by_law. ${settled.mismatch ?? law.basis}`;
    } else if (settled.mismatch && onMismatch === 'request_substitute_cfdi') {
      return {
        ...blocked(facts, matched,
          `${settled.mismatch} Policy withholding_mismatch=request_substitute_cfdi: ask the vendor for a ` +
            'substitute CFDI; nothing was written to the ledger.'),
        verdict: 'needs_input',
      };
    } else if (settled.mismatch && onMismatch === 'withhold_by_law') {
      heldForReview = `Held for review by policy withholding_mismatch=withhold_by_law. ${settled.mismatch}`;
    } else if (settled.mismatch && onMismatch === null) {
      heldForReview = settled.mismatch;
      mismatchQuestion = withholdingMismatchQuestion(facts, settled.mismatch);
    }
  }
  if (isBorderRateFreight(facts) && facts.direction === 'recibido' && facts.receptorRfc.length === 12) {
    warnings.push(
      'Land freight at the 8 % border VAT rate: no legal_parameters row sets its VAT withholding, so the ' +
        "carrier's declared withholding is booked unchecked. Verify it against RLIVA 3-II before paying."
    );
  }
  if (feesPolicy === 'record_as_issued') {
    warnings.push(
      'Professional fees from an individual (regime 612) recorded as issued, with no ISR withheld, by ' +
        'policy fees_without_withholding=record_as_issued: the expense may not be deductible (LISR 27-V) ' +
        'and the close checklist lists it.'
    );
  }

  // ── Decisions applicable given the facts + those from external context
  const effectiveThresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const points: DecisionPoint[] = decisionsFor(facts, effectiveThresholds).filter(
    (d) => matched.decisions?.includes(d.id) ?? false
  );
  if (opts.vendorExists === false && facts.direction === 'recibido') {
    const d = getDecision('proveedor_nuevo');
    if (d) points.push(d);
  }
  if (opts.periodOpen === false) {
    const d = getDecision('periodo_cerrado');
    if (d) points.push(d);
  }
  if (opts.satStatus === 'cancelado') {
    const d = getDecision('cfdi_cancelado');
    if (d) points.push(d);
  }
  if (opts.satStatus === 'sin_validar' || opts.satStatus === undefined) {
    warnings.push('The CFDI has not been validated against the SAT: its current status is unknown.');
  }

  const pending: PendingDecision[] = points
    .filter((d) => !(d.id in answers))
    .map((d) => ({
      id: d.id,
      severity: d.severity,
      question: d.question,
      // Los umbrales efectivos viajan al contexto y no sólo a `applies`: la
      // cifra que decide si la pregunta se hace es parte de la pregunta.
      context: d.context(facts, effectiveThresholds),
      // F02 · lleva_inventarios (E1.3): solo el literal 'perpetuos' habilita
      // la opción de inventario — un despacho a costo directo no puede
      // acabar con compras capitalizadas en 1140 por un click distraído.
      options: d.options
        .filter(
          (o) =>
            !(d.id === 'gasto_vs_activo' && o.value === 'inventario' &&
              effectiveThresholds.inventoryPolicy !== 'perpetuos')
        )
        .map((o) => ({ value: o.value, label: o.label })),
      default: d.default,
      topic: d.topic(facts),
      basis: d.basis,
    }));

  if (mismatchQuestion) pending.push(mismatchQuestion);

  // ── An answer can change the role of the expense line
  const roleOverride = resolveRoleOverride(points, answers);

  const lines: ProposedLine[] = [];
  const missingRoles: AccountRole[] = [];
  for (const t of matched.posting) {
    const amount = t.amount(facts);
    if (t.omitIfZero && Math.abs(amount) < 0.005) continue;
    const role = (t.role === 'gasto' && roleOverride ? roleOverride : t.role);
    // MNE-001-147: ISR withheld on a lease has its own mapping when the
    // withholding layout splits it (withholding-accounts.ts); otherwise the
    // default one.
    const withheldOn = role === 'isr_retenido_por_pagar' ? withholdingQualifierOf(facts) : null;
    const acct = (withheldOn && roleMap.get(qualifiedRole(role, withheldOn))) || roleMap.get(role);
    if (!acct) missingRoles.push(role);
    lines.push({
      role,
      accountCode: acct?.code ?? null,
      accountName: acct?.name ?? null,
      debit: t.side === 'debit' ? round2(amount) : null,
      credit: t.side === 'credit' ? round2(amount) : null,
      description: t.description,
    });
  }

  // ── The proposed entry must balance
  const debits = lines.reduce((s, l) => s.plus(l.debit ?? 0), new Decimal(0));
  const credits = lines.reduce((s, l) => s.plus(l.credit ?? 0), new Decimal(0));
  if (!debits.equals(credits)) {
    warnings.push(
      `The proposed entry does not balance: debits ${debits.toFixed(2)} vs credits ${credits.toFixed(2)}.`
    );
  }
  if (facts.esMonedaExtranjera) {
    warnings.push(
      `CFDI in ${facts.moneda} with exchange rate ${facts.tipoCambio}: amounts are recorded ` +
        `in the functional currency and an exchange difference may arise upon payment.`
    );
  }
  // Capitalizar sin depreciar sobrevalúa el activo y deja sin tomar una
  // deducción, mes a mes. Mientras el motor de depreciación no tenga puerta,
  // el aviso viaja con el documento para que la falta sea visible en la
  // revisión y no se descubra al cierre del ejercicio.
  if (lines.some((l) => l.role === 'activo_fijo')) {
    warnings.push(
      'Capitalized as a fixed asset: the amount is booked to the fixed-asset account, but the ' +
        'system does NOT register the asset nor compute its monthly depreciation. That deduction ' +
        'has to be recorded by hand until the depreciation engine has a way in.'
    );
  }
  // Diferir sin calendario deja el gasto fuera del resultado y el importe
  // parado en un activo para siempre: es el mismo defecto que el de arriba,
  // sin el consuelo de que al menos el bien exista. Hasta D1a NADA devengaba
  // la 1160, así que este aviso no se podía dar; ahora el paso que falta tiene
  // nombre y se dice con el documento delante, cuando el asiento de origen
  // todavía se sabe cuál es.
  if (lines.some((l) => l.role === 'gasto_anticipado')) {
    warnings.push(
      'Deferred to prepaid expenses: the amount is booked to the prepaid-expenses account (1160), ' +
        'but NO schedule accrues it on its own. Register it with `mnemosine prepaid create ' +
        '--origin cfdi --source-entry <this entry> --start <date> --end <date>` and post it month ' +
        'by month with `mnemosine prepaid run`. Without the schedule the expense never reaches ' +
        'the income statement and the asset stays on the balance sheet for good.'
    );
  }
  if (facts.importeExento > 0) {
    warnings.push(
      `Includes ${facts.importeExento.toFixed(2)} of EXEMPT items: that amount generates no ` +
        `creditable VAT (different from the 0% rate).`
    );
  }

  const hasBlocking = pending.some((p) => p.severity === 'blocking');
  const verdict: Verdict =
    hasBlocking || missingRoles.length > 0 || !debits.equals(credits) || heldForReview !== null
      ? 'needs_input'
      : 'ready';

  return {
    facts,
    case: matched,
    verdict,
    reason:
      verdict === 'ready'
        ? matched.label
        : missingRoles.length > 0
          ? `Missing accounts for roles: ${[...new Set(missingRoles)].join(', ')}`
          : (heldForReview ??
            `Requires a decision: ${pending.filter((p) => p.severity === 'blocking').map((p) => p.id).join(', ')}`),
    lines,
    decisions: pending,
    missingRoles: [...new Set(missingRoles)],
    linkage: matched.requiresLinkage
      ? facts.docsRelacionados.length > 0
        ? facts.docsRelacionados.map((d) => ({ uuid: d.uuid, amount: d.impPagado }))
        : facts.uuidsRelacionados.map((u) => ({ uuid: u, amount: facts.total }))
      : [],
    warnings,
  };
}

const MISMATCH_LABELS: Readonly<Record<(typeof WITHHOLDING_MISMATCH_POLICIES)[number], string>> = {
  request_substitute_cfdi: 'Hold it and ask the vendor for a substitute CFDI',
  withhold_by_law: "Book the law's withholding and hold the entry for review",
  record_as_issued: 'Record it as declared, with a warning in the close checklist',
};

/**
 * MNE-001-057: the question a withholding discrepancy leaves to the accountant.
 * Its options are the panel key's, and the firm's answer to
 * `withholding_mismatch` answers it (pre-registration-service.ts).
 */
function withholdingMismatchQuestion(f: CfdiFacts, mismatch: string): PendingDecision {
  return {
    id: 'withholding_mismatch',
    severity: 'blocking',
    question:
      `The withholdings declared by ${f.emisorRfc} differ from the ones the law requires. ` +
      'What happens to this CFDI? The answer of the panel key withholding_mismatch applies to every such CFDI.',
    context: mismatch,
    options: WITHHOLDING_MISMATCH_POLICIES.map((value) => ({ value, label: MISMATCH_LABELS[value] })),
    default: 'request_substitute_cfdi',
    topic: `withholding_mismatch:${f.emisorRfc}`,
    basis: 'LISR 106, 113-J, 116; LIVA 1-A; RLIVA 3; CFF 26-I (the payer is jointly liable)',
  };
}

/** If a decision's answer implies another account role, that one wins. */
function resolveRoleOverride(
  points: DecisionPoint[],
  answers: Record<string, string>
): AccountRole | null {
  for (const d of points) {
    const answer = answers[d.id];
    if (!answer) continue;
    const opt = d.options.find((o) => o.value === answer);
    if (opt?.role) return opt.role as AccountRole;
  }
  return null;
}

function blocked(facts: CfdiFacts, matched: CfdiCase | null, reason: string): Classification {
  return {
    facts, case: matched, verdict: 'blocked', reason,
    lines: [], decisions: [], missingRoles: [], linkage: [], warnings: [],
  };
}

function round2(n: number): number {
  return new Decimal(n).toDecimalPlaces(2).toNumber();
}

export { extractFacts } from './cfdi-facts.js';
export { CASES, matchCase } from './cfdi-taxonomy.js';
export { DECISIONS } from './cfdi-decisions.js';
