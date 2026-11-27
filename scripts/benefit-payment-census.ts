#!/usr/bin/env tsx
import dotenv from 'dotenv';
// Not `import 'dotenv/config'`: since dotenv 17 that form prints its banner to
// stdout, which here is the script's output.
dotenv.config({ quiet: true });
import Decimal from 'decimal.js';
import { query, enterTenant, closeDatabase } from '../src/database/connection.js';
import {
  censusBenefitPayments,
  type BenefitPaymentCensus,
} from '../src/services/payroll/common/benefit-payment-census.js';

// ============================================================
// Command-line wrapper over services/payroll/common/benefit-payment-census
// (MNE-001-878, part 3). The logic lives there so integration tests cover it;
// here there is only argument reading and presentation.
//
// It writes nothing, and has no flag that does. For each entity it lists the
// pay-run entries that paid a year-end bonus, vacation days or a vacation
// premium to wages while the provision of that benefit held it: the entry,
// its month, what it paid, what it debited to the provision, and what a
// correction would move from wages to the provision. A person runs it.
//
//   npm run census:benefit-payments -- --tenant <uuid> [--entity <uuid>] [--json]
// ============================================================

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function print(name: string, census: BenefitPaymentCensus): void {
  console.log(`\n${name}\n${'─'.repeat(72)}`);
  if (census.findings.length === 0) {
    console.log('No pay-run entry paid an accrued benefit to wages while its provision held it.');
    return;
  }
  for (const x of census.findings) {
    console.log(
      `${x.month}  ${x.entryNumber.padEnd(18)} ${x.entryDate}  ${x.benefit.padEnd(17)} paid ${x.paid.padStart(12)}` +
        `  to ${x.provisionAccount} ${x.debited.padStart(12)}  expensed while held ${x.expensedWhileHeld.padStart(12)}`
    );
  }
  const months = new Map<string, Decimal>();
  for (const x of census.findings) months.set(x.month, (months.get(x.month) ?? new Decimal(0)).plus(x.expensedWhileHeld));
  console.log('\nBy the month of each entry');
  for (const [month, sum] of [...months].sort(([a], [b]) => (a < b ? -1 : 1))) {
    console.log(`  ${month}  ${sum.toFixed(2).padStart(14)}`);
  }
  console.log('\nBy provision');
  for (const p of census.provisions) {
    console.log(`  ${p.account} ${p.benefit.padEnd(17)} holds ${p.heldNow.padStart(14)} today · expensed while held ${p.expensedWhileHeld.padStart(12)}`);
  }
}

async function main(): Promise<void> {
  const tenantId = arg('tenant');
  if (!tenantId) {
    console.error('Missing --tenant <uuid>. With no tenant there is nothing to scope.');
    process.exit(2);
  }
  enterTenant(tenantId);

  const only = arg('entity') ?? null;
  const entities = await query<{ id: string; name: string }>(
    `SELECT id, name FROM legal_entities
      WHERE tenant_id = $1 AND ($2::uuid IS NULL OR id = $2::uuid)
      ORDER BY created_at, id`,
    [tenantId, only]
  );
  if (entities.rows.length === 0) {
    console.error(only ? `Entity ${only} is not of this tenant.` : 'The tenant has no entity.');
    process.exit(2);
  }

  const all: Array<BenefitPaymentCensus & { entityName: string }> = [];
  for (const e of entities.rows) {
    all.push({ ...(await censusBenefitPayments({ tenantId, entityId: e.id })), entityName: e.name });
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(all, null, 2));
    return;
  }
  console.log('Benefits paid to wages while their provision held them (NIF D-3)');
  for (const c of all) print(c.entityName, c);
  console.log(
    `\n${'─'.repeat(72)}\nCensus only: nothing was written, and nothing here can write. Each amount was expensed at ` +
      'the close that accrued it and again in the pay run, and is still owed on the books; correcting it debits ' +
      'the provision and credits wages, in an entry a person reviews.'
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
