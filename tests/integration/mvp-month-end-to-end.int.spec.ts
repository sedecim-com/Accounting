import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { BUILTIN_PROFILES } from '../../src/ai/providers/config.js';

// ============================================================
// MVP-E2E · THE MONTH OF AN SME, END TO END (#311, MNE-001-097)
//
// docs/MVP.md §1 defines the MVP as nine steps a firm can run from the
// terminal. This file is that definition made executable: one synthetic
// company, December 2025, driven ONLY through the real binary
// (`src/cli/mnemosine.ts` in a child process, the way an accountant types
// it), without an AI provider, against the ephemeral database that
// tests/integration/global-setup.ts creates and drops for every run.
//
// WHAT IS GREEN AND WHAT IS `it.todo`. Every step that already works runs for
// real; every one that does not is an `it.todo` naming the backlog task(s)
// in docs/backlog/PRD-001.json that will turn it green. MNE-001-098 closes
// #311 when this file has no `it.todo` left, so the route to the MVP is the
// list below and it empties itself.
//
// WHY DECEMBER 2025. Period states depend on today's date (a month after
// today is `future`), so a month in 2026 would change meaning as the calendar
// moves. December 2025 is always in the past, and it is also the last month
// of the year, which is where the fiscal-year close with period 13 belongs.
//
// THE FIGURES ARE WRITTEN BY HAND, never copied from the output: a test
// generated from the system's own answer cannot fail. Each constant carries
// its derivation from the opening and the six documents of the month.
//
// NOTHING IS SEEDED WITH SQL. The firm and its user come from `tenant create`
// and `user create`, like every other row of the month (MNE-001-406).
//
// THE OPENING IS MIGRATED, NOT TYPED (MNE-001-407). The company arrives from
// another system with its 2024 books in Anexo 24 XML: `chart import` and
// `opening-balance import` post them on 2025-01-01, the first day of the
// fiscal year, and January to November, which hold nothing else, are
// hard-closed in order so that their carry-forward opens December with them.
//
// NO MODEL PROVIDER, AND THE FIRST TEST PROVES IT. In the child (`childEnv`)
// the helper blanks MNEMOSINE_PROVIDER, every ANTHROPIC_* variable, the
// credential each built-in profile names (`api_key_env` of BUILTIN_PROFILES)
// and the two switches that would let a .env override those blanks
// (DOTENV_OVERRIDE, DOTENV_CONFIG_OVERRIDE), and it points HOME and
// XDG_CONFIG_HOME at a throwaway directory. So none of these variables, in the
// shell or in a .env of whoever runs the suite, can turn the manual path into
// a model's. A mnemosine.config.json in the checkout can declare providers of
// its own (a key, an api_key_cmd, a default_provider) that no blank reaches,
// so the first test fails when the child loads one; CI has none.
//
// NO POSTGRES, NO RUN: without TEST_ADMIN_DATABASE_URL (a role that can
// CREATE DATABASE) the integration suite refuses to start, and
// `scripts/verify.sh` reports that SKIP with its reason. CI has the database.
// ============================================================

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'src', 'cli', 'mnemosine.ts');
/** One CLI invocation costs a tsx start-up (~5 s); a step runs several. */
const STEP_TIMEOUT_MS = 240_000;

// SAT's published test RFC for the company; synthetic ones for its parties.
const COMPANY_RFC = 'EKU9003173C9';
const CUSTOMER_RFC = 'SIN060101AB1';
const VENDOR_RFC = 'PRV060101AB1';

// ── THE OPENING, FROM THE PREVIOUS SYSTEM ──────────────────────────────
// The books at 2024-12-31: the chart (CtaCatalogo) and the trial balance
// (BalanzaComprobacion) of the migration are both written from these rows.
// Every code but 1320, a rent deposit, is one the seeded chart already has,
// so `chart import` creates 1320 alone; SubCtaDe and Nivel follow the seeded
// tree, where the role accounts 1135 and 2125 hang from no parent. Eight
// accounts carry a balance of their own:
//   1120  3,480.00 is one open invoice, 3,000 + 480 of IVA: uncollected, so
//         its 480 sits in 2125, IVA trasladado no cobrado
//   2110  2,320.00 is one open bill, 2,000 + 320 of IVA: unpaid, so its 320
//         waits in 1135 until it is paid (LIVA art. 5 fr. III)
// Debits 100,000 + 3,480 + 320 + 4,000 = 107,800 = credits 2,320 + 480
// + 100,000 + 5,000: the entry foots by itself, with no plug. As the Anexo 24
// asks, the parents declare their subaccounts inside, so they carry nothing
// of their own to post: 1000 = 103,480 + 4,000; 1100 = 100,000 + 3,480;
// 2000 = 2100 = 2,320; 3000 = 100,000 + 5,000.
const OPENING_2024 = [
  // NumCta, Desc, CodAgrup, SubCtaDe, Nivel, Natur, SaldoFin
  ['1000', 'Activo', '100', '', 1, 'D', '107480.00'],
  ['1100', 'Activo Circulante', '100.01', '1000', 2, 'D', '103480.00'],
  ['1110', 'Caja y Bancos', '102', '1100', 3, 'D', '100000.00'],
  ['1111', 'Banco Nacional - MXN', '102.01', '1110', 4, 'D', '100000.00'],
  ['1120', 'Cuentas por Cobrar', '105.01', '1100', 3, 'D', '3480.00'],
  ['1135', 'IVA Pendiente de Acreditar', '119.01', '', 1, 'D', '320.00'],
  ['1300', 'Activo Diferido', '100.02', '1000', 2, 'D', '4000.00'],
  ['1320', 'Depósitos en Garantía', '184.02', '1300', 3, 'D', '4000.00'],
  ['2000', 'Pasivo', '200', '', 1, 'A', '2320.00'],
  ['2100', 'Pasivo Circulante', '200.01', '2000', 2, 'A', '2320.00'],
  ['2110', 'Cuentas por Pagar', '201.01', '2100', 3, 'A', '2320.00'],
  ['2125', 'IVA Trasladado No Cobrado', '209.01', '', 1, 'A', '480.00'],
  ['3000', 'Capital Contable', '300', '', 1, 'A', '105000.00'],
  ['3100', 'Capital Social', '301.01', '3000', 2, 'A', '100000.00'],
  ['3200', 'Resultado de Ejercicios Anteriores', '304.01', '3000', 2, 'A', '5000.00'],
] as const;
const OPENING_DEBITS = '107800.00';
const SAT_NS = 'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3';
const CHART_XML =
  `<?xml version="1.0" encoding="UTF-8"?><catalogocuentas:Catalogo xmlns:catalogocuentas="${SAT_NS}/CatalogoCuentas" ` +
  `Version="1.3" RFC="${COMPANY_RFC}" Mes="12" Anio="2024">` +
  OPENING_2024.map(([num, desc, group, parent, level, nature]) =>
    `<catalogocuentas:Ctas CodAgrup="${group}" NumCta="${num}" Desc="${desc}"` +
    `${parent ? ` SubCtaDe="${parent}"` : ''} Nivel="${level}" Natur="${nature}"/>`).join('') +
  '</catalogocuentas:Catalogo>';
