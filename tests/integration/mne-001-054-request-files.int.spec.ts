import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import Decimal from 'decimal.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { recordVendorPayment } from '../../src/services/payments/payment-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { encrypt } from '../../src/utils/encryption.js';
import { registerEAccountingCommand } from '../../src/cli/e-accounting-command.js';
import { ExitCode } from '../../src/cli/kernel/index.js';
import { validateAgainstOfficialXsd } from '../helpers/official-xsd.js';

// ============================================================
// MNE-001-054 (#328) · `e-accounting voucher generate` and `subledger
// generate` against Postgres, and their files against the SAT's official XSD.
//
// The unit spec (tests/cli/e-accounting-request-command.spec.ts) proves the
// flags and exit codes with a double of the engine. What only the real ledger
// can prove is the acceptance of the issue: the file each command WRITES from
// a real month validates against PolizasPeriodo, AuxiliarFolios and
// AuxiliarCtas 1.3, and the CFDI of a bill approved through the ingestion
// road (#318) reaches the voucher as CompNal without any `cfdi link add`.
// ============================================================

let f: Fixture;
let tmpRoot: string;
let billUuid: string;

const MONTH = 8;
const PERIOD = ['--period', `2026-0${MONTH}`];
const AUDIT = ['--request-type', 'AF', '--order-number', 'ABC1234567/26'];
const CLABE = '012180001234567895';

async function accountByCode(code: string): Promise<string> {
  const r = await query<{ id: string }>(`SELECT id FROM accounts WHERE entity_id = $1 AND code = $2`, [
    f.entityId,
    code,
  ]);
  if (r.rows.length === 0) throw new Error(`missing account ${code}`);
  return r.rows[0].id;
}

async function artifactCount(): Promise<number> {
  const r = await query<{ n: string }>(`SELECT count(*)::text AS n FROM sat_anexo24_artefactos WHERE entity_id = $1`, [
    f.entityId,
  ]);
  return Number(r.rows[0].n);
}

const plain = {
  dim: (s: string) => s,
  bold: (s: string) => s,
  cyan: (s: string) => s,
  red: (s: string) => s,
  green: (s: string) => s,
  yellow: (s: string) => s,
};

async function run(argv: string[]) {
  let exitCode: number | undefined;
  const errs: unknown[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const stdoutOriginal = process.stdout.write.bind(process.stdout);
  const stderrOriginal = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => {
    out.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    err.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  try {
    const p = new Command('mnemosine');
    registerEAccountingCommand(p, {
      palette: plain,
      shutdown: (c: number) => {
        exitCode = c;
      },
      reportError: (e: unknown) => {
        errs.push(e);
      },
    });
    await p.parseAsync(['node', 'mnemosine', 'e-accounting', ...argv, '-e', f.entityId, '-t', f.tenantId]);
  } finally {
    process.stdout.write = stdoutOriginal;
    process.stderr.write = stderrOriginal;
  }
  return { exitCode, errs, out: out.join(''), err: err.join('') };
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mne054-'));
  f = await crearInquilino('MNE-001-054 request files');
  await seedPolicies({ tenantId: f.tenantId });

  const bankId = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id,
       currency_code, sat_bank_code, clabe_encrypted, clabe_last4, is_active)
     VALUES ($1,$2,'Checking','BBVA México',$3,'MXN','012',$4,$5,true)`,
    [bankId, f.entityId, await accountByCode('1120'), encrypt(CLABE), CLABE.slice(-4)]
  );

  // A bill approved with its CFDI UUID, as the ingestion road leaves it
  // (#318): the entry is posted with source_type 'bill'.
  const vendorId = uuidv4();
  const billId = uuidv4();
  billUuid = uuidv4();
  const date = fechaEnPeriodo(MONTH);
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,'V-054','Aceros del Norte','CCC030303CC3','rfc','MXN',$3)`,
    [vendorId, f.entityId, f.userId]
  );
  await query(
    `INSERT INTO bills (
       id, entity_id, bill_number, vendor_id, vendor_invoice_number,
       subtotal, tax_amount, total_amount, amount_due, amount_paid,
       currency_code, bill_date, due_date, status, created_by, terms, cfdi_uuid
     ) VALUES ($1,$2,'BILL-054',$3,'CFDI-054',1000,160,1160,1160,0,'MXN',$4,$4,'draft',$5,'PPD',$6)`,
    [billId, f.entityId, vendorId, date, f.userId, billUuid]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Steel',1,1000,1000,160,1160)`,
    [uuidv4(), billId, await accountByCode('6100')]
  );
  await approveBill(billId, f.userId, { entityId: f.entityId });

  // Paid by cheque with the full trace: the voucher carries its Cheque node.
  await recordVendorPayment(
    {
      entityId: f.entityId,
      paymentAmount: new Decimal('1160').toFixed(2),
      paymentDate: fechaEnPeriodo(MONTH),
      paymentMethod: 'check',
      bankAccountId: bankId,
      checkNumber: '20054',
      cuentaDestino: '002180009876543210',
      bancoDestinoSat: '002',
      applications: [{ documentId: billId, amountApplied: '1160.00' }],
    },
    f.userId
  );
}, 180_000);

