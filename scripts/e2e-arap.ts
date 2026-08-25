/**
 * E2E: AR/AP → GL wiring, atomic numbering, and balance carryforward,
 * against the REAL database (Demo Corp MX). Creates its own documents and
 * cleans them up. Run with: npx tsx scripts/e2e-arap.ts
 */
import { v4 as uuidv4 } from 'uuid';
import { enterTenant, query, withTransaction, closeDatabase } from '../src/database/connection.js';
import { createJournalEntry, drainAttestations, voidJournalEntryInTx } from '../src/services/accounting/posting.js';
import {
  postInvoiceEntry,
  postBillEntry,
  postCustomerPaymentEntry,
  postVendorPaymentEntry,
} from '../src/services/accounting/ar-ap-posting.js';
import { carryForwardBalances } from '../src/services/accounting/period-close.js';
import { JournalEntryType } from '../src/types/index.js';
import type { Invoice, InvoiceLine, Bill, BillLine } from '../src/types/index.js';

const TENANT = 'f4642318-31ed-4870-ad34-ee6aa502b774';
const ENTITY = '1ddac7ab-1f0d-42a2-8e21-6387fd1789bb';
const USER = '1054c71f-5c88-4390-b8f8-a429ef04172b';
const CUSTOMER = 'd40e573b-7fe5-4256-95a9-d13228c969d8';
const VENDOR = '36b2b764-851d-418f-9eeb-069e1cb48d35';
const AUG_2026_PERIOD = '5fb92480-fb84-47a4-b5f3-dbdbf2f0661a';

let pass = 0, fail = 0;
const jeIds: string[] = [];
const docCleanup: Array<{ table: string; id: string }> = [];

function ok(cond: boolean, label: string) {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label); }
}

async function jeLinesOf(jeId: string) {
  return (await query<{ account_id: string; debit_amount: string | null; credit_amount: string | null }>(
    'SELECT account_id, debit_amount, credit_amount FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY line_number',
    [jeId]
  )).rows;
}

