/**
 * scripts/corpus-renewal.ts (docs/RUNBOOK.md; MNE-001-149, #133) must print the day
 * the freshness test of tests/ai/niif-registry.spec.ts turns red, so these cases
 * hold it to that test's own guard. The fetch is injected: no case uses the network.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { freshnessProblem, readFreshnessMaxMonths } from '../../scripts/build-niif-indice.js';
import {
  type RenewalRegistry,
  checkSources,
  collectSources,
  freshnessDueDate,
  renewalReport,
  sourceStatusLines,
} from '../../scripts/corpus-renewal.js';
import type { LegalParameterSeedRow } from '../../src/services/jurisdiction/legal-parameters-seed.js';

const ROOT = path.resolve(__dirname, '..', '..');
const startOf = (day: string) => new Date(`${day}T00:00:00Z`); // UTC, the calendar the guard reads
const lastSecondBefore = (day: string) => new Date(startOf(day).getTime() - 1000);

describe('the day the freshness test turns red (freshnessDueDate)', () => {
  it('is 2027-04-06 for verified_at 2026-09-06 and N = 6', () => {
    expect(freshnessDueDate('2026-09-06', 6)).toBe('2027-04-06');
  });

  it('exactly N months old still passes, the day before the due date passes, and the due date is red', () => {
    expect(freshnessProblem('2026-09-06', new Date('2027-03-06T12:00:00Z'), 6)).toBeNull();
    expect(freshnessProblem('2026-09-06', lastSecondBefore('2027-04-06'), 6)).toBeNull();
    expect(freshnessProblem('2026-09-06', startOf('2027-04-06'), 6)).toMatch(/7 months old; max 6/);
  });

  it('gives the date the guard gives at month ends, on a leap day and for another N', () => {
    const cases: [verifiedAt: string, maxMonths: number, due: string][] = [
      ['2026-08-31', 6, '2027-03-31'],
      ['2026-07-31', 6, '2027-03-01'], // February 2027 has no 31st: green until 1 March
      ['2027-08-29', 5, '2028-02-29'],
      ['2026-12-31', 6, '2027-07-31'],
      ['2026-01-01', 1, '2026-03-01'],
    ];
    for (const [verifiedAt, maxMonths, expected] of cases) {
      const due = freshnessDueDate(verifiedAt, maxMonths);
      expect(due, `${verifiedAt} with N = ${maxMonths}`).toBe(expected);
      expect(freshnessProblem(verifiedAt, lastSecondBefore(due), maxMonths), `${verifiedAt}: the day before`).toBeNull();
      expect(freshnessProblem(verifiedAt, startOf(due), maxMonths), `${verifiedAt}: on ${due}`).not.toBeNull();
    }
  });

  it('refuses a malformed verified_at and a limit that is not a positive whole number', () => {
    for (const bad of ['2026-9-6', '2026-13-45']) expect(() => freshnessDueDate(bad, 6), bad).toThrow(/not a YYYY-MM-DD/);
    for (const n of [0, -1, 1.5, Number.NaN]) expect(() => freshnessDueDate('2026-09-06', n), String(n)).toThrow(/positive whole/);
  });

  it('the RUNBOOK names the registry verified_at and the date the script computes for it', () => {
    const registryPath = path.join(ROOT, 'src', 'ai', 'docs', 'ifrs-registry.json');
    const { verified_at: verifiedAt } = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as RenewalRegistry;
    const runbook = fs.readFileSync(path.join(ROOT, 'docs', 'RUNBOOK.md'), 'utf8');
    const start = runbook.indexOf('## Renovación semestral del corpus normativo');
    expect(start, 'the RUNBOOK section').toBeGreaterThan(-1);
    const end = runbook.indexOf('\n## ', start + 1);
    const section = runbook.slice(start, end === -1 ? undefined : end);
    expect(section).toContain(`\`verified_at\` ${verifiedAt}`);
    expect(section).toContain(freshnessDueDate(verifiedAt, readFreshnessMaxMonths()));
  });
});

const card = (code: string, confidence: string, sources: string[]) => ({ code, title_es: `título ${code}`, confidence, sources });
const registry: RenewalRegistry = {
  verified_at: '2026-09-06',
  sources_of_truth: ['https://www.cinif.org.mx (convergencia NIF)', 'https://www.ifrs.org/projects/work-plan/'],
  standards: [
    card('NIF A-2', 'medium', ['https://www.cinif.org.mx/a2.pdf']),
    card('NIC 1 / IAS 1', 'high', ['https://www.ifrs.org/projects/work-plan/']),
  ],
};
const LIVA = 'https://www.diputados.gob.mx/LeyesBiblio/pdf/LIVA.pdf';
const lawRows: LegalParameterSeedRow[] = [
  { jurisdiction: 'MX', key: 'vat.standard_rate', effectiveFrom: '2010-01-01', value: '0.1600', unit: 'rate', sourceUrl: LIVA, sourceNote: 'LIVA art. 1' },
];

describe('the renewal report', () => {
  it('prints the age of verified_at, the red date, the medium cards and every law row with its source', () => {
    const text = renewalReport(registry, 6, lawRows, new Date('2026-11-15T12:00:00Z')).join('\n');
    expect(text).toContain('verified_at 2026-09-06 is 2 months old');
    expect(text).toContain('turns red on 2027-04-06 (UTC), in 142 days');
    expect(text).toContain('NIF A-2');
    expect(text).not.toContain('NIC 1 / IAS 1');
    expect(text).toContain(`vat.standard_rate = 0.1600 rate from 2010-01-01: ${LIVA}`);
  });

  it('says the freshness test is already red once the due date has come', () => {
    const text = renewalReport(registry, 6, lawRows, startOf('2027-04-06')).join('\n');
    expect(text).toContain('already red: verified_at 2026-09-06 is 7 months old; max 6');
  });

  it('is read-only: the script writes no file and starts no process (no gh, no git)', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'corpus-renewal.ts'), 'utf8');
    expect(source).not.toMatch(/\b(?:writeFile|appendFile|mkdir|rmSync|unlink|rename)\w*\(/);
    expect(source).not.toMatch(/child_process|\bexecFile|\bspawn/);
  });
});

describe('the sources, and their HTTP status with --http', () => {
  it('collects each source once, with every card or law row that cites it, and drops the note after a URL', () => {
    expect(collectSources(registry, lawRows)).toEqual([
      { url: 'https://www.cinif.org.mx', citedBy: ['sources_of_truth'] },
      { url: 'https://www.ifrs.org/projects/work-plan/', citedBy: ['sources_of_truth', 'NIC 1 / IAS 1'] },
      { url: 'https://www.cinif.org.mx/a2.pdf', citedBy: ['NIF A-2'] },
      { url: LIVA, citedBy: ['vat.standard_rate'] },
    ]);
  });

  it('reports every source on its own and keeps going when a host fails', async () => {
    const asked: string[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      asked.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('denied')) {
        // What Node's fetch throws when a proxy refuses the tunnel: the reason is two causes down.
        const refusal = new Error('Proxy response (403) !== 200 when HTTP Tunneling');
        throw new TypeError('fetch failed', { cause: Object.assign(new DOMException('Request was cancelled.'), { cause: refusal }) });
      }
      const response = new Response('body', { status: url.endsWith('/gone') ? 404 : 200 });
      if (!url.endsWith('/moved')) return response;
      return Object.defineProperties(response, { redirected: { value: true }, url: { value: 'https://ok.example/login' } });
    };
    const urls = ['https://ok.example/a', 'https://denied.example/b', 'https://ok.example/gone', 'https://ok.example/moved'];
    const results = await checkSources(urls.map((url, i) => ({ url, citedBy: [`card ${i}`] })), fakeFetch);

    expect(asked.sort(), 'one GET per source, nothing else').toEqual(urls.map((url) => `GET ${url}`).sort());
    const refused = 'fetch failed: Request was cancelled.: Proxy response (403) !== 200 when HTTP Tunneling';
    expect(results.map((r) => [r.status, r.error ?? r.finalUrl])).toEqual([
      [200, undefined], [null, refused], [404, undefined], [200, 'https://ok.example/login'],
    ]);
    const lines = sourceStatusLines(results);
    expect(lines).toContain(`  no answer  https://denied.example/b: ${refused}  (cited by card 1)`);
    expect(lines).toContain('  404  https://ok.example/gone  (cited by card 2)');
    expect(lines).toContain('  200  https://ok.example/moved → https://ok.example/login');
    expect(lines.at(-1)).toBe('2 answered below 400, 1 answered 400 or above, 1 gave no answer.');
  });
});
