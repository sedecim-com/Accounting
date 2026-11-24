import { describe, it, expect, afterAll, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations, reverseJournalEntry } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { createCreditNote, issueCreditNote } from '../../src/services/ar/credit-note-service.js';
import { recordCustomerPayment, unapplyCustomerPayment, reverseCustomerPayment } from '../../src/services/payments/payment-service.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';

// ============================================================
// MNE-001-606 (#814, part 2/2 of MNE-001-583) · THE IVA PAPER NAMES THE
// UNDOES POSTED AFTER A CREDIT NOTE UNDER THE RULE BEFORE MNE-001-581, AND THE
// NOTE WHOSE ENTRY WAS REVERSED BY HAND AFTER A CAPPED UNAPPLY (581 risks 5, 6)
//
// One entity per story. Every invoice PPD at 16 % dated 2026-10-03, collected
// by wire on 10-05; every note a return on 10-10 that takes its IVA from 2120
// (575: nothing is parked once collected); unapplies on 10-15.
//
// THE RULE BEFORE 581 is reproduced by posting through the real services while
// `issuedVatOfOpenBalance` answers «no note» (`oldRule`): the unapply then
// credits 2125 with the whole release, and the reversal posts no correction.
//
//   O1  S 1,000 + 160 collected 1,160 (releases 160); N 200 + 32 (2120 32);
//       old unapply under repark_same_month: DR 2120 160 / CR 2125 160, the
//       pre-574 entry. 581 keeps min(160, 32) = 32: the paper names 32.
//   O2  S 100 + 16 collected 116; N 100 + 16 (2120 16); old unapply under
//       keep_caused: CR 2125 16 against 2150. Named for 16.
//   O3  S 1,160; R1 580 and R2 580 (80 each); N 200 + 32 (2120 32); R1 and
//       then R2 unapplied old. R1 should have kept min(80, 32) = 32, which
//       uses the restitution up; R2 min(80, 0) = 0: only R1 is named.
//   O4  S 100 + 16 collected; N 100 + 16; old reversal not_collected on 11-05,
//       no correction: named for 16 in November, and in October, the note's
//       month, which subtracted 16 never caused (583 reads no correction).
//   C1  O1 under 581: the unapply credits 2125 128 and keeps 32. Nothing.
//   C2  an old unapply before the note: the note takes from 2125, restitutes
//       nothing from 2120. Nothing.
//   H1  C1, then N's entry reversed by hand on 10-20: the 32 kept in 2120
//       for N is owed again and nothing re-parked it. N named for 32.
//   H2  N reversed by hand with no unapply: nothing.
// ============================================================

const oldRule = vi.hoisted(() => ({ on: false }));

vi.mock('../../src/services/accounting/iva-cash-basis.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/accounting/iva-cash-basis.js')>();
  return {
    ...real,
    issuedVatOfOpenBalance: async (...args: Parameters<typeof real.issuedVatOfOpenBalance>) => {
      const open = await real.issuedVatOfOpenBalance(...args);
      return oldRule.on ? { ...open, hasNote: false, noteNumbers: '' } : open;
    },
  };
});

const oct = (d: number): string => `2026-10-${String(d).padStart(2, '0')}`;

interface Book { f: Fixture; customerId: string }

async function book(name: string, repark = false): Promise<Book> {
  const f = await crearInquilino(`MNE-001-606 ${name}`);
  await seedPolicies({ tenantId: f.tenantId });
  if (repark) {
    await resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, 'plain_receipt_unapply_iva', 'repark_same_month', 'it@example.test');
  }
  const customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Cliente Sintetico Regla Vieja SA', 'MXN', $4)`,
    [customerId, f.entityId, `C-606-${customerId.slice(0, 6)}`, f.userId]
  );
  return { f, customerId };
}

async function sale(b: Book, price: string): Promise<string> {
  const draft = await createInvoice({
    entity_id: b.f.entityId, customer_id: b.customerId, invoice_date: oct(3), due_date: oct(3), currency_code: 'MXN',
    terms: 'PPD',
    lines: [{ revenue_account_id: b.f.cuentas['4100'], description: 'Synthetic sale', quantity: '1', unit_price: price, tax_rate: '16' }],
    created_by: b.f.userId,
  });
  return (await issueInvoice(draft.id, b.f.userId, { entityId: b.f.entityId })).invoice.id;
}