async function main() {
  enterTenant(TENANT);

  const roles = new Map(
    (await query<{ role: string; account_id: string }>(
      `SELECT role, account_id FROM account_roles WHERE entity_id = $1 AND qualifier IS NULL`, [ENTITY]
    )).rows.map((r) => [r.role, r.account_id])
  );

  console.log('1. Numeración atómica: 5 asientos concurrentes, 5 números distintos');
  const entries = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      createJournalEntry(ENTITY, new Date(), JournalEntryType.STANDARD, `E2E seq ${i}`, [
        { account_id: roles.get('banco')!, debit_amount: '10.00', credit_amount: null, description: 'seq' },
        { account_id: roles.get('cxc')!, debit_amount: null, credit_amount: '10.00', description: 'seq' },
      ], USER)
    )
  );
  entries.forEach((e) => jeIds.push(e.id));
  const numbers = new Set(entries.map((e) => e.entry_number));
  ok(numbers.size === 5, `números únicos: ${[...numbers].join(', ')}`);

  console.log('2. Factura → asiento (DR CxC / CR Ingresos / CR IVA)');
  const invId = uuidv4();
  docCleanup.push({ table: 'invoices', id: invId });
  await query(
    `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount, total_amount, amount_due, currency_code, invoice_date, due_date, status, created_by)
     VALUES ($1, $2, 'INV-E2E-1', $3, 1000, 160, 1160, 1160, 'MXN', CURRENT_DATE, CURRENT_DATE + 30, 'sent', $4)`,
    [invId, ENTITY, CUSTOMER, USER]
  );
  await query(
    `INSERT INTO invoice_lines (id, invoice_id, line_number, description, quantity, unit_price, revenue_account_id, tax_amount, line_amount, total_amount)
     VALUES ($1, $2, 1, 'Servicio E2E', 1, 1000, $3, 160, 1000, 1160)`,
    [uuidv4(), invId, roles.get('ingreso')]
  );

  const invEntry = await withTransaction(async (client) => {
    const inv = (await client.query<Invoice>('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [invId])).rows[0];
    const lines = (await client.query<InvoiceLine>('SELECT * FROM invoice_lines WHERE invoice_id = $1', [invId])).rows;
    return postInvoiceEntry(client, inv, lines, USER);
  });
  ok(!!invEntry, 'asiento creado');
  if (invEntry) {
    jeIds.push(invEntry.id);
    ok(invEntry.status === 'posted' && invEntry.entry_type === 'auto_invoice', 'posteado como auto_invoice');
    const lines = await jeLinesOf(invEntry.id);
    const dr = lines.find((l) => l.account_id === roles.get('cxc'));
    const iva = lines.find((l) => l.account_id === roles.get('iva_trasladado'));
    ok(Number(dr?.debit_amount) === 1160, 'DR CxC 1160');
    ok(Number(iva?.credit_amount) === 160, 'CR IVA trasladado 160');
    const linked = (await query<{ journal_entry_id: string }>('SELECT journal_entry_id FROM invoices WHERE id = $1', [invId])).rows[0];
    ok(linked.journal_entry_id === invEntry.id, 'invoice.journal_entry_id enlazado');
  }

  console.log('3. Idempotencia: segundo posteo devuelve null');
  const again = await withTransaction(async (client) => {
    const inv = (await client.query<Invoice>('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [invId])).rows[0];
    return postInvoiceEntry(client, inv, [], USER);
  });
  ok(again === null, 'no duplica');

  console.log('4. Pago de cliente → asiento (DR Banco / CR CxC)');
  const payId = uuidv4();
  docCleanup.push({ table: 'customer_payments', id: payId });
  await query(
    `INSERT INTO customer_payments (id, entity_id, payment_number, customer_id, payment_amount, payment_method, payment_date, status, created_by)
     VALUES ($1, $2, 'PMT-E2E-1', $3, 1160, 'spei', CURRENT_DATE, 'completed', $4)`,
    [payId, ENTITY, CUSTOMER, USER]
  );
  const payEntry = await withTransaction(async (client) =>
    postCustomerPaymentEntry(client, {
      id: payId, entity_id: ENTITY, payment_number: 'PMT-E2E-1',
      payment_amount: '1160.0000', payment_date: new Date(), bank_account_id: null, journal_entry_id: null,
    }, USER)
  );
  ok(!!payEntry, 'asiento de cobro creado');
  if (payEntry) {
    jeIds.push(payEntry.id);
    const lines = await jeLinesOf(payEntry.id);
    ok(lines.some((l) => l.account_id === roles.get('banco') && Number(l.debit_amount) === 1160), 'DR Banco (rol fallback)');
  }

  console.log('5. Bill → asiento (CR CxP / DR Gasto / DR IVA acreditable)');
  const billId = uuidv4();
  docCleanup.push({ table: 'bills', id: billId });
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, subtotal, tax_amount, total_amount, amount_due, currency_code, bill_date, due_date, status, created_by)
     VALUES ($1, $2, 'BILL-E2E-1', $3, 500, 80, 580, 580, 'MXN', CURRENT_DATE, CURRENT_DATE + 30, 'approved', $4)`,
    [billId, ENTITY, VENDOR, USER]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1, $2, 1, $3, 'Gasto E2E', 1, 500, 500, 80, 580)`,
    [uuidv4(), billId, roles.get('gasto')]
  );
  const billEntry = await withTransaction(async (client) => {
    const bill = (await client.query<Bill>('SELECT * FROM bills WHERE id = $1 FOR UPDATE', [billId])).rows[0];
    const lines = (await client.query<BillLine>('SELECT * FROM bill_lines WHERE bill_id = $1', [billId])).rows;
    return postBillEntry(client, bill, lines, USER);
  });
  ok(!!billEntry, 'asiento de bill creado');
  if (billEntry) {
    jeIds.push(billEntry.id);
    ok(billEntry.entry_type === 'auto_bill', "tipo 'auto_bill' aceptado por la BD");
    const lines = await jeLinesOf(billEntry.id);
    ok(lines.some((l) => l.account_id === roles.get('cxp') && Number(l.credit_amount) === 580), 'CR CxP 580');
    ok(lines.some((l) => l.account_id === roles.get('iva_acreditable') && Number(l.debit_amount) === 80), 'DR IVA acreditable 80');
  }

  console.log('6. Pago a proveedor → asiento (DR CxP / CR Banco)');
  const vpayId = uuidv4();
  docCleanup.push({ table: 'vendor_payments', id: vpayId });
  await query(
    `INSERT INTO vendor_payments (id, entity_id, payment_number, vendor_id, payment_amount, payment_method, payment_date, status, created_by)
     VALUES ($1, $2, 'VPMT-E2E-1', $3, 580, 'spei', CURRENT_DATE, 'completed', $4)`,
    [vpayId, ENTITY, VENDOR, USER]
  );
  const vpayEntry = await withTransaction(async (client) =>
    postVendorPaymentEntry(client, {
      id: vpayId, entity_id: ENTITY, payment_number: 'VPMT-E2E-1',
      payment_amount: '580.0000', payment_date: new Date(), bank_account_id: null, journal_entry_id: null,
    }, USER)
  );
  ok(!!vpayEntry, 'asiento de pago a proveedor creado');
  if (vpayEntry) jeIds.push(vpayEntry.id);

  console.log('7. Void de factura → reversa enlazada del asiento');
  if (invEntry) {
    const { reversal } = await withTransaction(async (client) =>
      voidJournalEntryInTx(client, invEntry.id, USER, 'Invoice INV-E2E-1 voided')
    );
    ok(!!reversal && reversal.reverses_entry_id === invEntry.id, 'reversa enlazada creada');
    if (reversal) jeIds.push(reversal.id);
  }

  console.log('8. Carryforward de saldos (transacción con ROLLBACK)');
  const rollbackMark = new Error('rollback-a-propósito');
  try {
    await withTransaction(async (client) => {
      const carried = await carryForwardBalances(client, ENTITY, AUG_2026_PERIOD);
      const next = await client.query<{ id: string; start_date: string }>(
        `SELECT id FROM fiscal_periods WHERE entity_id = $1
         AND start_date > (SELECT end_date FROM fiscal_periods WHERE id = $2)
         ORDER BY start_date LIMIT 1`,
        [ENTITY, AUG_2026_PERIOD]
      );
      if (next.rows.length === 0) {
        ok(carried === 0, 'sin periodo siguiente: 0 cuentas arrastradas (correcto)');
      } else {
        ok(carried > 0, `${carried} cuentas de balance arrastradas`);
        const sample = await client.query<{ beginning_balance: string; ending_balance: string; ok: boolean }>(
          `SELECT nb.beginning_balance, nb.ending_balance,
                  nb.beginning_balance = ab.ending_balance AS ok
           FROM account_balances ab
           JOIN account_balances nb ON nb.account_id = ab.account_id AND nb.fiscal_period_id = $2
           JOIN accounts a ON a.id = ab.account_id
           WHERE ab.fiscal_period_id = $1 AND a.account_type IN ('asset','liability','equity')
             AND ab.ending_balance <> 0
           LIMIT 3`,
          [AUG_2026_PERIOD, next.rows[0].id]
        );
        ok(sample.rows.length > 0 && sample.rows.every((r) => r.ok), 'beginning(next) = ending(cerrado)');
      }
      throw rollbackMark; // nunca persistir: el periodo NO se está cerrando de verdad
    });
  } catch (e) {
    if (e !== rollbackMark) throw e;
  }

  await drainAttestations(2000);

  // ── Limpieza ──
  await query('UPDATE invoices SET journal_entry_id = NULL WHERE id = $1', [invId]);
  await query('UPDATE bills SET journal_entry_id = NULL WHERE id = $1', [billId]);
  await query('UPDATE customer_payments SET journal_entry_id = NULL WHERE id = $1', [payId]);
  await query('UPDATE vendor_payments SET journal_entry_id = NULL WHERE id = $1', [vpayId]);
  await query('UPDATE journal_entries SET reversed_by_entry_id = NULL, reverses_entry_id = NULL WHERE id = ANY($1)', [jeIds]);
  const posted = (await query<{ account_id: string; fp: string; d: string; c: string }>(
    `SELECT jel.account_id, je.fiscal_period_id AS fp, COALESCE(SUM(jel.debit_amount),0) AS d, COALESCE(SUM(jel.credit_amount),0) AS c
     FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id
     WHERE je.id = ANY($1) AND je.status = 'posted' GROUP BY 1, 2`, [jeIds]
  )).rows;
  for (const r of posted) {
    await query(
      `UPDATE account_balances SET debit_total = debit_total - $3, credit_total = credit_total - $4, ending_balance = ending_balance - $3 + $4
       WHERE account_id = $1 AND fiscal_period_id = $2`, [r.account_id, r.fp, r.d, r.c]);
  }
  await query('DELETE FROM journal_entries WHERE id = ANY($1)', [jeIds]);
  for (const doc of docCleanup) {
    await query(`DELETE FROM ${doc.table} WHERE id = $1`, [doc.id]);
  }
  console.log(`\nLimpieza: ${jeIds.length} asientos y ${docCleanup.length} documentos de prueba eliminados.`);
  console.log(`RESULTADO: ${pass} ✓ / ${fail} ✗`);
  await closeDatabase();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error('FATAL', e); process.exit(2); });
