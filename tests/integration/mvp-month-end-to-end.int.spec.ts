import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase } from '../../src/database/connection.js';

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
// its derivation from the six documents of the month.
//
// Only the firm (tenant) and its user are seeded with SQL: creating them
// without a TTY is MNE-001-085/086, listed as a todo in step 1.
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

// ── THE MONTH, BY HAND ──────────────────────────────────────────────────
//   12-01 opening        1111 Dr 100,000.00 / 3100 Cr 100,000.00
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
// Debits of the month: 100,000 + 36,000 + 11,600 + 5,800 + 5,800 + 1,160
// + 5,800 + 800 + 900
const MONTH_DEBITS = '167860.00';
const ENDING = {
  '1111': '64000.00', // 100,000 − 36,000 − 5,800 + 5,800 (see MNE-001-039 in step 4)
  '1120': '4640.00', // 11,600 − 5,800 − 1,160
  '1130': '800.00',
  '1220': '36000.00',
  '1290': '-900.00', // accumulated depreciation, credit balance
  '2120': '-1440.00', // −1,600 + 160, credit balance
  '3100': '-100000.00',
  '4100': '-10000.00',
  '4400': '1000.00',
  '6100': '5000.00',
  '6140': '900.00',
} as const;
const NET_SALES = '9000.00'; // 10,000 − 1,000 returned
const NET_INCOME = '3100.00'; // 9,000 − 5,000 − 900
const TOTAL_ASSETS = '104540.00'; // 64,000 + 4,640 + 800 + 36,000 − 900
const TOTAL_LIABILITIES = '1440.00';
const TOTAL_EQUITY = '103100.00'; // 100,000 + 3,100
// Indirect method: 3,100 + 900 (depreciation, no cash) − 4,640 (AR up) − 800
// (IVA credit up) + 1,440 (IVA payable up) = 0, which is the 5,800 received
// minus the 5,800 paid.
const OPERATING_CASH = '0.00';
const INVESTING_CASH = '-36000.00'; // the computers
const FINANCING_CASH = '100000.00';

let tenantId: string;
let userEmail: string;
let entityId = '';
let workDir: string;

interface Run {
  status: number | null;
  out: string;
  err: string;
}

/** The binary, as typed. `scoped` adds the firm, the entity and the user. */
function mnemosine(args: string[], scoped = true): Run {
  const context = scoped ? ['-t', tenantId, '-u', userEmail, ...(entityId ? ['-e', entityId] : [])] : [];
  const r = spawnSync('npx', ['tsx', CLI, ...args, ...context], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 120_000,
    // HOME points at a throwaway directory so no pinned entity or saved
    // setting of whoever runs the suite can leak into the month.
    env: { ...process.env, HOME: workDir, NO_COLOR: '1', MNEMOSINE_LOCALE: 'en-US' },
  });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** Runs and demands exit 0, printing everything the CLI said when it is not. */
function ok(args: string[], scoped = true): Run {
  const r = mnemosine(args, scoped);
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

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosine-mvp-month-'));
  tenantId = uuidv4();
  const userId = uuidv4();
  const suffix = tenantId.replace(/-/g, '').slice(0, 12);
  userEmail = `month-${suffix}@example.test`;
  await query(
    `INSERT INTO tenants (id, name, subdomain, schema_name, plan, is_active)
     VALUES ($1, 'Synthetic firm for the MVP month', $2, $3, 'enterprise', true)`,
    [tenantId, `mvp-${suffix}`, `mvp_${suffix}`]
  );
  await query(
    `INSERT INTO users (id, tenant_id, email, password_hash, first_name, last_name,
       roles, permissions, accessible_entities, is_active)
     VALUES ($1, $2, $3, 'x', 'Synthetic', 'Accountant', '["owner"]'::jsonb, '["*"]'::jsonb, '[]'::jsonb, true)`,
    [userId, tenantId, userEmail]
  );
}, 60_000);

afterAll(async () => {
  fs.rmSync(workDir, { recursive: true, force: true });
  await closeDatabase();
});

