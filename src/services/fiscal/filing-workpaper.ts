import type pg from 'pg';
import Decimal from 'decimal.js';
import { getClient } from '../../database/connection.js';
import { predicadoSinCierre } from '../reporting/criterio-cierre.js';
import { rangoDelMes, type Hallazgo } from '../sat/diot/index.js';
import {
  buildIvaWorkpaper,
  type DocumentContribution,
  type FilingRounding,
  type IvaWorkpaper,
} from './iva-workpaper.js';
import {
  buildProvisionalIncomeTaxWorkpaper,
  type ProvisionalIncomeTaxWorkpaper,
} from './provisional-income-tax.js';

// ============================================================
// THE FILING WORKPAPER, PART 3/3 (#308, MNE-001-060)
//
// One paper for the month that joins the two settlements already built, the
// definitive IVA (MNE-001-058) and the provisional ISR of a persona moral
// (MNE-001-059), and adds what neither carries: where each line comes from.
//
// EVERY LINE SHOWS TWO COLUMNS and where it comes from:
//   · `cents`  — the ledger's four decimals rounded to the cent: what the
//                mayor can be checked against;
//   · `whole`  — the pesos to capture, by the panel's rounding (CFF art. 20);
//   · `source` — the documents and journal entries behind it, by kind.
//
// THE FIGURES ARE NOT RECOMPUTED HERE. The two builders own the arithmetic, the
// selection of documents and the rounding; this module only reads their result
// and looks the entries up.
//
// THE TRACE OF A LINE IS ITS OWN, NOT ITS ROLE ACCOUNT'S. The ledger holds one
// IVA line per document, so the entries that move iva_trasladado are the
// entries of EVERY rate: listing them under the 16 % line would show the 8 %
// invoice there, and a 0 %, exempt or "no objeto" document (which posts no IVA
// line at all) would appear under none of its own lines. The IVA builder
// therefore hands over what each DOCUMENT contributed, with the entries of its
// cash event (the invoice's entry for a PUE, the payments' for a PPD), and a
// line `<side>.<rate>.<base|iva>` lists the documents whose box for that rate
// and field is not zero. The role-account movement stays, apart, as the
// section's `ledgerTieOut`: the month's entries the settlement is tied out
// against, not the trace of any one line.
//
// The ISR lines trace the entries the builder itself counted (the withheld ISR
// ignores the opening balance and the entries that apply a withholding), and
// the revenue accounts before the zero-net filter. A captured line says
// `captured`; a derived one says `derived` and points, by `ref`, to the
// section's `inputs` that explain it (coefficient, losses, rate, proration…).
//
// Nothing is filed: a person reviews this paper and declares.
// ============================================================

export type FilingForm = 'iva' | 'isr';

export interface TraceEntry {
  entryId: string;
  entryNumber: string;
  entryDate: string;
  sourceType: string | null;
  description: string | null;
  /** What the entry nets to on the accounts listed beside it, debit positive, four decimals. */
  net: string;
}

/** One document's share of a line, with the entries of its cash event. */
export interface TraceDocument {
  documentId: string;
  documentNumber: string;
  documentKind: 'invoice' | 'bill';
  /** The document's own amount in this line, four decimals. */
  amount: string;
  entries: TraceEntry[];
}

export interface LineSource {
  /**
   * documents: the documents (and their entries) that make the line up.
   * accounts: the entries that move the listed accounts.
   * captured: a person gave it. derived: arithmetic on other lines or inputs.
   */
  kind: 'documents' | 'accounts' | 'captured' | 'derived';
  /** Role or account codes whose movement `net` is measured on. */
  accounts: string[];
  /** Every entry behind the line, each once. */
  entries: TraceEntry[];
  documents?: TraceDocument[];
  /** The key of the section `inputs` that explains a captured or derived line. */
  ref?: string;
}

export interface TracedLine {
  key: string;
  cents: string;
  whole: string;
  source: LineSource;
}