// No movement in December 2024, so SaldoIni is SaldoFin: the cutoff is what matters.
const TRIAL_BALANCE_XML =
  `<?xml version="1.0" encoding="UTF-8"?><BCE:Balanza xmlns:BCE="${SAT_NS}/BalanzaComprobacion" ` +
  `Version="1.3" RFC="${COMPANY_RFC}" Mes="12" Anio="2024" TipoEnvio="N">` +
  OPENING_2024.map(([num, , , , , , balance]) =>
    `<BCE:Ctas NumCta="${num}" SaldoIni="${balance}" Debe="0.00" Haber="0.00" SaldoFin="${balance}"/>`).join('') +
  '</BCE:Balanza>';
// The documents behind 1120 and 2110, as the previous system's subledgers list
// them. Parties of their own, so that section 3's 'Cliente Sintetico' and
// 'Proveedor Sintetico' still name one each.
const OPEN_DOCUMENTS = [
  { cuenta: '1120', documento: 'A-2024-117', contraparte: 'Distribuidora del Bajio SA de CV', rfc: 'DBA060101AB1',
    fecha: '2024-12-10', vencimiento: '2025-01-09', importe: '3480.00' },
  { cuenta: '2110', documento: 'F-2024-881', contraparte: 'Servicios Logisticos del Norte SA de CV', rfc: 'SLN060101AB1',
    fecha: '2024-12-12', vencimiento: '2025-01-11', importe: '2320.00', ivaRate: '0.16' },
];

// ── THE MONTH, BY HAND ──────────────────────────────────────────────────
//   12-01 computers      1220 Dr 36,000.00 / 1111 Cr 36,000.00
//   12-05 invoice        1120 Dr 11,600.00 / 4100 Cr 10,000.00, 2120 Cr 1,600.00
//                        (16 % of 10,000; no MetodoPago on a typed invoice → PUE)
//   12-08 bill           6100 Dr 5,000.00, 1135 Dr 800.00 / 2110 Cr 5,800.00
//                        (no MetodoPago on a typed bill → PPD, IVA parked in 1135)
//   12-15 receipt        bank Dr 5,800.00 / 1120 Cr 5,800.00 (half the invoice)
//   12-18 credit note    4400 Dr 1,000.00, 2120 Dr 160.00 / 1120 Cr 1,160.00
//   12-20 payment        2110 Dr 5,800.00 / bank Cr 5,800.00,
//                        and the paid IVA moves 1135 → 1130: 800.00
//   12-31 depreciation   6140 Dr 900.00 / 1290 Cr 900.00, posted by the close:
//                        computer class, 30 % LISR maximum → 40-month book
//                        life; whole-month convention, so 36,000 / 40
// Debits of December: 36,000 + 11,600 + 5,800 + 5,800 + 1,160 + 5,800 + 800
// + 900 = 67,860. The dossier seals the trial balance as of 12-31, so it
// counts the opening of 01-01 too: 107,800 + 67,860.
const SEALED_DEBITS = '175660.00';
const ENDING = {
  '1111': '64000.00', // 100,000 opening − 36,000 − 5,800 + 5,800 (see MNE-001-039 in step 4)
  '1120': '8120.00', // 3,480 opening + 11,600 − 5,800 − 1,160
  '1130': '800.00',
  '1135': '320.00', // the opening's; the 800 parked on 12-08 moved to 1130 on 12-20
  '1220': '36000.00',
  '1290': '-900.00', // accumulated depreciation, credit balance
  '1320': '4000.00', // the deposit, untouched since the opening
  '2110': '-2320.00', // the opening bill; −5,800 on 12-08 and +5,800 on 12-20 net to nothing
  '2120': '-1440.00', // −1,600 + 160, credit balance
  '2125': '-480.00', // the opening invoice's IVA, still uncollected
  '3100': '-100000.00',
  '3200': '-5000.00',
  '4100': '-10000.00',
  '4400': '1000.00',
  '6100': '5000.00',
  '6140': '900.00',
} as const;
const NET_SALES = '9000.00'; // 10,000 − 1,000 returned
const NET_INCOME = '3100.00'; // 9,000 − 5,000 − 900
const TOTAL_ASSETS = '112340.00'; // 64,000 + 8,120 + 800 + 320 + 36,000 − 900 + 4,000
const TOTAL_LIABILITIES = '4240.00'; // 2,320 + 1,440 + 480
const TOTAL_EQUITY = '108100.00'; // 100,000 + 5,000 + 3,100
// Indirect method: 3,100 + 900 (depreciation, no cash) − 4,640 (AR up) − 800
// (IVA credit up) + 1,440 (IVA payable up) = 0, which is the 5,800 received
// minus the 5,800 paid. 1135 and 2110 end December where they began it.
const OPERATING_CASH = '0.00';
const INVESTING_CASH = '-36000.00'; // the computers
const FINANCING_CASH = '0.00'; // the capital came in with the opening, in January

