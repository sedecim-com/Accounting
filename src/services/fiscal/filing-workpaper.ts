import type pg from 'pg';
import Decimal from 'decimal.js';
import { withTransaction } from '../../database/connection.js';
import { predicadoSinCierre } from '../reporting/criterio-cierre.js';
import { rangoDelMes, type Hallazgo } from '../sat/diot/index.js';
import { buildIvaWorkpaper, type FilingRounding, type IvaWorkpaper } from './iva-workpaper.js';
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
// EVERY LINE SHOWS TWO COLUMNS and the pólizas it rests on:
//   · `cents`  — the ledger's four decimals rounded to the cent: what the
//                mayor can be checked against;
//   · `whole`  — the pesos to capture, by the panel's rounding (CFF art. 20);
//   · `source` — the journal entries that move the accounts the line reads.
//
// THE FIGURES ARE NOT RECOMPUTED HERE. The two builders own the arithmetic and
// the rounding; this module only reads their result and looks the entries up.
//
// GRANULARITY OF THE TRACE: a line points to the pólizas that move its ROLE
// ACCOUNTS in the period (the same accounts the settlements tie out against),
// not to the subset that falls in its rate. The ledger holds one IVA line per
// document and the rate split comes from the document lines, so a 16 % line
// and an 8 % line share the pólizas of iva_trasladado. A derived line (a
// subtotal, the payable) points to no entry: it says it is derived.
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
  /** What the entry nets to on the traced accounts, debit positive, four decimals. */
  net: string;
}

export interface LineSource {
  /** captured: a person gave it. derived: arithmetic on other lines. */
  kind: 'accounts' | 'captured' | 'derived';
  /** Role or account codes whose entries are listed. */
  accounts: string[];
  entries: TraceEntry[];
}

export interface TracedLine {
  key: string;
  cents: string;
  whole: string;
  source: LineSource;
}

export interface FormSection {
  form: FilingForm;
  rounding: FilingRounding;
  /** Null while a blocking finding stands: the paper then settles nothing. */
  resultCents: string | null;
  resultWhole: string | null;
  lines: TracedLine[];
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

/** Which role accounts or revenue accounts a line reads, by its key. */
export type SourceRule = { roles: string[] } | { revenue: true } | 'captured' | 'derived';

const IVA_PREFIX_ROLE: Array<[string, string[]]> = [
  ['charged.', ['iva_trasladado']],
  ['creditable.', ['iva_acreditable']],
  ['withheld_by_customers', ['iva_retenido_a_favor']],
  ['withheld_to_remit', ['iva_retenido_por_pagar']],
];

/** The rule of an IVA line. Total over the line keys: an unknown key is derived, never silent. */
export function ivaSourceRule(key: string): SourceRule {
  if (key === 'prior_balance_in_favor') return 'captured';
  const hit = IVA_PREFIX_ROLE.find(([prefix]) => key.startsWith(prefix));
  return hit ? { roles: hit[1] } : 'derived';
}

const ISR_RULES: Record<string, SourceRule> = {
  nominal_income: { revenue: true },
  ptu_deducted: 'captured',
  prior_provisional_payments: 'captured',
  withheld_income_tax: { roles: ['isr_retenido_a_favor'] },
};

export function isrSourceRule(key: string): SourceRule {
  return ISR_RULES[key] ?? 'derived';
}

async function accountIdsOf(client: pg.PoolClient, tenantId: string, entityId: string, roles: string[]): Promise<string[]> {
  const { rows } = await client.query<{ account_id: string }>(
    `SELECT DISTINCT account_id FROM account_roles WHERE tenant_id = $1 AND entity_id = $2 AND role = ANY($3::text[])`,
    [tenantId, entityId, roles]
  );
  return rows.map((r) => r.account_id);
}

/** The posted entries that move the accounts between two dates, closing entries aside. */
export async function entriesMoving(
  client: pg.PoolClient,
  entityId: string,
  accountIds: readonly string[],
  from: string,
  through: string
): Promise<TraceEntry[]> {
  if (accountIds.length === 0) return [];
  const { rows } = await client.query<{
    id: string; entry_number: string; entry_date: string; source_type: string | null; description: string | null; net: string;
  }>(
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
  return rows.map((r) => ({
    entryId: r.id,
    entryNumber: r.entry_number,
    entryDate: r.entry_date,
    sourceType: r.source_type,
    description: r.description,
    net: new Decimal(r.net).toFixed(4),
  }));
}

/** Pure: attaches each line's source, given the entries already read per rule. */
export function traceLines(
  lines: ReadonlyArray<{ key: string; cents: string; whole: string }>,
  ruleOf: (key: string) => SourceRule,
  entriesFor: (rule: Exclude<SourceRule, string>) => { accounts: string[]; entries: TraceEntry[] }
): TracedLine[] {
  return lines.map((l) => {
    const rule = ruleOf(l.key);
    const source: LineSource =
      typeof rule === 'string'
        ? { kind: rule, accounts: [], entries: [] }
        : { kind: 'accounts', ...entriesFor(rule) };
    return { key: l.key, cents: l.cents, whole: l.whole, source };
  });
}

async function ivaSection(client: pg.PoolClient, o: FilingWorkpaperOptions, wp: IvaWorkpaper): Promise<FormSection> {
  const { period } = wp;
  const cache = new Map<string, { accounts: string[]; entries: TraceEntry[] }>();
  const read = async (roles: string[]) => {
    const id = roles.join(',');
    if (!cache.has(id)) {
      const ids = await accountIdsOf(client, o.tenantId, o.entityId, roles);
      cache.set(id, { accounts: roles, entries: await entriesMoving(client, o.entityId, ids, period.desde, period.hasta) });
    }
  };
  for (const l of wp.settlement?.lines ?? []) {
    const rule = ivaSourceRule(l.key);
    if (typeof rule !== 'string' && 'roles' in rule) await read(rule.roles);
  }
  const lines = traceLines(wp.settlement?.lines ?? [], ivaSourceRule, (rule) =>
    'roles' in rule ? (cache.get(rule.roles.join(',')) as { accounts: string[]; entries: TraceEntry[] }) : { accounts: [], entries: [] }
  );
  return {
    form: 'iva',
    rounding: wp.rounding.value,
    resultCents: wp.settlement?.resultCents ?? null,
    resultWhole: wp.settlement?.resultWhole ?? null,
    lines,
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
  const revenueCodes = wp.incomeAccounts.map((a) => a.code);
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM accounts WHERE entity_id = $1 AND code = ANY($2::text[])`,
    [o.entityId, revenueCodes]
  );
  const revenue = { accounts: revenueCodes, entries: await entriesMoving(client, o.entityId, rows.map((r) => r.id), from, through) };
  const withheldIds = await accountIdsOf(client, o.tenantId, o.entityId, ['isr_retenido_a_favor']);
  const withheld = { accounts: ['isr_retenido_a_favor'], entries: await entriesMoving(client, o.entityId, withheldIds, from, through) };
  const lines = traceLines(wp.settlement?.lines ?? [], isrSourceRule, (rule) => ('revenue' in rule ? revenue : withheld));
  return {
    form: 'isr',
    rounding: wp.rounding.value,
    resultCents: wp.settlement?.resultCents ?? null,
    resultWhole: wp.settlement?.resultWhole ?? null,
    lines,
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
  return opts.client ? run(opts.client) : withTransaction(run);
}