/** What a settlement rests on besides the ledger: a captured datum, a rate, a method. */
export type SectionInput = Record<string, string | number | boolean | null>;

export interface FormSection {
  form: FilingForm;
  rounding: { key: string; value: FilingRounding; defined: boolean };
  /** Null while a blocking finding stands: the paper then settles nothing. */
  resultCents: string | null;
  resultWhole: string | null;
  lines: TracedLine[];
  /** The data behind the captured and derived lines, each with its source document. */
  inputs: Record<string, SectionInput>;
  /** The month's entries on each IVA role account: the tie-out, not the trace of a line. */
  ledgerTieOut: Array<{ role: string; accounts: string[]; entries: TraceEntry[] }>;
  blockedBy: string[];
  findings: Hallazgo[];
}

export interface FilingWorkpaper {
  period: { year: number; month: number; from: string; through: string };
  /** Nothing here is filed: the paper says so itself, whatever reads it. */
  filed: false;
  sections: FormSection[];
}

export interface FilingWorkpaperOptions {
  tenantId: string;
  entityId: string;
  year: number;
  month: number;
  forms: readonly FilingForm[];
  /** Captured by a person: see the ISR workpaper. */
  ptuPaidInYear?: string;
  priorProvisionalPayments?: string;
  client?: pg.PoolClient;
}

type DocumentField = 'base' | 'iva' | 'withheld';

/** Where a line's trace comes from, by its key. */
export type SourceRule =
  | { documents: { side: 'charged' | 'creditable'; box: string; field: DocumentField } }
  | { roles: string[]; creditsOnly?: boolean }
  | { revenue: true }
  | { withheldIsr: true }
  | { kind: 'captured' | 'derived'; ref?: string };

const BOX_KEY = /^(charged|creditable)\.(tasa16|tasa8|tasa0|exento|otras:.+)\.(base|iva)$/;

/** The rule of an IVA line. Total over the line keys: an unknown key is derived, never silent. */
export function ivaSourceRule(key: string): SourceRule {
  const box = BOX_KEY.exec(key);
  if (box) {
    return { documents: { side: box[1] as 'charged' | 'creditable', box: box[2], field: box[3] as DocumentField } };
  }
  switch (key) {
    case 'charged.no_objeto.base': return { documents: { side: 'charged', box: 'no_objeto', field: 'base' } };
    case 'withheld_by_customers': return { documents: { side: 'charged', box: 'withheld', field: 'withheld' } };
    case 'withheld_to_remit': return { roles: ['iva_retenido_por_pagar'], creditsOnly: true };
    case 'prior_balance_in_favor': return { kind: 'captured', ref: 'prior_balance_in_favor' };
    case 'creditable.prorated': return { kind: 'derived', ref: 'proration' };
    default: return { kind: 'derived' };
  }
}

const ISR_RULES: Record<string, SourceRule> = {
  nominal_income: { revenue: true },
  estimated_profit: { kind: 'derived', ref: 'coefficient' },
  ptu_deducted: { kind: 'derived', ref: 'ptu_paid' },
  pending_losses_applied: { kind: 'derived', ref: 'losses' },
  tax_caused: { kind: 'derived', ref: 'rate' },
  prior_provisional_payments: { kind: 'captured', ref: 'prior_provisional' },
  withheld_income_tax: { withheldIsr: true },
};

export function isrSourceRule(key: string): SourceRule {
  return ISR_RULES[key] ?? { kind: 'derived' };
}

async function accountIdsOf(client: pg.PoolClient, tenantId: string, entityId: string, roles: string[]): Promise<string[]> {
  const { rows } = await client.query<{ account_id: string }>(
    `SELECT DISTINCT account_id FROM account_roles WHERE tenant_id = $1 AND entity_id = $2 AND role = ANY($3::text[])`,
    [tenantId, entityId, roles]
  );
  return rows.map((r) => r.account_id);
}

interface EntryRow {
  id: string; entry_number: string; entry_date: string; source_type: string | null; description: string | null; net: string;
}