// The firm's handle, its owner's login and that login's password: synthetic,
// and fresh on every run, so none of them can name a real account.
const suffix = uuidv4().replace(/-/g, '').slice(0, 12);
const userEmail = `month-${suffix}@example.test`;
const password = `month-${uuidv4()}`;
let tenantId = '';
let entityId = '';
/** The opening's entry number, as `opening-balance import --json` printed it. */
let openingEntry = '';
let workDir: string;

/**
 * The variables that hand the child a model provider by name: the three of
 * MNE-001-406's acceptance, and the credential each built-in profile names
 * (`api_key_env`), read from the profiles so that a provider added there is
 * kept out the day it lands. `childEnv` blanks them. A provider declared in a
 * mnemosine.config.json names its own variables, so the first test catches
 * that file instead.
 */
const PROVIDER_ENV = [
  ...new Set([
    'MNEMOSINE_PROVIDER',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    ...Object.values(BUILTIN_PROFILES).flatMap((p) => (p.api_key_env ? [p.api_key_env] : [])),
  ]),
];

interface Run {
  status: number | null;
  out: string;
  err: string;
}

/**
 * The context flags of one call, typed the way an accountant types them:
 *   'entity'  `-t <firm> -u <user>`, and `-e <entity>` once it exists (the default);
 *   'ingest'  the same with the root's `-T`: `ingest` declares -e and -u, but no -t;
 *   'tenant'  `-t <firm>` alone, for the leaves that declare nothing else (`user create`);
 *   'none'    no flags, for what acts on the installation (`tenant create`, `backup`).
 */
type Scope = 'entity' | 'ingest' | 'tenant' | 'none';

function contextOf(scope: Scope): string[] {
  if (scope === 'none') return [];
  if (scope === 'tenant') return ['-t', tenantId];
  return [scope === 'ingest' ? '-T' : '-t', tenantId, '-u', userEmail, ...(entityId ? ['-e', entityId] : [])];
}

/**
 * The child's environment: the suite's own, plus `extra` for this call, and
 * then none of the variables that hand it a model provider, whatever the shell
 * or a .env of whoever runs the suite holds. PROVIDER_ENV goes, and so does
 * every ANTHROPIC_* variable: with no key, the Anthropic SDK of the default
 * profile authenticates on its own from them (auth token, profile, workload
 * identity: see node_modules/@anthropic-ai/sdk/core/credentials.js) and from
 * the profiles under XDG_CONFIG_HOME, which therefore points inside the
 * throwaway HOME too.
 *
 * NOTE: blanked, not deleted. dotenv does not override a variable that is set
 * unless DOTENV_OVERRIDE (or DOTENV_CONFIG_OVERRIDE) asks it to, so those two
 * are blanked as well, and an empty key keeps the child's own .env from
 * bringing it back.
 */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // HOME points at a throwaway directory so no pinned entity, saved setting
    // or login of whoever runs the suite can leak into the month.
    HOME: workDir,
    XDG_CONFIG_HOME: path.join(workDir, '.config'),
    NO_COLOR: '1',
    MNEMOSINE_LOCALE: 'en-US',
    ...extra,
  };
  for (const name of Object.keys(env)) if (name.startsWith('ANTHROPIC_')) env[name] = '';
  for (const name of PROVIDER_ENV) env[name] = '';
  // dotenv reads its options from the environment too, DOTENV_OVERRIDE first
  // and DOTENV_CONFIG_OVERRIDE after it, and '' reads as false.
  for (const name of ['DOTENV_OVERRIDE', 'DOTENV_CONFIG_OVERRIDE']) env[name] = '';
  return env;
}

/** The binary, as typed: `args`, then the flags of `scope`, with `extra` in its environment. */
function mnemosine(args: string[], scope: Scope = 'entity', extra: Record<string, string> = {}): Run {
  const r = spawnSync('npx', ['tsx', CLI, ...args, ...contextOf(scope)], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 120_000,
    env: childEnv(extra),
  });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** Runs and demands exit 0, printing everything the CLI said when it is not. */
function ok(args: string[], scope: Scope = 'entity', extra: Record<string, string> = {}): Run {
  const r = mnemosine(args, scope, extra);
  expect(r.status, `mnemosine ${args.join(' ')}\n${r.out}\n${r.err}`).toBe(0);
  return r;
}

/** The `--json` document. Log lines may share stdout, so cut the JSON out. */
function rowsOf<T>(r: Run): T[] {
  const start = r.out.indexOf('{\n');
  const end = r.out.lastIndexOf('\n}');
  expect(start, `no JSON document in:\n${r.out}`).toBeGreaterThanOrEqual(0);
  return (JSON.parse(r.out.slice(start, end + 2)) as { rows: T[] }).rows;
}

const money = (v: string | undefined): string => new Decimal(v ?? 'NaN').toFixed(2);

