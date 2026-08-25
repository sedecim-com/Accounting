/**
 * E2E: reversal/void guards against the REAL database (NIF B-1 semantics).
 * Run with: npx tsx scripts/e2e-reversal.ts   (needs DATABASE_URL and the
 * seeded Demo Corp MX tenant). Creates its own entries and cleans them up.
 */
import { enterTenant, query, closeDatabase } from '../src/database/connection.js';
import {
  createJournalEntry, postJournalEntry, voidJournalEntry, reverseJournalEntry, drainAttestations,
} from '../src/services/accounting/posting.js';
import { JournalEntryType } from '../src/types/index.js';

const TENANT = 'f4642318-31ed-4870-ad34-ee6aa502b774';
const ENTITY = '1ddac7ab-1f0d-42a2-8e21-6387fd1789bb';
const USER = '1054c71f-5c88-4390-b8f8-a429ef04172b';
const ACC_A = '31977784-941f-48ad-9334-84a443dd0546'; // 1110
const ACC_B = 'd552ea1f-d670-4f88-98c4-a7a5f9c159b7'; // 1120

const created: string[] = [];
let pass = 0, fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label); }
}
const lines = (amt: string) => [
  { account_id: ACC_A, debit_amount: amt, credit_amount: null, description: 'E2E test debit' },
  { account_id: ACC_B, debit_amount: null, credit_amount: amt, description: 'E2E test credit' },
];
async function expectError(fn: () => Promise<unknown>, code: string, label: string) {
  try { await fn(); ok(false, `${label} (no lanzó)`); }
  catch (e) { const m = e instanceof Error ? e.message : String(e); ok(m.includes(code) || (e as {code?:string}).code === code, `${label} [${(e as {code?:string}).code ?? m.slice(0,60)}]`); }
}

async function main() {
  enterTenant(TENANT);

  console.log('1. Reversar un DRAFT debe rechazarse');
  const draft = await createJournalEntry(ENTITY, new Date(), JournalEntryType.STANDARD, 'E2E draft', lines('100.00'), USER);
  created.push(draft.id);
  await expectError(() => reverseJournalEntry(draft.id, USER), 'ENTRY_NOT_POSTED', 'draft no reversable');

  console.log('2. Postear y reversar una vez: enlace en ambas direcciones');
  await postJournalEntry(draft.id, USER);
  const rev = await reverseJournalEntry(draft.id, USER, { reason: 'E2E test' });
  created.push(rev.id);
  ok(rev.is_reversal === true, 'espejo marcado is_reversal');
  ok(rev.reverses_entry_id === draft.id, 'espejo apunta al original');
  const orig = (await query<{ reversed_by_entry_id: string; status: string }>(
    'SELECT reversed_by_entry_id, status FROM journal_entries WHERE id = $1', [draft.id])).rows[0];
  ok(orig.reversed_by_entry_id === rev.id, 'original apunta al espejo');
  ok(orig.status === 'posted', 'original sigue posted');

  console.log('3. Segunda reversa debe rechazarse');
  await expectError(() => reverseJournalEntry(draft.id, USER), 'ALREADY_REVERSED', 'doble reversa bloqueada');

  console.log('4. Void de un asiento POSTEADO = reversa enlazada, sigue posted');
  const e2 = await createJournalEntry(ENTITY, new Date(), JournalEntryType.STANDARD, 'E2E void-posted', lines('250.00'), USER, { autoPost: true });
  created.push(e2.id);
  const voided = await voidJournalEntry(e2.id, USER, 'E2E anulación');
  ok(voided.status === 'posted', 'anulado permanece posted');
  ok(!!voided.reversed_by_entry_id, 'anulado enlaza su espejo');
  if (voided.reversed_by_entry_id) created.push(voided.reversed_by_entry_id);
  await expectError(() => voidJournalEntry(e2.id, USER, 'otra vez'), 'ALREADY_REVERSED', 'doble void bloqueado');

  console.log('5. Void de un DRAFT = status void, sin espejo');
  const d2 = await createJournalEntry(ENTITY, new Date(), JournalEntryType.STANDARD, 'E2E void-draft', lines('50.00'), USER);
  created.push(d2.id);
  const dv = await voidJournalEntry(d2.id, USER, 'cancelado');
  ok(dv.status === 'void' && !dv.reversed_by_entry_id, 'draft anulado sin reversa');

  console.log('6. Saldos netos en cero tras original+espejo');
  const bal = (await query<{ s: string }>(
    `SELECT COALESCE(SUM(CASE WHEN jel.account_id=$2 THEN COALESCE(jel.debit_amount,0)-COALESCE(jel.credit_amount,0) END),0) AS s
     FROM journal_entry_lines jel JOIN journal_entries je ON je.id=jel.journal_entry_id
     WHERE je.id = ANY($1) AND je.status='posted'`, [[...created], ACC_A])).rows[0];
  ok(Number(bal.s) === 0, `neto cuenta 1110 = ${bal.s}`);

  console.log("7. entry_type 'payroll' aceptado por la BD (CHECK ampliado)");
  const pj = await createJournalEntry(ENTITY, new Date(), JournalEntryType.PAYROLL, 'E2E payroll type', lines('10.00'), USER);
  created.push(pj.id);
  ok(pj.entry_type === 'payroll', 'INSERT payroll no viola CHECK');

  await drainAttestations(2000);
  // Limpieza: quitar enlaces, luego borrar (lines caen por CASCADE); revertir saldos de balances de prueba
  await query('UPDATE journal_entries SET reversed_by_entry_id = NULL, reverses_entry_id = NULL WHERE id = ANY($1)', [created]);
  const posted = (await query<{ account_id: string; fp: string; d: string; c: string }>(
    `SELECT jel.account_id, je.fiscal_period_id AS fp, COALESCE(SUM(jel.debit_amount),0) AS d, COALESCE(SUM(jel.credit_amount),0) AS c
     FROM journal_entry_lines jel JOIN journal_entries je ON je.id=jel.journal_entry_id
     WHERE je.id = ANY($1) AND je.status='posted' GROUP BY 1,2`, [created])).rows;
  for (const r of posted) {
    await query(
      `UPDATE account_balances SET debit_total=debit_total-$3, credit_total=credit_total-$4, ending_balance=ending_balance-$3+$4
       WHERE account_id=$1 AND fiscal_period_id=$2`, [r.account_id, r.fp, r.d, r.c]);
  }
  await query('DELETE FROM journal_entries WHERE id = ANY($1)', [created]);
  console.log(`\nLimpieza: ${created.length} asientos de prueba eliminados y saldos restaurados.`);
  console.log(`RESULTADO: ${pass} ✓ / ${fail} ✗`);
  await closeDatabase();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(2); });