const toTrace = (r: EntryRow): TraceEntry => ({
  entryId: r.id,
  entryNumber: r.entry_number,
  entryDate: r.entry_date,
  sourceType: r.source_type,
  description: r.description,
  net: new Decimal(r.net).toFixed(4),
});

/**
 * The posted entries that move the accounts between two dates, closing entries
 * aside. The ledger side of the paper: the tie-out and the revenue trace.
 * NOTE: journal_entries carries no tenant column; the entity is the boundary,
 * and every builder checks the entity belongs to the tenant before this runs.
 */
export async function entriesMoving(
  client: pg.PoolClient,
  entityId: string,
  accountIds: readonly string[],
  from: string,
  through: string
): Promise<TraceEntry[]> {
  if (accountIds.length === 0) return [];
  const { rows } = await client.query<EntryRow>(
    `SELECT je.id, je.entry_number, to_char(je.entry_date, 'YYYY-MM-DD') AS entry_date, je.source_type, je.description,
            SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0))::text AS net
       FROM journal_entries je
       JOIN journal_entry_lines l ON l.journal_entry_id = je.id
      WHERE je.entity_id = $1 AND je.status = 'posted'
        AND je.entry_date >= $2::date AND je.entry_date <= $3::date
        AND l.account_id = ANY($4::uuid[])
        ${predicadoSinCierre()}
      GROUP BY je.id, je.entry_number, je.entry_date, je.source_type, je.description
      ORDER BY je.entry_date, je.entry_number`,
    [entityId, from, through, [...accountIds]]
  );
  return rows.map(toTrace);
}

/** Entries by id, each with what it nets to on `accountIds`. The ids come from a builder's own decision. */
export async function entriesByIds(
  client: pg.PoolClient,
  entityId: string,
  entryIds: readonly string[],
  accountIds: readonly string[]
): Promise<TraceEntry[]> {
  if (entryIds.length === 0) return [];
  const { rows } = await client.query<EntryRow>(
    `SELECT je.id, je.entry_number, to_char(je.entry_date, 'YYYY-MM-DD') AS entry_date, je.source_type, je.description,
            COALESCE(SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0))
                     FILTER (WHERE l.account_id = ANY($3::uuid[])), 0)::text AS net
       FROM journal_entries je
       LEFT JOIN journal_entry_lines l ON l.journal_entry_id = je.id
      WHERE je.entity_id = $1 AND je.id = ANY($2::uuid[])
      GROUP BY je.id, je.entry_number, je.entry_date, je.source_type, je.description
      ORDER BY je.entry_date, je.entry_number`,
    [entityId, [...new Set(entryIds)], [...accountIds]]
  );
  return rows.map(toTrace);
}

const distinctEntries = (lists: TraceEntry[][]): TraceEntry[] => {
  const seen = new Map<string, TraceEntry>();
  for (const e of lists.flat()) if (!seen.has(e.entryId)) seen.set(e.entryId, e);
  return [...seen.values()].sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.entryNumber.localeCompare(b.entryNumber));
};

/** The amount one document put into a box of the paper, or zero. */
export function contributionAmount(c: DocumentContribution, box: string, field: DocumentField): string {
  if (field === 'withheld') return c.withheld.amount;
  if (box === 'no_objeto') return c.notSubject;
  if (box.startsWith('otras:')) {
    return c.desglose.otras.find((o) => o.etiqueta === box.slice('otras:'.length))?.[field] ?? '0.0000';
  }
  return c.desglose[box as 'tasa16' | 'tasa8' | 'tasa0' | 'exento'][field];
}

const ROLE_OF_SIDE = { charged: 'iva_trasladado', creditable: 'iva_acreditable' } as const;
const IVA_ROLES = ['iva_trasladado', 'iva_acreditable', 'iva_retenido_a_favor', 'iva_retenido_por_pagar'];

