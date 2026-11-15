/**
 * Read-only report for the twice-yearly renewal of the normative corpus: the age
 * of verified_at, the day the freshness test turns red, the confidence: medium
 * cards and the law rows; --http adds the HTTP status of every source. The
 * checklist is docs/RUNBOOK.md, «Renovación semestral del corpus normativo»
 * (MNE-001-149, #133). NIF and laws share the registry's verified_at (answer 2 of
 * 2026-11-15), so the legal-parameters seed is listed, and fetched, with the
 * cards. It writes nothing and opens no issue.
 *
 *   npx tsx scripts/corpus-renewal.ts [--http]
 */
import fs from 'node:fs';
import path from 'node:path';
import { freshnessProblem, monthsSince, readFreshnessMaxMonths } from './build-niif-indice.js';
import { LEGAL_PARAMETERS_SEED, type LegalParameterSeedRow } from '../src/services/jurisdiction/legal-parameters-seed.js';

const REGISTRY_PATH = path.join(__dirname, '..', 'src', 'ai', 'docs', 'ifrs-registry.json');
const DAY_MS = 86_400_000;
const TIMEOUT_MS = 15_000;
/** A few requests at a time: small public sites, and a proxy may cap open connections. */
const CONCURRENCY = 4;

export interface RenewalRegistry {
  verified_at: string;
  sources_of_truth: string[];
  standards: { code: string; title_es: string; confidence: string; sources: string[] }[];
}

/** A URL, who cites it and, once checked, its HTTP status: null when none came back, and `error` says why. */
export interface SourceStatus {
  url: string;
  citedBy: string[];
  status: number | null;
  finalUrl?: string;
  error?: string;
}
export type Source = Pick<SourceStatus, 'url' | 'citedBy'>;

/**
 * The first UTC day on which freshnessProblem reports verified_at as stale. It
 * asks the guard itself, day by day, so the date printed and the day CI turns
 * red cannot drift apart at a month end: for verified_at 2026-07-31 and N = 6 the
 * age would reach seven months on a 31 February, and the guard waits for 1 March.
 */