const collect = (b: Book, invoiceId: string, amount: string) =>
  recordCustomerPayment(
    { entityId: b.f.entityId, counterpartyId: b.customerId, paymentAmount: amount, paymentDate: oct(5),
      paymentMethod: 'spei', applications: [{ documentId: invoiceId, amountApplied: amount }] },
    b.f.userId
  );

async function note(b: Book, invoiceId: string, subtotal: string, tax: string): Promise<{ number: string; entryId: string }> {
  const cn = await createCreditNote({
    entity_id: b.f.entityId, customer_id: b.customerId, invoice_id: invoiceId, type: 'devolucion',
    credit_date: oct(10), subtotal, tax_amount: tax,
  }, b.f.userId);
  await issueCreditNote(b.f.entityId, cn.id, b.f.userId);
  const { rows: [r] } = await query<{ journal_entry_id: string }>(
    'SELECT journal_entry_id::text FROM credit_notes WHERE id = $1 AND entity_id = $2', [cn.id, b.f.entityId]
  );
  return { number: cn.credit_note_number, entryId: r.journal_entry_id };
}

/** Posted as the code before MNE-001-581 posted it when `old`. */
async function under<T>(old: boolean, act: () => Promise<T>): Promise<T> {
  oldRule.on = old;
  try {
    return await act();
  } finally {
    oldRule.on = false;
  }
}

/** The panel key is read under the tenant in context, so each story's own is entered first. */
const unapply = (b: Book, paymentId: string, invoiceId: string, old: boolean) =>
  under(old, () => {
    enterTenant(b.f.tenantId);
    return unapplyCustomerPayment(b.f.entityId, paymentId, { invoiceId, reason: 'wrong invoice', date: oct(15) }, b.f.userId);
  });

/** `receipt reverse` has no --date: its mirrors take the clock's day. */
async function reverse(b: Book, paymentId: string, on: string, old: boolean) {
  vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(new Date(`${on}T12:00:00`));
  try {
    return await under(old, () => reverseCustomerPayment(b.f.entityId, paymentId, { reason: 'bounced', cause: 'not_collected' }, b.f.userId));
  } finally {
    vi.useRealTimers();
  }
}

const paper = (b: Book, month: number): Promise<IvaWorkpaper> =>
  buildIvaWorkpaper({ tenantId: b.f.tenantId, entityId: b.f.entityId, year: 2026, month });
const OLD = 'IVA-WP-UNDO-AFTER-NOTE-OLD-RULE';
const CAP = 'IVA-WP-NOTE-REVERSED-AFTER-CAP';
const named = (wp: IvaWorkpaper, code: string) => wp.findings.filter((h) => h.codigo === code);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('581 risk 5: an undo after a note under the rule before 581 is named with what should have stayed in 2120', () => {
  it('O1 · partial note, old unapply under repark_same_month (DR 2120 160 / CR 2125 160): October names 32', async () => {
    const b = await book('O1', true);
    const s = await sale(b, '1000.00');
    const r = await collect(b, s, '1160.00');
    const n = await note(b, s, '200.00', '32.00');
    const undone = await unapply(b, r.paymentId, s, true);
    expect(undone.ivaReAparcado).toBe('160.0000');
    const [h, ...more] = named(await paper(b, 10), OLD);
    expect(more).toEqual([]);
    expect(h).toMatchObject({ severidad: 'aviso', documentNumber: r.paymentNumber });
    expect(h.mensaje).toContain(`La desaplicación ${undone.journalEntry.entry_number} del 2026-10-15 del cobro ${r.paymentNumber}`);
    expect(h.mensaje).toContain('re-aparcó en iva_trasladado_no_cobrado 160.0000');
    expect(h.mensaje).toContain(`32.0000 debieron quedarse en iva_trasladado, porque la nota de crédito ${n.number}`);
    expect(h.mensaje).toContain('NIF B-1');
    expect(named(await paper(b, 11), OLD)).toEqual([]);
  }, 120_000);

  it('O2 · the issue, old unapply under keep_caused (CR 2125 16 against 2150): October names 16', async () => {
    const b = await book('O2');
    const s = await sale(b, '100.00');
    const r = await collect(b, s, '116.00');
    const n = await note(b, s, '100.00', '16.00');
    await unapply(b, r.paymentId, s, true);
    const [h, ...more] = named(await paper(b, 10), OLD);
    expect(more).toEqual([]);
    expect(h.mensaje).toContain(`16.0000 debieron quedarse en iva_trasladado, porque la nota de crédito ${n.number}`);
  }, 120_000);

  it('O3 · two receipts unapplied old: R1 should have kept the 32 and used the restitution up, so R2 is not named', async () => {
    const b = await book('O3', true);
    const s = await sale(b, '1000.00');
    const r1 = await collect(b, s, '580.00');
    const r2 = await collect(b, s, '580.00');
    await note(b, s, '200.00', '32.00');
    await unapply(b, r1.paymentId, s, true);
    await unapply(b, r2.paymentId, s, true);
    const found = named(await paper(b, 10), OLD);
    expect(found.map((h) => h.documentNumber)).toEqual([r1.paymentNumber]);
    expect(found[0].mensaje).toContain('32.0000 debieron quedarse en iva_trasladado');
  }, 120_000);

  it('O4 · an old reversal not_collected: November names it for 16, and October, the note\'s month, names its amended return', async () => {
    const b = await book('O4');
    const s = await sale(b, '100.00');
    const r = await collect(b, s, '116.00');
    const n = await note(b, s, '100.00', '16.00');
    await reverse(b, r.paymentId, '2026-11-05', true);
    const [h, ...more] = named(await paper(b, 11), OLD);
    expect(more).toEqual([]);
    expect(h.mensaje).toContain(`La reversa del cobro ${r.paymentNumber} del 2026-11-05`);
    expect(h.mensaje).toContain(`16.0000 debieron quedarse en iva_trasladado, porque la nota de crédito ${n.number}`);
    expect(h.mensaje).toContain(`el mes de la nota ${n.number}, 2026-10, restó 16.0000 de IVA que nunca se causó`);
    const [october] = named(await paper(b, 10), OLD);
    expect(october?.mensaje).toBe(h.mensaje);
  }, 120_000);
});