async function ivaSection(client: pg.PoolClient, o: FilingWorkpaperOptions, wp: IvaWorkpaper): Promise<FormSection> {
  const { period } = wp;
  const accountsOf = new Map<string, string[]>();
  const accountsFor = async (role: string): Promise<string[]> => {
    if (!accountsOf.has(role)) accountsOf.set(role, await accountIdsOf(client, o.tenantId, o.entityId, [role]));
    return accountsOf.get(role) as string[];
  };

  const lines: TracedLine[] = [];
  for (const l of wp.settlement?.lines ?? []) {
    const rule = ivaSourceRule(l.key);
    let source: LineSource;
    if ('documents' in rule) {
      const { side, box, field } = rule.documents;
      const role = field === 'withheld' ? 'iva_retenido_a_favor' : ROLE_OF_SIDE[side];
      const accountIds = await accountsFor(role);
      const documents: TraceDocument[] = [];
      for (const c of wp.contributions[side]) {
        const amount = contributionAmount(c, box, field);
        if (new Decimal(amount).isZero()) continue;
        const ids = field === 'withheld' ? (c.withheld.entryId ? [c.withheld.entryId] : []) : c.entryIds;
        documents.push({
          documentId: c.documentId, documentNumber: c.documentNumber, documentKind: c.documentKind, amount,
          entries: await entriesByIds(client, o.entityId, ids, accountIds),
        });
      }
      source = { kind: 'documents', accounts: [role], entries: distinctEntries(documents.map((d) => d.entries)), documents };
    } else if ('roles' in rule) {
      const moved = await entriesMoving(client, o.entityId, await accountsFor(rule.roles[0]), period.desde, period.hasta);
      source = {
        kind: 'accounts',
        accounts: rule.roles,
        entries: rule.creditsOnly ? moved.filter((e) => new Decimal(e.net).isNegative()) : moved,
      };
    } else if ('kind' in rule) {
      source = { kind: rule.kind, accounts: [], entries: [], ...(rule.ref ? { ref: rule.ref } : {}) };
    } else {
      source = { kind: 'derived', accounts: [], entries: [] };
    }
    lines.push({ key: l.key, cents: l.cents, whole: l.whole, source });
  }

  const ledgerTieOut: FormSection['ledgerTieOut'] = [];
  if (wp.settlement) {
    for (const role of IVA_ROLES) {
      const entries = await entriesMoving(client, o.entityId, await accountsFor(role), period.desde, period.hasta);
      ledgerTieOut.push({ role, accounts: [role], entries });
    }
  }

  const pr = wp.figures.proration;
  const inputs: Record<string, SectionInput> = {
    prior_balance_in_favor: {
      value: wp.figures.priorBalanceInFavor,
      capturedBy: 'a person: no filed declaration stores the balance yet (MNE-001-386)',
    },
    proration: {
      policy: wp.proration.key,
      method: wp.proration.value,
      policyDefined: wp.proration.defined,
      applied: pr !== null,
      referenceFrom: pr?.reference.desde ?? null,
      referenceThrough: pr?.reference.hasta ?? null,
      taxedActs: pr?.taxedActs ?? null,
      totalActs: pr?.totalActs ?? null,
      factor: pr?.factor ?? null,
      ivaPaid: pr?.paid ?? null,
      creditable: pr?.creditable ?? null,
    },
  };
  return {
    form: 'iva',
    rounding: wp.rounding,
    resultCents: wp.settlement?.resultCents ?? null,
    resultWhole: wp.settlement?.resultWhole ?? null,
    lines,
    inputs,
    ledgerTieOut,
    blockedBy: wp.blockedBy,
    findings: wp.findings,
  };
}

