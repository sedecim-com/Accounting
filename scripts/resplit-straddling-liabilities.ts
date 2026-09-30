#!/usr/bin/env tsx
import dotenv from 'dotenv';
// Not `import 'dotenv/config'`: that form takes no options and, since dotenv
// 17, prints its banner on stdout, which here is the script's output.
dotenv.config({ quiet: true });
import { enterTenant, closeDatabase } from '../src/database/connection.js';
import { resplitStraddlingLiabilities } from '../src/services/payroll/common/employer-liability-service.js';

// ============================================================
// Command-line wrapper over `resplitStraddlingLiabilities` (#231). The logic
// lives in the service so integration tests cover it; this only reads the
// arguments and prints.
//
// A pay run approved before the split booked a period that crosses a month
// whole in the month of its `period_end`. This re-accrues those runs with the
// same code an approval runs, so each month gets its share by contribution
// days. By default it writes NOTHING: it prints what --apply would change.
// Running it again after --apply finds nothing.
//
//   npm run backfill:straddling-liabilities -- --tenant <uuid>
//   npm run backfill:straddling-liabilities -- --tenant <uuid> --apply
// ============================================================

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const tenantId = arg('tenant');
  const apply = process.argv.includes('--apply');
  if (!tenantId) {
    console.error('Missing --tenant <uuid>: without a tenant there is nothing to scope.');
    process.exit(2);
  }
  enterTenant(tenantId);

  const results = await resplitStraddlingLiabilities(tenantId, { apply });
  if (results.length === 0) {
    console.log('No straddling pay run has a liability to re-split. Nothing to do.');
    return;
  }
  for (const r of results) {
    console.log(`\nPay run ${r.payRunId} · ${r.periodStart}..${r.periodEnd} · ${r.outcome}`);
    if (r.outcome === 'skipped_settled') {
      console.log(
        '  A whole-period IMSS/INFONAVIT row of this run is no longer pending: it is evidence of a ' +
          'payment and is not rewritten. Settle the split with a complementary filing.'
      );
      process.exitCode = 1;
      continue;
    }
    for (const row of r.removed) console.log(`  - ${row}`);
    for (const row of r.added) console.log(`  + ${row}`);
    for (const f of r.findings) console.log(`  ⚠ ${f.codigo}: ${f.mensaje}`);
  }
  console.log(apply ? '\nApplied.' : '\nCensus only, nothing written. Re-run with --apply to write it.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
