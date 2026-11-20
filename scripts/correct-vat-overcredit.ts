#!/usr/bin/env tsx
import dotenv from 'dotenv';
// Not `import 'dotenv/config'`: that form takes no options, and since dotenv 17
// it prints its banner to stdout, which here is the script's output.
dotenv.config({ quiet: true });
import Decimal from 'decimal.js';
import { enterTenant, closeDatabase } from '../src/database/connection.js';
import { censusVatOvercredit, type OvercreditFinding } from '../src/services/accounting/vat-overcredit.js';

// ============================================================
// Command-line wrapper over services/accounting/vat-overcredit (MNE-001-562).
// The logic lives there so integration tests cover it; here there is only
// argument reading and presentation.
//
// It writes nothing: it lists each bill from a received CFDI with IEPS whose
// live payments released more VAT from 1135 to 1130 than the CFDI transfers,
// per payment and per month. A person runs it, never the agent.
//
//   npm run correct:vat-overcredit -- --tenant <uuid> [--entity <uuid>]
//
// The audited correction (`--apply`) is part 2 of the plan of #725.
// ============================================================

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function print(findings: OvercreditFinding[]): void {
  const total = findings.reduce((s, x) => s.plus(x.open), new Decimal(0));
  console.log(`\nVAT released above the CFDI's VAT (IEPS read as VAT before MNE-001-488)\n${'─'.repeat(72)}`);
  console.log(`${findings.length} bill(s) · ${total.toFixed(4)} open in all\n`);

  const months = new Map<string, Decimal>();
  for (const x of findings) {
    const status = x.correctable ? 'correctable' : 'not corrected automatically';
    console.log(`${x.entityName} · ${x.billNumber} · CFDI ${x.cfdiUuid ?? '(no UUID)'}`);
    console.log(
      `  CFDI VAT ${x.vatTransferred} · released ${x.released} · excess ${x.excess} · ` +
        `corrected ${x.corrected} · open ${x.open} · ${status}`
    );
    for (const p of x.payments) {
      console.log(
        `    ${p.paymentNumber.padEnd(16)} ${(p.creditDate ?? 'held cheque').padEnd(11)} ` +
          `applied ${p.applied.padStart(12)} released ${(p.stored ?? 'not stored').padStart(10)} ` +
          `should ${p.should.padStart(10)} excess ${(p.excess ?? '—').padStart(10)}${p.capped ? '  (capped)' : ''}`
      );
    }
    for (const r of x.reasons) console.log(`  ! ${r.code}: ${r.detail}`);
    for (const m of x.byMonth) months.set(m.month, (months.get(m.month) ?? new Decimal(0)).plus(m.excess));
  }

  console.log(`\nExcess by month (the figure of each complementary return, CFF art. 32)`);
  for (const [month, e] of [...months].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${month}  ${e.toFixed(4).padStart(14)}`);
  }
  if (findings.some((x) => x.payments.some((p) => p.capped))) {
    console.log(
      `\nA row marked (capped) released less than the old header's pro rata: the return filed for its month ` +
        `may have declared more than the ledger moved.`
    );
  }
}

async function main(): Promise<void> {
  const tenantId = arg('tenant');
  if (!tenantId) {
    console.error('Missing --tenant <uuid>. With no tenant there is nothing to scope.');
    process.exit(2);
  }
  if (process.argv.includes('--apply')) {
    console.error('The correction is not available yet (part 2 of the plan of #725). This census writes nothing.');
    process.exit(2);
  }
  enterTenant(tenantId);

  const findings = await censusVatOvercredit(tenantId, arg('entity') ?? null);
  if (findings.length === 0) {
    console.log('No bill released more VAT than its CFDI transfers. Nothing to correct.');
    return;
  }
  print(findings);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