async function isrSection(
  client: pg.PoolClient,
  o: FilingWorkpaperOptions,
  wp: ProvisionalIncomeTaxWorkpaper
): Promise<FormSection> {
  const { from, through } = wp.period;
  const revenue = {
    accounts: wp.incomeTraceAccounts.map((a) => a.code),
    entries: await entriesMoving(client, o.entityId, wp.incomeTraceAccounts.map((a) => a.id), from, through),
  };
  const withheldIds = await accountIdsOf(client, o.tenantId, o.entityId, ['isr_retenido_a_favor']);
  const withheld = {
    accounts: ['isr_retenido_a_favor'],
    entries: await entriesByIds(client, o.entityId, wp.withholdingEntryIds, withheldIds),
  };
  const lines: TracedLine[] = (wp.settlement?.lines ?? []).map((l) => {
    const rule = isrSourceRule(l.key);
    const source: LineSource =
      'revenue' in rule ? { kind: 'accounts', ...revenue }
      : 'withheldIsr' in rule ? { kind: 'accounts', ...withheld }
      : 'kind' in rule ? { kind: rule.kind, accounts: [], entries: [], ...(rule.ref ? { ref: rule.ref } : {}) }
      : { kind: 'derived', accounts: [], entries: [] };
    return { key: l.key, cents: l.cents, whole: l.whole, source };
  });
  const c = wp.coefficient;
  const loss = wp.losses;
  const inputs: Record<string, SectionInput> = {
    ptu_paid: {
      value: new Decimal(o.ptuPaidInYear ?? '0').toFixed(4),
      capturedBy: 'a person (--ptu-paid)',
      eighthsElapsed: Math.max(wp.period.month - 4, 0),
      deductible: wp.figures.ptuDeductible,
      rule: 'LISR art. 14 fr. II: the PTU paid, in equal eighths from May',
    },
    prior_provisional: { value: wp.figures.priorProvisionalPayments, capturedBy: 'a person (--prior-provisional)' },
    ...(c ? { coefficient: {
      value: c.value, sourceFiscalYear: c.sourceFiscalYear, sourceFiledOn: c.sourceFiledOn, sourceDocument: c.sourceDocument,
    } } : {}),
    ...(loss ? { losses: {
      value: loss.value, sourceFiscalYear: loss.sourceFiscalYear, sourceFiledOn: loss.sourceFiledOn,
      sourceDocument: loss.sourceDocument, updatedThrough: loss.updatedThrough, updatedTo: loss.updatedTo,
      factor: loss.factor, applied: wp.figures.pendingLosses,
    } } : {}),
    ...(wp.rate ? { rate: { value: wp.rate.value, effectiveFrom: wp.rate.effectiveFrom, sourceUrl: wp.rate.sourceUrl } } : {}),
  };
  return {
    form: 'isr',
    rounding: wp.rounding,
    resultCents: wp.settlement?.resultCents ?? null,
    resultWhole: wp.settlement?.resultWhole ?? null,
    lines,
    inputs,
    ledgerTieOut: [],
    blockedBy: wp.blockedBy,
    findings: wp.findings,
  };
}

export async function generateFilingWorkpaper(opts: FilingWorkpaperOptions): Promise<FilingWorkpaper> {
  const { tenantId, entityId, year, month } = opts;
  const run = async (client: pg.PoolClient): Promise<FilingWorkpaper> => {
    const range = rangoDelMes(year, month);
    const sections: FormSection[] = [];
    for (const form of opts.forms) {
      sections.push(
        form === 'iva'
          ? await ivaSection(client, opts, await buildIvaWorkpaper({ tenantId, entityId, year, month, client }))
          : await isrSection(
              client,
              opts,
              await buildProvisionalIncomeTaxWorkpaper({
                tenantId, entityId, year, month, client,
                ptuPaidInYear: opts.ptuPaidInYear,
                priorProvisionalPayments: opts.priorProvisionalPayments,
              })
            )
      );
    }
    return { period: { year, month, from: range.desde, through: range.hasta }, filed: false, sections };
  };
  if (opts.client) return run(opts.client);
  // One snapshot for the builders and the trace, and no write possible: the
  // level travels in the BEGIN, so this cannot go through `withTransaction`
  // (it opens with a bare BEGIN and sets the tenant first). The tenant is set
  // the same way connection.ts does: set_config, local to the transaction.
  const client = await getClient();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);
    const paper = await run(client);
    await client.query('COMMIT');
    return paper;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
