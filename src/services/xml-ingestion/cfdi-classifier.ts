import Decimal from 'decimal.js';
import { query } from '../../database/connection.js';
import { CFDIParser, type CFDIParsed } from './cfdi-parser.js';
import { extractFacts, type CfdiFacts } from './cfdi-facts.js';
import { matchCase, type AccountRole, type CfdiCase } from './cfdi-taxonomy.js';
import {
  decisionsFor, getDecision, DEFAULT_THRESHOLDS,
  type DecisionPoint, type PolicyThresholds,
} from './cfdi-decisions.js';

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

/** Role → account map for the entity (account_roles table). */
async function loadRoleMap(entityId: string): Promise<Map<string, { code: string; name: string }>> {
  const r = await query<{ role: string; code: string; name: string }>(
    `SELECT ar.role, a.code, a.name
     FROM account_roles ar JOIN accounts a ON a.id = ar.account_id
     WHERE ar.entity_id = $1 AND ar.qualifier IS NULL`,
    [entityId]
  );
  return new Map(r.rows.map((x) => [x.role, { code: x.code, name: x.name }]));
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

  // ── Decisions applicable given the facts + those from external context
  const points: DecisionPoint[] = decisionsFor(facts, opts.thresholds ?? DEFAULT_THRESHOLDS).filter(
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

  const answers = opts.answers ?? {};
  const pending: PendingDecision[] = points
    .filter((d) => !(d.id in answers))
    .map((d) => ({
      id: d.id,
      severity: d.severity,
      question: d.question,
      context: d.context(facts),
      options: d.options.map((o) => ({ value: o.value, label: o.label })),
      default: d.default,
      topic: d.topic(facts),
      basis: d.basis,
    }));

  // ── An answer can change the role of the expense line
  const roleOverride = resolveRoleOverride(points, answers);

  const lines: ProposedLine[] = [];
  const missingRoles: AccountRole[] = [];
  for (const t of matched.posting) {
    const amount = t.amount(facts);
    if (t.omitIfZero && Math.abs(amount) < 0.005) continue;
    const role = (t.role === 'gasto' && roleOverride ? roleOverride : t.role) as AccountRole;
    const acct = roleMap.get(role);
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
  if (facts.importeExento > 0) {
    warnings.push(
      `Includes ${facts.importeExento.toFixed(2)} of EXEMPT items: that amount generates no ` +
        `creditable VAT (different from the 0% rate).`
    );
  }

  const hasBlocking = pending.some((p) => p.severity === 'blocking');
  const verdict: Verdict =
    hasBlocking || missingRoles.length > 0 || !debits.equals(credits) ? 'needs_input' : 'ready';

  return {
    facts,
    case: matched,
    verdict,
    reason:
      verdict === 'ready'
        ? matched.label
        : missingRoles.length > 0
          ? `Missing accounts for roles: ${[...new Set(missingRoles)].join(', ')}`
          : `Requires a decision: ${pending.filter((p) => p.severity === 'blocking').map((p) => p.id).join(', ')}`,
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