describe('MVP month end to end: December 2025 of a synthetic SME, through the CLI only', () => {
  describe('1 · registration and migration', () => {
    it('creates the entity with its chart and the 2025 fiscal year, and posts the opening balance', () => {
      const created = rowsOf<{ entityId: string; taxId: string }>(
        ok(['entity', 'create', 'Comercializadora Sintetica SA de CV', '--tax-id', COMPANY_RFC, '--json'])
      );
      expect(created[0].taxId).toBe(COMPANY_RFC);
      entityId = created[0].entityId;

      ok(['year', 'create', '2025']);
      // The bridge until the Anexo 24 import exists: the same opening, typed.
      ok(['entry', 'create', '--date', '2025-12-01', '--description', 'Opening balance',
        '--line', '1111:debit:100000.00', '--line', '3100:credit:100000.00']);
      expect(ok(['entry', 'post', 'JE-2025-00001', '--yes']).out).toContain('JE-2025-00001 posted');
    }, STEP_TIMEOUT_MS);

    it.todo('creates the firm and its user without a TTY (tenant create, user create) — MNE-001-085, MNE-001-086');
    it.todo('records regime 601 and the fiscal address of the persona moral — MNE-001-017');
    it.todo('imports the chart and the opening trial balance from Anexo 24 XML, the 8xx memorandum accounts included and excluded from the footing — MNE-001-018, MNE-001-019, MNE-001-099');
    it.todo('imports the open receivables and payables with the migration, and stops when they do not tie — MNE-001-022, MNE-001-023');
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
        '--line', 'account=4100;qty=1;price=10000.00;tax=16;description=Mercancia']);
      ok(['invoice', 'issue', 'INV-2025-00001', '--yes']);
      expect(ok(['receipt', 'record', 'INV-2025-00001', '--amount', '5800.00', '--date', '2025-12-15', '--yes']).out)
        .toContain('11600.00 → 5800.00 (partially_paid)');

      ok(['vendor', 'create', 'Proveedor Sintetico SA de CV', '--tax-id', VENDOR_RFC, '--terms', 'Net 30']);
      ok(['bill', 'create', 'Proveedor Sintetico', '--vendor-invoice-number', 'F-100', '--bill-date', '2025-12-08',
        '--line', 'account=6100,price=5000.00,tax-amount=800.00,description=Papeleria']);
      ok(['bill', 'approve', 'BILL-2025-00001', '--yes']);
      expect(ok(['payment', 'create', 'BILL-2025-00001', '--amount', '5800.00', '--date', '2025-12-20', '--yes']).out)
        .toContain('5800.00 → 0.00 (paid)');

      ok(['credit-note', 'create', '--type', 'devolucion', '--invoice', 'INV-2025-00001',
        '--amount', '1000.00', '--tax', '160.00', '--date', '2025-12-18']);
      ok(['credit-note', 'issue', 'CN-2025-00001', '--yes']);
    }, STEP_TIMEOUT_MS);

    it.todo('applies the credit note without a TTY: `credit-note apply` asks for --yes and does not accept it — MNE-001-088');
    it.todo('records a customer advance and applies it to the next invoice — MNE-001-098');
    it.todo('ar reconcile and ap reconcile tie to 1120 and 2110 at 2025-12-31, and a mismatch blocks the close — MNE-001-034, MNE-001-035, MNE-001-036, MNE-001-037');
  });

  describe('4 · bank', () => {
    it.todo('collections and payments land on 1111, the leaf, not on 1110: debits 105,800.00 and credits 5,800.00 — MNE-001-039');
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
      const run = ok(['closing', 'run', '2025-12', '-y']).out;
      expect(run).toMatch(/December 2025\s+completed/);
      expect(run).toContain('1 asset(s) depreciated');
      // `closing run` ends with the seal (#99, MNE-001-049): the carry-forward
      // into period 13 lives only in the hard close.
      expect(run).toContain('period hard-closed; balances carried into');
      const periods = rowsOf<{ period_name: string; status: string }>(ok(['period', 'list', '--json']));
      expect(periods.find((p) => p.period_name === 'December 2025')?.status).toBe('hard_close');

      const pack = ok(['closing', 'pack', 'generate', 'December 2025', '--json']);
      const [sealed] = rowsOf<{ debit: string; credit: string; balanced: boolean }>(pack);
      expect(money(sealed.debit)).toBe(MONTH_DEBITS);
      expect(money(sealed.credit)).toBe(MONTH_DEBITS);
      expect(sealed.balanced).toBe(true);
    }, STEP_TIMEOUT_MS);

    it.todo('closes the 2025 fiscal year into period 13: `balance generate --closing` nets to 0 and the closing entries are not in December — MNE-001-046');
  });

  describe('7 · financial statements, to the cent', () => {
    it('trial balance, income statement, balance sheet and cash flow match the hand figures', () => {
      const tb = rowsOf<{ account_code: string; ending_balance: string; debit_total: string; credit_total: string }>(
        ok(['report', 'trial-balance', 'show', '--period', '2025-12', '--exclude-zero', '--json'])
      );
      for (const [code, expected] of Object.entries(ENDING)) {
        expect(money(tb.find((r) => r.account_code === code)?.ending_balance), `ending balance of ${code}`).toBe(expected);
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
      type TbRow = { account_code: string; debit_total: string; credit_total: string; ending_balance: string };
      const detail = rowsOf<TbRow>(ok(['report', 'trial-balance', 'show', '--period', '2025-12', '--json']));
      const leveled = ok(['report', 'trial-balance', 'show', '--period', '2025-12', '--level', '3', '--json']);
      expect(leveled.err).not.toContain('OUT OF BALANCE');
      const tb = rowsOf<TbRow>(leveled);
      const cash = tb.find((r) => r.account_code === '1110');

      // By hand: every cash movement of the month sits in the subtree of 1110,
      // whichever of its accounts it landed on (MNE-001-039). Debits: the
      // 100,000 opening and the 5,800 receipt; credits: the 36,000 computers
      // and the 5,800 payment.
      expect(money(cash?.debit_total)).toBe('105800.00');
      expect(money(cash?.credit_total)).toBe('41800.00');
      expect(money(cash?.ending_balance)).toBe(ENDING['1111']);

      // And against the detail balanza: 1110 is itself plus 1111, 1112 and
      // 1115, its children in the seeded chart (issue #100: 1110 = 1111 + 1112).
      for (const col of ['debit_total', 'credit_total', 'ending_balance'] as const) {
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
      const [dump] = rowsOf<Record<string, string>>(ok(['backup', 'create', '--target', target, '--json'], false));
      const [verified] = rowsOf<Record<string, unknown>>(
        ok(['backup', 'verify', dump['archivo'], '--restore', '--json'], false)
      );
      // restored, intact, and no blocking ledger finding in the restored copy
      expect(verified).toMatchObject({ restauro: true, integro: true, bloqueantes: 0 });
    }, STEP_TIMEOUT_MS);
  });
});