afterAll(async () => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  await drainAttestations(2000);
  await closeDatabase();
});

describe('voucher generate writes vouchers the official XSD accepts', () => {
  it('the written file validates against PolizasPeriodo 1.3 and carries the bill CFDI', async () => {
    const target = path.join(tmpRoot, 'polizas.xml');
    const r = await run(['voucher', 'generate', ...PERIOD, ...AUDIT, '-o', target, '--yes', '--json']);
    expect(r.exitCode, `${r.err}\n${String(r.errs[0])}`).toBe(ExitCode.OK);
    const xml = fs.readFileSync(target, 'utf8');
    expect(validateAgainstOfficialXsd(xml, 'journal')).toEqual({ valid: true, errors: [] });
    expect(xml).toContain(`UUID_CFDI="${billUuid}"`);
    expect(xml).toContain('TipoSolicitud="AF"');
    expect(xml).toContain('NumOrden="ABC1234567/26"');
    expect(xml).toContain('<PLZ:Cheque');
    const row = (JSON.parse(r.out) as { rows: Record<string, unknown>[] }).rows[0];
    expect(row).toMatchObject({ deliverable: true, sealed: false, archived: 'new', with_payment_trace: 1 });
  });

  it('--dry-run builds the same verdict, archives nothing and writes no file', async () => {
    const before = await artifactCount();
    const target = path.join(tmpRoot, 'dry.xml');
    const r = await run(['voucher', 'generate', ...PERIOD, ...AUDIT, '--dry-run', '-o', target]);
    expect(r.exitCode, `${r.err}\n${String(r.errs[0])}`).toBe(ExitCode.OK);
    expect(fs.existsSync(target)).toBe(false);
    expect(await artifactCount()).toBe(before);
  });
});

describe('subledger generate writes both auxiliaries the official XSD accepts', () => {
  it('--kind folios validates against AuxiliarFolios 1.3 (refund request, NumTramite)', async () => {
    const target = path.join(tmpRoot, 'folios.xml');
    const r = await run([
      'subledger', 'generate', ...PERIOD, '--kind', 'folios',
      '--request-type', 'DE', '--procedure-number', 'DE202600000009', '-o', target, '--yes',
    ]);
    expect(r.exitCode, `${r.err}\n${String(r.errs[0])}`).toBe(ExitCode.OK);
    const xml = fs.readFileSync(target, 'utf8');
    expect(validateAgainstOfficialXsd(xml, 'voucherAuxiliary')).toEqual({ valid: true, errors: [] });
    expect(xml).toContain(`UUID_CFDI="${billUuid}"`);
    expect(xml).toContain('NumTramite="DE202600000009"');
  });

  it('--kind accounts validates against AuxiliarCtas 1.3', async () => {
    const target = path.join(tmpRoot, 'cuentas.xml');
    const r = await run(['subledger', 'generate', ...PERIOD, '--kind', 'accounts', ...AUDIT, '-o', target, '--yes']);
    expect(r.exitCode, `${r.err}\n${String(r.errs[0])}`).toBe(ExitCode.OK);
    const xml = fs.readFileSync(target, 'utf8');
    expect(validateAgainstOfficialXsd(xml, 'accountAuxiliary')).toEqual({ valid: true, errors: [] });
    expect(xml).toContain('NumCta="2110"');
  });
});
