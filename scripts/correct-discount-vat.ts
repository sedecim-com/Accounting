#!/usr/bin/env tsx
import dotenv from 'dotenv';
// Not `import 'dotenv/config'`: since dotenv 17 that form prints its banner to
// stdout, which here is the script's output.
dotenv.config({ quiet: true });
import Decimal from 'decimal.js';
import { query, enterTenant, closeDatabase } from '../src/database/connection.js';
import {
  censusDiscountVat, correctDiscountVat, type DiscountVatFinding,
} from '../src/services/accounting/discount-vat-correction.js';
import { drainAttestations } from '../src/services/accounting/posting.js';

// ============================================================
// Command-line wrapper over services/accounting/discount-vat-correction
// (MNE-001-599). The logic lives there so integration tests cover it; here
// there is only argument reading and presentation.
//
// By default it writes nothing: it lists each bill whose early-payment
// discount, posted before migration 341, left its VAT in 1135, per payment
// and per month. A person runs it, never the agent.
//
//   npm run correct:discount-vat -- --tenant <uuid> [--entity <uuid>]
//   npm run correct:discount-vat -- --tenant <uuid> --apply [--reopen] [--user <uuid>]
//
// `--apply` posts one audited DR 5200 / CR 1135 per bill and payment, dated as
// the panel key discount_vat_correction_period says (by default "ask":
// nothing posts). `--reopen` lets the payment_month option post in a closed
// month; a locked month is never reopened.
// ============================================================

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function print(findings: DiscountVatFinding[]): void {
  const total = findings.reduce((s, x) => s.plus(x.share), new Decimal(0));
  console.log(`\nVAT of early-payment discounts left in 1135 (posted before migration 341)\n${'─'.repeat(72)}`);
  console.log(`${findings.length} bill(s) · ${total.toFixed(4)} to take out of 1135 and off 5200 in all\n`);

  const months = new Map<string, Decimal>();
  for (const x of findings) {
    const status = x.correctable ? 'correctable' : 'not corrected automatically';
    console.log(`${x.entityName} · ${x.billNumber} · ${x.currency} VAT ${x.taxAmount} of ${x.totalAmount}`);
    console.log(`  still in 1135 ${x.parked} · the discounts' VAT ${x.share} · ${status}`);
    for (const r of x.rows) {
      console.log(
        `    ${r.paymentNumber.padEnd(16)} ${r.date.padEnd(11)} discount ${r.discount.padStart(12)} VAT ${r.share.padStart(10)}`
      );
    }
    for (const r of x.reasons) console.log(`  ! ${r.code}: ${r.detail}`);
    if (x.correctable) for (const m of x.byMonth) months.set(m.month, (months.get(m.month) ?? new Decimal(0)).plus(m.share));
  }

  console.log(`\nBy the month each discount was posted (correctable bills)`);
  for (const [month, s] of [...months].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${month}  ${s.toFixed(4).padStart(14)}`);
  }
  console.log(
    `\nThe VAT declared does not change: the DIOT and the IVA paper read what the cash paid. The ISR ` +
      `deductions of the month each correction is dated in rise by its share (the discount was a smaller ` +
      `cost reduction than 5200 says).`
  );
}

async function main(): Promise<void> {
  const tenantId = arg('tenant');
  if (!tenantId) {
    console.error('Missing --tenant <uuid>. With no tenant there is nothing to scope.');
    process.exit(2);
  }
  enterTenant(tenantId);

  const findings = await censusDiscountVat(tenantId, arg('entity') ?? null);
  if (findings.length === 0) {
    console.log('No discount posted before migration 341 left its VAT in 1135. Nothing to correct.');
    return;
  }
  print(findings);

  if (!process.argv.includes('--apply')) {
    console.log(`\n${'─'.repeat(72)}\nCensus only, nothing written. To post the corrections: --apply (and --reopen for a closed month).`);
    return;
  }
  const actor = arg('user') ?? (await firstActiveUser(tenantId));
  if (!actor) {
    console.error('No active user of the tenant to sign the entries. Pass --user <uuid>.');
    process.exit(2);
  }
  const r = await correctDiscountVat(findings, actor, { reopen: process.argv.includes('--reopen') });
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`${r.corrected.length} bill(s) corrected (${r.amount}) · ${r.skipped.length} skipped · ${r.failures.length} failed`);
  for (const c of r.corrected) console.log(`  ✓ ${c.billNumber} ${c.amount} (${c.entryIds.length} entr${c.entryIds.length === 1 ? 'y' : 'ies'})`);
  for (const s of r.skipped) console.log(`  · ${s.billNumber}: ${s.why}`);
  for (const f of r.failures) console.log(`  ✗ ${f}`);
  if (r.failures.length > 0) process.exitCode = 1;
}

async function firstActiveUser(tenantId: string): Promise<string | null> {
  const r = await query<{ id: string }>(
    `SELECT id FROM users WHERE tenant_id = $1 AND is_active = true ORDER BY created_at LIMIT 1`,
    [tenantId]
  );
  return r.rows[0]?.id ?? null;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  // The corrections' attestations are fire-and-forget: without draining them,
  // closeDatabase() kills them and the entries stay posted with no hash.
  .finally(async () => {
    await drainAttestations(5000).catch(() => undefined);
    await closeDatabase();
  });