describe('controls: books posted under 581, or an undo before the note, name nothing', () => {
  it('C1 · O1 under 581: the unapply kept 32, nothing is named', async () => {
    const b = await book('C1', true);
    const s = await sale(b, '1000.00');
    const r = await collect(b, s, '1160.00');
    await note(b, s, '200.00', '32.00');
    expect((await unapply(b, r.paymentId, s, false)).ivaReAparcado).toBe('128.0000');
    const october = await paper(b, 10);
    expect([...named(october, OLD), ...named(october, CAP)]).toEqual([]);
  }, 120_000);

  it('C2 · an old unapply before the note: the note restituted nothing from 2120, nothing is named', async () => {
    const b = await book('C2', true);
    const s = await sale(b, '1000.00');
    const r = await collect(b, s, '1160.00');
    await unapply(b, r.paymentId, s, true);
    await note(b, s, '200.00', '32.00');
    expect(named(await paper(b, 10), OLD)).toEqual([]);
  }, 120_000);
});

describe('581 risk 6: a note reversed by hand after a capped unapply is named with the IVA nothing re-parked', () => {
  it('H1 · the 32 the unapply kept for N is owed again once N\'s entry is reversed on 10-20', async () => {
    const b = await book('H1', true);
    const s = await sale(b, '1000.00');
    const r = await collect(b, s, '1160.00');
    const n = await note(b, s, '200.00', '32.00');
    const undone = await unapply(b, r.paymentId, s, false);
    const mirror = await reverseJournalEntry(n.entryId, b.f.userId, { reason: 'CFDI cancelled', reversalDate: oct(20) });
    const october = await paper(b, 10);
    expect(named(october, OLD)).toEqual([]);
    const [h, ...more] = named(october, CAP);
    expect(more).toEqual([]);
    expect(h).toMatchObject({ severidad: 'aviso', documentNumber: n.number });
    expect(h.mensaje).toContain(`se reversó a mano con la póliza ${mirror.entry_number} del 2026-10-20`);
    expect(h.mensaje).toContain(`después de la desaplicación ${undone.journalEntry.entry_number} del cobro ${r.paymentNumber} del 2026-10-15`);
    expect(h.mensaje).toContain('que dejó 32.0000 en iva_trasladado');
  }, 120_000);

  it('H2 · a note reversed by hand with no unapply: nothing is named', async () => {
    const b = await book('H2');
    const s = await sale(b, '1000.00');
    await collect(b, s, '1160.00');
    const n = await note(b, s, '200.00', '32.00');
    await reverseJournalEntry(n.entryId, b.f.userId, { reason: 'CFDI cancelled', reversalDate: oct(20) });
    expect(named(await paper(b, 10), CAP)).toEqual([]);
  }, 120_000);
});