interface StatementRow {
  section: string;
  line: string;
  code: string;
  name: string;
  amount: string;
}
const lineOf = (rows: StatementRow[], pred: (r: StatementRow) => boolean): string =>
  money(rows.find(pred)?.amount);

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosine-mvp-month-'));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('MVP month end to end: December 2025 of a synthetic SME, through the CLI only', () => {
  it('runs with no model provider: no built-in provider credential, no MNEMOSINE_PROVIDER and no mnemosine.config.json reach the binary', () => {
    // A credential takes three roads into the child: the environment that runs
    // the suite, and the two .env files that one dotenv call loads, the
    // checkout's ./.env and the ~/.mnemosine/.env of the child's HOME
    // (src/config/env-file.ts). Both files go through the same override rule,
    // so the test poisons the environment and the HOME file, each naming
    // another provider (the default printed says which one leaked), and leaves
    // the checkout's .env, which belongs to whoever runs the suite, alone.
    // The poisoned names come from the profiles, not from PROVIDER_ENV, the
    // list under test: a name the helper forgets is still poisoned, and reads ✔.
    const keys = [
      ...new Set([
        'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY',
        ...Object.values(BUILTIN_PROFILES).flatMap((p) => (p.api_key_env ? [p.api_key_env] : [])),
      ]),
    ];
    const inherited: Record<string, string> = {
      ...Object.fromEntries(keys.map((name) => [name, `leaked-${name}`])),
      MNEMOSINE_PROVIDER: 'ollama',
      ANTHROPIC_AUTH_TOKEN: 'leaked-token',
      XDG_CONFIG_HOME: '/nonexistent/leaked-config',
      DOTENV_OVERRIDE: 'true',
      DOTENV_CONFIG_OVERRIDE: 'true',
    };
    const saved = Object.fromEntries(Object.keys(inherited).map((name) => [name, process.env[name]]));
    const childDotenv = path.join(workDir, '.mnemosine', '.env');
    fs.mkdirSync(path.dirname(childDotenv), { recursive: true });
    fs.writeFileSync(
      childDotenv,
      [...keys.map((name) => `${name}=leaked-from-dotenv\n`), 'MNEMOSINE_PROVIDER=hermes\n'].join('')
    );
    Object.assign(process.env, inherited);
    try {
      const listed = ok(['providers'], 'none').out;
      for (const { api_key_env: key } of Object.values(BUILTIN_PROFILES)) {
        if (key) expect(listed, `${key} in:\n${listed}`).toContain(`${key} ✘ missing`);
      }
      expect(listed).not.toMatch(/^(ollama|hermes) ← default$/m);
      // A mnemosine.config.json can declare providers, keys and a default that
      // no blank reaches, so the child must load none: `providers` prints this
      // line only when it loads no config file.
      expect(listed, `the child loaded a mnemosine.config.json:\n${listed}`).toContain('Using built-in profiles.');
      // What `providers` cannot print: the Anthropic SDK's own credentials and
      // config directory, and a key that one call's environment tries to hand in.
      expect(childEnv().ANTHROPIC_AUTH_TOKEN).toBe('');
      expect(childEnv().XDG_CONFIG_HOME).toBe(path.join(workDir, '.config'));
      expect(childEnv({ OPENAI_API_KEY: 'leaked-by-a-call' }).OPENAI_API_KEY).toBe('');
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      fs.rmSync(childDotenv, { force: true });
    }
  }, STEP_TIMEOUT_MS);

  describe('1 · registration and migration', () => {
    it('creates the firm and its user without a TTY (tenant create, user create) — MNE-001-085, MNE-001-086', () => {
      const [firm] = rowsOf<{ tenantId: string; subdomain: string }>(
        ok(['tenant', 'create', 'Synthetic firm for the MVP month', '--subdomain', `mvp-${suffix}`, '--json'], 'none')
      );
      expect(firm.subdomain).toBe(`mvp-${suffix}`);
      tenantId = firm.tenantId;

      // The password travels in MNEMOSINE_USER_PASSWORD, never in argv, and
      // never comes back out.
      const created = ok(['user', 'create', '--email', userEmail, '--role', 'owner', '--json'], 'tenant', {
        MNEMOSINE_USER_PASSWORD: password,
      });
      expect(rowsOf<{ email: string; role: string; tenantId: string }>(created)[0])
        .toMatchObject({ email: userEmail, role: 'owner', tenantId });
      expect(created.out + created.err).not.toContain(password);
    }, STEP_TIMEOUT_MS);

    it('creates the entity with its seeded chart and the 2025 fiscal year', () => {
      const created = rowsOf<{ entityId: string; taxId: string }>(
        ok(['entity', 'create', 'Comercializadora Sintetica SA de CV', '--tax-id', COMPANY_RFC,
          '--tax-regime', '601', '--tax-postal-code', '01000', '--json'])
      );
      expect(created[0].taxId).toBe(COMPANY_RFC);
      entityId = created[0].entityId;

      ok(['year', 'create', '2025']);
    }, STEP_TIMEOUT_MS);

    it('records regime 601 and the fiscal address of the persona moral — MNE-001-017', () => {
      // 601 is c_RegimenFiscal's general regime of a persona moral; 01000 is
      // the fiscal postal code typed at `entity create`.
      expect(rowsOf<Record<string, string>>(ok(['entity', 'show', '--json']))[0]).toMatchObject({
        id: entityId,
        tax_id: COMPANY_RFC,
        tax_regime: '601',
        tax_regime_name: 'General de Ley Personas Morales',
        tax_postal_code: '01000',
      });
    }, STEP_TIMEOUT_MS);

    it('reaches `ingest` with the root -T (the helper\'s ingest scope); its dry run writes nothing', () => {
      // `ingest` declares -e and -u but no -t, so the firm goes in the root's -T.
      // A fixture CFDI addressed to this company: --dry-run writes nothing and
      // calls no one, so no figure of the month moves.
      const xml = path.join(workDir, 'ingest-scope.xml');
      fs.writeFileSync(
        xml,
        fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'cfdi', 'factura-limpieza-1001.xml'), 'utf-8')
          .replace('Rfc="XAXX010101000"', `Rfc="${COMPANY_RFC}"`)
      );
      const dry = ok(['ingest', xml, '--dry-run'], 'ingest');
      expect(dry.out).toContain('mnemosine ingest --dry-run · Comercializadora Sintetica SA de CV · 1 file(s)');
      expect(dry.out).toContain('ingest-scope.xml  would_process · received');
      expect(dry.out).toContain('dry-run: nothing was written');
    }, STEP_TIMEOUT_MS);

    it('imports the chart from Anexo 24 XML: the dry run writes nothing, and --yes creates the one account the seeded chart lacks — MNE-001-018', () => {
      const chart = path.join(workDir, 'catalogo-2024-12.xml');
      fs.writeFileSync(chart, CHART_XML);
      // The report publishes the service's keys, in Spanish: read as printed, never renamed.
      const [dry] = rowsOf<Record<string, unknown>>(ok(['chart', 'import', chart, '--dry-run', '--json']));
      expect(dry).toMatchObject({
        dryRun: true, escrito: false, creadas: [], omitidas: [], aCrear: [expect.objectContaining({ code: '1320' })],
      });
      // The other fourteen are seeded accounts: named, and left as they are.
      expect(dry['yaExistian']).toHaveLength(14);

      // Only the dry run came before: had it written 1320, this run would list it as existing.
      const [applied] = rowsOf<Record<string, unknown>>(ok(['chart', 'import', chart, '--yes', '--json']));
      expect(applied).toMatchObject({ dryRun: false, escrito: true, creadas: ['1320'] });
      expect(applied['yaExistian']).toHaveLength(14);
    }, STEP_TIMEOUT_MS);

    it('imports the open receivables and payables with the migration, and stops when they do not tie — MNE-001-022, MNE-001-023', () => {
      const trialBalance = path.join(workDir, 'balanza-2024-12.xml');
      fs.writeFileSync(trialBalance, TRIAL_BALANCE_XML);
      const subledger = (name: string, documents: object[]): string => {
        const file = path.join(workDir, name);
        fs.writeFileSync(file, JSON.stringify(documents));
        return file;
      };
      const load = (file: string): string[] => ['opening-balance', 'import', trialBalance, '--subledger', file, '--yes', '--json'];

      // The bill one peso short: 2,319.00 of documents against the 2,320.00
      // the trial balance declares on 2110. With --yes, only the refusal
      // keeps it from writing: exit 4, and the ledger stays empty. The report
      // keeps the service's Spanish keys, read as printed.
      const short = OPEN_DOCUMENTS.map((d) => (d.cuenta === '2110' ? { ...d, importe: '2319.00' } : d));
      const refused = mnemosine(load(subledger('subledger-one-peso-short.json', short)));
      expect(refused.status, refused.out + refused.err).toBe(4);
      const [stopped] = rowsOf<Record<string, unknown>>(refused);
      expect(stopped).toMatchObject({ escrito: false, asiento: null });
      const untied = (stopped['findings'] as Record<string, string>[]).find((f) => f['regla'] === 'APE-DETALLE-NO-CUADRA');
      expect(untied).toMatchObject({ numCta: '2110', severidad: 'bloquea' });
      expect(untied?.['mensaje']).toContain('faltan 1.00');
      expect(rowsOf(ok(['entry', 'list', '--all', '--json']))).toEqual([]);

      const [loaded] = rowsOf<Record<string, unknown>>(ok(load(subledger('subledger.json', OPEN_DOCUMENTS))));
      expect(loaded).toMatchObject({ escrito: true, loadMode: 'post', fecha: '2025-01-01', arInvoices: 1, apBills: 1 });
      expect(money(loaded['totalDebe'] as string)).toBe(OPENING_DEBITS);
      expect(money(loaded['totalHaber'] as string)).toBe(OPENING_DEBITS);
      openingEntry = (loaded['asiento'] as { entry_number: string }).entry_number;

      // Each document is the invoice or bill it was, hanging from the opening
      // entry, which already carries its amount.
      const invoices = rowsOf<Record<string, string>>(ok(['invoice', 'list', '--json']));
      expect(invoices).toEqual([expect.objectContaining({
        invoice_number: 'A-2024-117', customer_name: 'Distribuidora del Bajio SA de CV', status: 'sent',
      })]);
      expect(money(invoices[0].amount_due)).toBe('3480.00');
      const bills = rowsOf<Record<string, string>>(ok(['bill', 'list', '--json']));
      expect(bills).toHaveLength(1);
      // The BILL series of its own document year, so section 3's bill is still BILL-2025-00001.
      expect(bills[0].bill_number).toMatch(/^BILL-2024-\d{5}$/);
      expect(money(bills[0].amount_due)).toBe('2320.00');
      // 2,320 / 1.16 = 2,000 of base and 320 of IVA: the 320 the trial balance parks in 1135.
      const [bill] = rowsOf<Record<string, string>>(ok(['bill', 'show', bills[0].bill_number, '--json']));
      expect(bill).toMatchObject({ vendor_invoice_number: 'F-2024-881', status: 'approved' });
      expect(money(bill.subtotal)).toBe('2000.00');
      expect(money(bill.tax_amount)).toBe('320.00');

      // The vendor subledger against 2110 on the day of the opening. --strict
      // would exit 4 on any reconciling item, the opening entry included.
      expect(rowsOf(ok(['ap', 'reconcile', '--as-of', '2025-01-01', '--strict', '--json']))[0]).toMatchObject({
        subdiario: '2320.00', mayor: '2320.00', diferencia: '0.00', cuadra: true, partidas: [],
      });
    }, STEP_TIMEOUT_MS);

    it('the opening, posted on 2025-01-01, is the only entry of the year so far and ties to the peso; January to November are hard-closed in order — MNE-001-018, MNE-001-099', () => {
      // Posted and not left as a draft: apertura_modo_de_carga posts by
      // default (MNE-001-099). No opening is typed in December any more.
      const entries = rowsOf<Record<string, string>>(ok(['entry', 'list', '--all', '--json']));
      expect(entries).toEqual([expect.objectContaining({
        entry_number: openingEntry, entry_date: '2025-01-01', status: 'posted', source_type: 'opening_balance',
      })]);
      expect(money(entries[0].total_debits)).toBe(OPENING_DEBITS);

      // The fifteen accounts of the source, parents included, against our
      // ledger on 2025-01-01, rolled up the same way.
      const [check] = rowsOf<Record<string, unknown>>(
        ok(['opening-balance', 'check', path.join(workDir, 'balanza-2024-12.xml'), '--json'])
      );
      expect(check).toMatchObject({ asOf: '2025-01-01', comparison: { comparadas: 15, iguales: true } });

      // Each month is soft-closed, then hard-closed, oldest first; the hard
      // close carries its endings into the next month, so November's carries
      // the opening into December.
      const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
        'September', 'October', 'November', 'December'];
      months.slice(0, 11).forEach((month, i) => {
        const period = `2025-${String(i + 1).padStart(2, '0')}`;
        expect(ok(['close', '--period', period, '--yes']).out).toContain(`✔ ${month} 2025 is now soft_close`);
        const sealed = ok(['close', '--period', period, '--hard', '--yes']).out;
        expect(sealed).toContain(`✔ ${month} 2025 is now hard_close`);
        expect(sealed).toContain(`Beginning balances carried into: ${months[i + 1]} 2025`);
      });
      const periods = rowsOf<{ period_name: string; status: string }>(ok(['period', 'list', '--json']));
      expect(months.map((m) => periods.find((p) => p.period_name === `${m} 2025`)?.status))
        .toEqual([...Array<string>(11).fill('hard_close'), 'open']);
    }, STEP_TIMEOUT_MS);

    it.todo('imports the 8xx memorandum accounts with the chart and the opening trial balance, and leaves them out of the footing — MNE-001-019, MNE-001-419');
  });

  describe('2 · CFDI to the ledger', () => {
    it.todo('ingests the issued PUE and PPD invoices from tests/fixtures into receivables, never as expense, and the issued REP settles the PPD — MNE-001-025, MNE-001-028');
    it.todo('approving a received PPD creates the bill, and its REP moves the IVA from 1135 to 1130 — MNE-001-026, MNE-001-116, MNE-001-117');
    it.todo('classifies the month by the manual path, with no model: reprocess, hand coding and processing rules — MNE-001-029, MNE-001-030, MNE-001-032');
    it.todo('keeps leading zeros and accents of the parsed CFDI, including a 0 % and an exempt one — MNE-001-031, MNE-001-027');
    it.todo('posts a lodging CFDI with its local tax (ISH) in its own account — MNE-001-033');
    it.todo('posts a CFDI with withholdings, and the collection that carries them applies — MNE-001-056, MNE-001-057, MNE-001-113');
    it.todo('loads a synthetic SAT census for 2025-12 and `sat download reconcile --period` names each CFDI as missing, unposted or posted — MNE-001-096, MNE-001-119');
  });

  describe('3 · receivables and payables', () => {
    it('issues an invoice, collects half, captures and pays a bill, and issues a credit note', () => {
      ok(['customer', 'create', '--name', 'Cliente Sintetico SA de CV', '--tax-id', CUSTOMER_RFC, '--terms', 'Net 30']);
      ok(['invoice', 'create', '--customer', 'Cliente Sintetico', '--date', '2025-12-05',
        '--line', 'account=4100;qty=1;price=10000.00;tax-rate=16;description=Mercancia']);
      ok(['invoice', 'issue', 'INV-2025-00001', '--yes']);
      expect(ok(['receipt', 'record', 'INV-2025-00001', '--amount', '5800.00', '--date', '2025-12-15', '--yes']).out)
        .toContain('11600.00 → 5800.00 (partially_paid)');

      ok(['vendor', 'create', 'Proveedor Sintetico SA de CV', '--tax-id', VENDOR_RFC, '--terms', 'Net 30']);
      ok(['bill', 'create', 'Proveedor Sintetico', '--vendor-invoice-number', 'F-100', '--bill-date', '2025-12-08',
        '--line', 'account=6100;price=5000.00;tax-amount=800.00;description=Papeleria']);
      ok(['bill', 'approve', 'BILL-2025-00001', '--yes']);
      expect(ok(['payment', 'create', 'BILL-2025-00001', '--amount', '5800.00', '--date', '2025-12-20', '--yes']).out)
        .toContain('5800.00 → 0.00 (paid)');

      ok(['credit-note', 'create', '--type', 'devolucion', '--invoice', 'INV-2025-00001',
        '--amount', '1000.00', '--tax', '160.00', '--date', '2025-12-18']);
      ok(['credit-note', 'issue', 'CN-2025-00001', '--yes']);
    }, STEP_TIMEOUT_MS);

    it('applies the credit note without a TTY: `credit-note apply` asks for --yes, and with it the invoice owes 4,640.00 and no entry is posted — MNE-001-088', () => {
      const owed = (): string =>
        money(rowsOf<{ amount_due: string }>(ok(['invoice', 'show', 'INV-2025-00001', '--json']))[0].amount_due);
      const entries = (): string[] =>
        rowsOf<{ entry_number: string }>(ok(['entry', 'list', '--all', '--json'])).map((e) => e.entry_number);
      const apply = ['credit-note', 'apply', 'CN-2025-00001', '--invoice', 'INV-2025-00001:1160.00'];
      const posted = entries();

      // A pipe is not a terminal: the binary asks for --yes, aborts (exit 10,
      // the code of a declined confirmation) and writes nothing.
      const refused = mnemosine(apply);
      expect(refused.status, refused.out + refused.err).toBe(10);
      expect(refused.err).toContain('Re-run with --yes');
      expect(owed()).toBe('5800.00');

      // 11,600 − 5,800 collected − 1,160 credited (1,000 + 160 IVA). The note
      // posted its entry when it was issued; applying it moves the subledger only.
      expect(ok([...apply, '--yes']).out).toContain('INV-2025-00001 5800.00 → 4640.00 (partially_paid)');
      expect(owed()).toBe('4640.00');
      expect(entries()).toEqual(posted);
    }, STEP_TIMEOUT_MS);

    it.todo('records a customer advance and applies it to the next invoice — MNE-001-098');
    it.todo('ar reconcile and ap reconcile tie to 1120 and 2110 at 2025-12-31, and a mismatch blocks the close — MNE-001-034, MNE-001-035, MNE-001-036, MNE-001-037');
  });

  describe('4 · bank', () => {
    it.todo('collections and payments land on 1111, the leaf, not on 1110: debits 5,800.00 and credits 5,800.00 — MNE-001-039');
    it.todo('imports the December statement, the first session with a baseline instead of the whole ledger history — MNE-001-038');
    it.todo('an overlapping statement does not duplicate movements — MNE-001-042');
    it.todo('reconciles, classifies the bank fee and its IVA, and closes the session — MNE-001-040, MNE-001-041, MNE-001-043');
    it.todo('reopens the approved reconciliation from the terminal and closes it again, reversing what it posted — MNE-001-044, MNE-001-130');
  });

  describe('5 · payroll', () => {
    it.todo('hires two employees and runs and posts a fortnight: ISR with subsidy, IMSS, INFONAVIT, ISN, entry and SUA — MNE-001-066, MNE-001-068, MNE-001-069, MNE-001-070');
    it.todo('the fortnight figures match the hand-computed ones: employer IMSS, aguinaldo, vacation premium and 2026 subsidy — MNE-001-061, MNE-001-062, MNE-001-063, MNE-001-064');
  });

  describe('6 · month-end close', () => {
    it('the checklist flags an entity with no fixed assets while 1220 carries the computers, and the asset is registered — MNE-001-020, MNE-001-021', () => {
      const [purchase] = rowsOf<{ entry_number: string }>(
        ok(['entry', 'create', '--date', '2025-12-01', '--description', 'Computer equipment',
          '--line', '1220:debit:36000.00', '--line', '1111:credit:36000.00', '--json'])
      );
      ok(['entry', 'post', purchase.entry_number, '--yes']);

      // A finding, not a pass: warning weight, so only --strict makes it fail.
      const flagged = mnemosine(['closing', 'check', '--period', 'December 2025',
        '--check', 'depreciation-posted', '--strict', '--json']);
      expect(flagged.status, flagged.out + flagged.err).toBe(4);
      expect(rowsOf<{ is_complete: boolean; details: string }>(flagged)[0]).toMatchObject({
        is_complete: false,
        details: '0 fixed assets registered, but the fixed-asset accounts carry 36000.00 at 2025-12-31: ' +
          'register them (asset create) so the month can be depreciated',
      });

      ok(['asset', 'create', 'Laptops', '--category', 'Equipo de Cómputo', '--cost', '36000.00',
        '--acquired', '2025-12-01', '--capitalized', 'yes']);
    }, STEP_TIMEOUT_MS);

    it('conducts the close of December, posts its depreciation, and seals a balanced dossier', () => {
      // December shares its start month with period 13 ("Year-end adjustments 2025"),
      // so the close leaves refuse 2025-12 and the month is named (MNE-001-087).
      const run = ok(['closing', 'run', 'December 2025', '-y']).out;
      expect(run).toMatch(/December 2025\s+completed/);
      expect(run).toContain('1 asset(s) depreciated');
      // `closing run` ends with the seal (#99, MNE-001-049): the carry-forward
      // into period 13 lives only in the hard close.
      expect(run).toContain('period hard-closed; balances carried into');
      const periods = rowsOf<{ period_name: string; status: string }>(ok(['period', 'list', '--json']));
      expect(periods.find((p) => p.period_name === 'December 2025')?.status).toBe('hard_close');

      const pack = ok(['closing', 'pack', 'generate', 'December 2025', '--json']);
      const [sealed] = rowsOf<{ debit: string; credit: string; balanced: boolean }>(pack);
      expect(money(sealed.debit)).toBe(SEALED_DEBITS);
      expect(money(sealed.credit)).toBe(SEALED_DEBITS);
      expect(sealed.balanced).toBe(true);
    }, STEP_TIMEOUT_MS);

    it.todo('closes the 2025 fiscal year into period 13: `balance generate --closing` nets to 0 and the closing entries are not in December — MNE-001-046');
  });

  describe('7 · financial statements, to the cent', () => {
    it('trial balance, income statement, balance sheet and cash flow match the hand figures', () => {
      // A period's trial balance has a beginning, so its ending balance is
      // `final_balance`; `net_change` is the month's movement (MNE-001-126).
      const tb = rowsOf<{ account_code: string; final_balance: string; debit_total: string; credit_total: string }>(
        ok(['report', 'trial-balance', 'show', '--period', '2025-12', '--exclude-zero', '--json'])
      );
      for (const [code, expected] of Object.entries(ENDING)) {
        expect(money(tb.find((r) => r.account_code === code)?.final_balance), `ending balance of ${code}`).toBe(expected);
      }
      const debits = tb.reduce((s, r) => s.plus(r.debit_total), new Decimal(0));
      const credits = tb.reduce((s, r) => s.plus(r.credit_total), new Decimal(0));
      expect(credits.toFixed(2)).toBe(debits.toFixed(2));

      const is = rowsOf<StatementRow>(ok(['report', 'income-statement', 'show', '--period', '2025-12', '--json']));
      expect(lineOf(is, (r) => r.section === 'revenue' && r.line === 'total')).toBe(NET_SALES);
      expect(lineOf(is, (r) => r.section === '' && r.line === 'total')).toBe(NET_INCOME);

      const bs = rowsOf<StatementRow>(ok(['report', 'balance-sheet', 'show', '--as-of', '2025-12-31', '--json']));
      expect(lineOf(bs, (r) => r.section === 'assets' && r.line === 'total')).toBe(TOTAL_ASSETS);
      expect(lineOf(bs, (r) => r.section === 'liabilities' && r.line === 'total')).toBe(TOTAL_LIABILITIES);
      expect(lineOf(bs, (r) => r.section === 'equity' && r.line === 'total')).toBe(TOTAL_EQUITY);

      const cf = rowsOf<StatementRow>(ok(['cashflow', 'generate', '--period', '2025-12', '--json']));
      expect(lineOf(cf, (r) => r.section === 'operating' && r.line === 'total')).toBe(OPERATING_CASH);
      expect(lineOf(cf, (r) => r.section === 'investing' && r.line === 'total')).toBe(INVESTING_CASH);
      expect(lineOf(cf, (r) => r.section === 'financing' && r.line === 'total')).toBe(FINANCING_CASH);
      expect(lineOf(cf, (r) => r.line === 'residue')).toBe('0.00');
    }, STEP_TIMEOUT_MS);

    it('the trial balance by --level rolls its subaccounts up into their parent — MNE-001-050', () => {
      type TbRow = { account_code: string; debit_total: string; credit_total: string; net_change: string; final_balance: string };
      const detail = rowsOf<TbRow>(ok(['report', 'trial-balance', 'show', '--period', '2025-12', '--json']));
      const leveled = ok(['report', 'trial-balance', 'show', '--period', '2025-12', '--level', '3', '--json']);
      expect(leveled.err).not.toContain('OUT OF BALANCE');
      const tb = rowsOf<TbRow>(leveled);
      const cash = tb.find((r) => r.account_code === '1110');

      // By hand: every cash movement of the month sits in the subtree of 1110,
      // whichever of its accounts it landed on (MNE-001-039). Debits: the
      // 5,800 receipt, since the opening is January's; credits: the 36,000
      // computers and the 5,800 payment.
      expect(money(cash?.debit_total)).toBe('5800.00');
      expect(money(cash?.credit_total)).toBe('41800.00');
      expect(money(cash?.final_balance)).toBe(ENDING['1111']);

      // And against the detail balanza: 1110 is itself plus 1111, 1112 and
      // 1115, its children in the seeded chart (issue #100: 1110 = 1111 + 1112).
      for (const col of ['debit_total', 'credit_total', 'net_change', 'final_balance'] as const) {
        const subtree = detail
          .filter((r) => ['1110', '1111', '1112', '1115'].includes(r.account_code))
          .reduce((s, r) => s.plus(r[col]), new Decimal(0));
        expect(money(cash?.[col]), `1110 ${col}`).toBe(subtree.toFixed(2));
      }
      // 1000 → 1100 → 1110 → 1111: the leaves are level 4, so the cut hides
      // them and their money is printed once, inside 1110.
      expect(tb.some((r) => ['1111', '1112', '1115'].includes(r.account_code))).toBe(false);
    }, STEP_TIMEOUT_MS);
  });

  describe('8 · monthly obligations', () => {
    it.todo('the Anexo 24 chart and trial balance XML validate against their XSD, and 1110 declares 1111 + 1112 — MNE-001-047');
    it.todo('the journal and auxiliary XML of the month are produced by command — MNE-001-054');
    it.todo('`diot export --layout sat` matches, byte for byte, the file written by hand — MNE-001-055, MNE-001-027');
    it.todo('the IVA and ISR working paper has the exact hand figures, each line traced to its entries — MNE-001-058, MNE-001-059, MNE-001-060, MNE-001-115');
  });

  describe('9 · safe operation', () => {
    it('the ledger checks pass, and the backup restores into another database with its checks green', () => {
      ok(['ledger', 'check']);
      const target = path.join(workDir, 'backups');
      // `backup --json` publishes its keys in Spanish; they are read as printed, never renamed.
      const [dump] = rowsOf<Record<string, string>>(ok(['backup', 'create', '--target', target, '--json'], 'none'));
      const [verified] = rowsOf<Record<string, unknown>>(
        ok(['backup', 'verify', dump['archivo'], '--restore', '--json'], 'none')
      );
      // restored, intact, and no blocking ledger finding in the restored copy
      expect(verified).toMatchObject({ restauro: true, integro: true, bloqueantes: 0 });
    }, STEP_TIMEOUT_MS);
  });
});