export function freshnessDueDate(verifiedAt: string, maxMonths: number): string {
  if (!Number.isInteger(maxMonths) || maxMonths < 1) {
    throw new Error(`the limit must be a positive whole number of months, not ${maxMonths}`);
  }
  const verified = new Date(`${verifiedAt}T00:00:00Z`);
  const problem = freshnessProblem(verifiedAt, verified, maxMonths);
  if (problem) throw new Error(problem);
  // Before this month the age is at most maxMonths; the guard turns red within it or on the 1st after it.
  const day = new Date(Date.UTC(verified.getUTCFullYear(), verified.getUTCMonth() + maxMonths + 1, 1));
  while (freshnessProblem(verifiedAt, day, maxMonths) === null) day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

/** What a person reads before renewing; it needs no network. */
export function renewalReport(
  registry: RenewalRegistry, maxMonths: number, lawRows: readonly LegalParameterSeedRow[], today: Date,
): string[] {
  const verifiedAt = registry.verified_at;
  const due = freshnessDueDate(verifiedAt, maxMonths);
  const problem = freshnessProblem(verifiedAt, today, maxMonths);
  const todayStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const medium = registry.standards.filter((card) => card.confidence === 'medium');
  return [
    `Normative corpus: src/ai/docs/ifrs-registry.json, with N = ${maxMonths} months (docs/PROCESS.md).`,
    `  verified_at ${verifiedAt} is ${monthsSince(verifiedAt, today)} months old.`,
    problem
      ? `  The freshness test is already red: ${problem}.`
      : `  The freshness test turns red on ${due} (UTC), in ${(Date.parse(due) - todayStart) / DAY_MS} days. Renew before then.`,
    `  ${medium.length} cards with confidence: medium, to re-read against an open source:`,
    ...medium.map((card) => `    - ${card.code}: ${card.title_es}`),
    `Laws, under the same verified_at: ${lawRows.length} rows of src/services/jurisdiction/legal-parameters-seed.ts to check against their sourceUrl:`,
    ...lawRows.map((row) => `    - ${row.jurisdiction} ${row.key} = ${row.value} ${row.unit} from ${row.effectiveFrom}: ${row.sourceUrl}`),
    '  The payroll tables, the legal_parameters rows of the migrations and the manuals that cite law: see docs/RUNBOOK.md.',
  ];
}

/** Every source once, in the order first cited; a note after a URL ("https://… (convergencia NIF)") is dropped. */
export function collectSources(registry: RenewalRegistry, lawRows: readonly LegalParameterSeedRow[]): Source[] {
  const citedBy = new Map<string, string[]>();
  const cite = (entry: string, by: string): void => {
    const url = /^\S+/.exec(entry.trim())?.[0] ?? entry;
    const list = citedBy.get(url) ?? [];
    if (!list.includes(by)) list.push(by);
    citedBy.set(url, list);
  };
  for (const entry of registry.sources_of_truth) cite(entry, 'sources_of_truth');
  for (const card of registry.standards) for (const url of card.sources) cite(url, card.code);
  for (const row of lawRows) cite(row.sourceUrl, row.key);
  return [...citedBy].map(([url, by]) => ({ url, citedBy: by }));
}

/** fetch says only "fetch failed"; the reason (a DNS miss, a TLS refusal, a proxy's 403) is causes below. */
function describeError(error: unknown): string {
  const messages: string[] = [];
  for (let cause = error; cause instanceof Error && messages.length < 5; cause = cause.cause) messages.push(cause.message);
  return (messages.length > 0 ? messages.join(': ') : String(error)).replace(/\s+/g, ' ');
}

async function statusOf(source: Source, fetchImpl: typeof fetch): Promise<SourceStatus> {
  let response: Response;
  try {
    response = await fetchImpl(source.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    return { ...source, status: null, error: describeError(error) };
  }
  // The status is all this needs: cancelling the body spares downloading a whole PDF.
  await response.body?.cancel().catch(() => undefined);
  return { ...source, status: response.status, ...(response.redirected ? { finalUrl: response.url } : {}) };
}

/**
 * One GET per source, a few at a time. A host that fails, times out or refuses
 * the TLS handshake becomes that source's error and the rest go on. The fetch
 * is injectable, so the tests need no network.
 */
export async function checkSources(sources: readonly Source[], fetchImpl: typeof fetch = fetch): Promise<SourceStatus[]> {
  const results: SourceStatus[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < sources.length) {
      const index = next++;
      results[index] = await statusOf(sources[index], fetchImpl);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

/** One line per source; those that did not answer below 400 name who cites them. */
export function sourceStatusLines(results: readonly SourceStatus[]): string[] {
  const answered = (r: SourceStatus): boolean => r.status !== null && r.status < 400;
  const lines = results.map((r) => {
    const moved = r.finalUrl ? ` → ${r.finalUrl}` : '';
    const citers = answered(r) ? '' : `  (cited by ${r.citedBy.join(', ')})`;
    return `  ${r.status ?? 'no answer'}  ${r.url}${moved}${r.error ? `: ${r.error}` : ''}${citers}`;
  });
  const ok = results.filter(answered).length;
  const silent = results.filter((r) => r.status === null).length;
  return [
    `HTTP status of ${results.length} sources (GET, ${TIMEOUT_MS / 1000} s timeout each):`,
    ...lines,
    `${ok} answered below 400, ${results.length - ok - silent} answered 400 or above, ${silent} gave no answer.`,
  ];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== '--http');
  if (unknown.length > 0) {
    console.error(`Unknown argument: ${unknown.join(' ')}. Usage: npx tsx scripts/corpus-renewal.ts [--http]`);
    process.exitCode = 2;
    return;
  }
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8')) as RenewalRegistry;
  console.log(renewalReport(registry, readFreshnessMaxMonths(), LEGAL_PARAMETERS_SEED, new Date()).join('\n'));
  if (!args.includes('--http')) {
    console.log('No source was fetched: --http fetches each one and prints its HTTP status (needs the network).');
    return;
  }
  console.log(sourceStatusLines(await checkSources(collectSources(registry, LEGAL_PARAMETERS_SEED))).join('\n'));
}

if (process.argv[1] && __filename === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
