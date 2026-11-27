import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { drainAttestations, voidJournalEntry } from '../../src/services/accounting/posting.js';
import { setAccountRole } from '../../src/services/accounting/account-roles-service.js';
import { arReconcile } from '../../src/services/ar/ar-controls.js';
import {
  applyCustomerPayment, recordCustomerPayment, reverseCustomerPayment, unapplyCustomerPayment,
} from '../../src/services/payments/payment-service.js';
import { createCreditNote, issueCreditNote, applyCreditNote } from '../../src/services/ar/credit-note-service.js';
import { buildIvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';
import { recordCustomerCheckCashing } from '../../src/services/banking/treasury-posting.js';
import { v4 as uuidv4 } from 'uuid';
import { importSatChart } from '../../src/services/accounting/sat-chart-import.js';
import { importOpeningBalance, type OpeningDocument } from '../../src/services/accounting/opening-balance.js';
import { resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';

// ============================================================
// MNE-001-946 · #1078 · AN OPEN RECEIVABLE OF THE MIGRATION CARRIES ITS IVA
//
// The failing case of the review of 27 Nov 2026 (report 06, G1), by hand. A
// firm arrives with ONE open customer invoice, A-123, for 116,000.00: a sale
// of 100,000.00 at 16 %, not collected, so its 16,000.00 of IVA is not caused
// yet (LIVA art. 1-B) and the previous system holds it on 209-001, IVA
// trasladado no cobrado.
//
//   ASSETS      102-001 Bank                    100 000 D
//               105-001 Customers               116 000 D   ← A-123
//               → 100 Assets                    216 000 D
//   LIABILITIES 209-001 IVA not yet collected    16 000 A   ← the IVA of A-123
//               → 200 Liabilities                16 000 A
//   EQUITY      301     Share capital           200 000 A
//
// 216 000 = 16 000 + 200 000: the entry foots with no plug.
//
// Part 1: what the load writes. Part 2: collecting it moves that IVA to 2120,
// the seeded account of IVA due, as a native PPD invoice's does, and a
// document whose IVA the previous system already caused (`ivaPending: false`)
// keeps its rate and moves none.
// ============================================================

const RFC = 'XAXX010101000';
const NS = 'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3';

/** [NumCta, Desc, SubCtaDe, CodAgrup, Nivel, Natur, SaldoFin at 2025-12-31]. */
const CHART: readonly (readonly [string, string, string | null, string, number, 'D' | 'A', string])[] = [
  ['100', 'Activo', null, '100', 1, 'D', '216000.00'],
  ['102', 'Bancos', '100', '102', 2, 'D', '100000.00'],
  ['102-001', 'Banco del Bajio', '102', '102.01', 3, 'D', '100000.00'],
  ['105', 'Clientes', '100', '105', 2, 'D', '116000.00'],
  ['105-001', 'Clientes nacionales', '105', '105.01', 3, 'D', '116000.00'],
  ['200', 'Pasivo', null, '200', 1, 'A', '16000.00'],
  ['209', 'IVA trasladado no cobrado', '200', '209', 2, 'A', '16000.00'],
  ['209-001', 'IVA trasladado no cobrado', '209', '209.01', 3, 'A', '16000.00'],
  ['300', 'Capital contable', null, '300', 1, 'A', '200000.00'],
  ['301', 'Capital social', '300', '301', 2, 'A', '200000.00'],
];
const CHART_XML =
  `<?xml version="1.0" encoding="UTF-8"?><catalogocuentas:Catalogo xmlns:catalogocuentas="${NS}/CatalogoCuentas" ` +
  `Version="1.3" RFC="${RFC}" Mes="12" Anio="2025">` +
  CHART.map(([num, desc, parent, group, level, nature]) =>
    `<catalogocuentas:Ctas CodAgrup="${group}" NumCta="${num}" Desc="${desc}"` +
    `${parent === null ? '' : ` SubCtaDe="${parent}"`} Nivel="${level}" Natur="${nature}"/>`).join('') +
  '</catalogocuentas:Catalogo>';
/** The trial balance of the previous system; `balances` overrides a SaldoFin by account. */
const trialBalance = (balances: Record<string, string> = {}): string =>
  `<?xml version="1.0" encoding="UTF-8"?><BCE:Balanza xmlns:BCE="${NS}/BalanzaComprobacion" ` +
  `Version="1.3" RFC="${RFC}" Mes="12" Anio="2025" TipoEnvio="N">` +
  CHART.map(([num, , , , , , balance]) => {
    const s = balances[num] ?? balance;
    return `<BCE:Ctas NumCta="${num}" SaldoIni="${s}" Debe="0.00" Haber="0.00" SaldoFin="${s}"/>`;
  }).join('') +
  '</BCE:Balanza>';

const A123_WITHOUT_RATE: OpeningDocument = {
  cuenta: '105-001', documento: 'A-123', contraparte: 'Aceros del Norte SA', rfc: 'ANO010101AAA',
  fecha: '2025-11-02', vencimiento: '2025-12-02', importe: '116000.00',
};
const A123: OpeningDocument = { ...A123_WITHOUT_RATE, ivaRate: '0.16' };

let f: Fixture;
const ctxOf = (fx: Fixture) => ({ tenantId: fx.tenantId, entityId: fx.entityId });

/** A sibling entity with the migrated chart and the roles the load and a collection read. */
async function migrated(name: string) {
  const own = await crearEntidadHermana(f, name);
  await importSatChart(ctxOf(own), { entityId: own.entityId, xml: CHART_XML, userId: own.userId });
  const ids = Object.fromEntries(
    (await query<{ code: string; id: string }>(`SELECT code, id FROM accounts WHERE entity_id = $1`, [own.entityId]))
      .rows.map((x) => [x.code, x.id])
  );
  for (const [role, code] of [['cxc', '105-001'], ['banco', '102-001'], ['iva_trasladado_no_cobrado', '209-001']]) {
    await setAccountRole(own.entityId, own.tenantId, role, ids[code], { userId: own.userId });
  }
  return { own, ids };
}
/** Answers the key for THIS entity; its row is seeded first, as `pending define` finds it. */
async function assumeZeroRate(own: Fixture): Promise<void> {
  await seedPolicies(ctxOf(own));
  await resolvePolicy(ctxOf(own), 'opening_receivable_iva', 'assume_zero_rate', own.userId, 'test');
}
const load = (own: Fixture, documents: OpeningDocument[] = [A123], xml = trialBalance()) =>
  importOpeningBalance(ctxOf(own), { entityId: own.entityId, xml, userId: own.userId, documentos: documents });

interface InvoiceRow {
  id: string; customer_id: string; subtotal: string; tax_amount: string; total_amount: string; amount_due: string;
  je: string | null; lines: string | null; pending: boolean | null; terms: string | null;
}
/** The invoices of the entity, each with its lines as «rate/code/base/IVA/total». */
const invoicesOf = async (entityId: string) =>
  (await query<InvoiceRow>(
    `SELECT i.id, i.customer_id, i.subtotal::text, i.tax_amount::text, i.total_amount::text, i.amount_due::text,
            i.journal_entry_id::text AS je, i.opening_iva_pending AS pending, i.terms,
            (SELECT string_agg(concat_ws('/', COALESCE(il.tax_rate::text, '-'), COALESCE(il.tax_code, '-'),
                                         il.line_amount::text, il.tax_amount::text, il.total_amount::text), ' | '
                               ORDER BY il.line_number)
               FROM invoice_lines il WHERE il.invoice_id = i.id) AS lines
       FROM invoices i WHERE i.entity_id = $1 ORDER BY i.invoice_number`,
    [entityId]
  )).rows;
const written = async (entityId: string) =>
  (await query<{ entries: string; invoices: string; customers: string }>(
    `SELECT (SELECT COUNT(*) FROM journal_entries WHERE entity_id = $1)::text AS entries,
            (SELECT COUNT(*) FROM invoices WHERE entity_id = $1)::text AS invoices,
            (SELECT COUNT(*) FROM customers WHERE entity_id = $1)::text AS customers`,
    [entityId]
  )).rows[0];
const NOTHING = { entries: '0', invoices: '0', customers: '0' };

beforeAll(async () => {
  f = await crearInquilino('MNE-001-946 opening receivable IVA');
  enterTenant(f.tenantId);
  await seedPolicies({ tenantId: f.tenantId });
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('MNE-001-946: an open receivable of the migration carries its IVA', () => {
  it('A-123 for 116,000.00 at 16 % is born 100,000.00 + 16,000.00, its rate on one line, hanging from the opening', async () => {
    const { own } = await migrated('MNE-001-946 the case');
    const r = await load(own);
    expect(r.findings.filter((x) => x.severidad === 'bloquea')).toEqual([]);
    expect(r.escrito).toBe(true);
    expect(r.arInvoices).toBe(1);
    // 116,000 / 1.16 = 100,000 exactly; the IVA is the rest.
    expect(await invoicesOf(own.entityId)).toEqual([
      expect.objectContaining({
        subtotal: '100000.0000', tax_amount: '16000.0000', total_amount: '116000.0000', amount_due: '116000.0000',
        je: r.asiento?.id, lines: '16.00/-/100000.0000/16000.0000/116000.0000',
        // Migration 348: its IVA is still to be caused, and the payment terms stay the invoice's own.
        pending: true, terms: null,
      }),
    ]);
    // No money of its own: the opening line is the only debit on the control account.
    const reconciliation = await arReconcile(own.entityId);
    expect(reconciliation.control_balance).toBe('116000.00');
    expect(reconciliation.delta).toBe('0.00');
  });

  it('a document with no rate: require_rate stops the load, names it and writes nothing; assume_zero_rate loads it at 0 % and warns', async () => {
    const { own } = await migrated('MNE-001-946 no rate');
    const stopped = await load(own, [A123_WITHOUT_RATE]);
    expect(stopped.escrito).toBe(false);
    expect(stopped.findings.filter((x) => x.regla.startsWith('APE-CXC-'))).toEqual([
      expect.objectContaining({
        regla: 'APE-CXC-SIN-TASA', severidad: 'bloquea', numCta: '105-001',
        messageKey: {
          key: 'migration.opening.receivable_rate_missing',
          params: { document: 'A-123', counterparty: 'Aceros del Norte SA' },
        },
      }),
    ]);
    expect(await written(own.entityId)).toEqual(NOTHING);

    await assumeZeroRate(own);
    const assumed = await load(own, [A123_WITHOUT_RATE]);
    expect(assumed.escrito).toBe(true);
    expect(assumed.findings.filter((x) => x.regla.startsWith('APE-CXC-'))).toEqual([
      expect.objectContaining({
        regla: 'APE-CXC-TASA-SUPUESTA', severidad: 'aviso',
        messageKey: { key: 'migration.opening.receivable_rate_assumed', params: { count: 1, documents: 'A-123' } },
      }),
    ]);
    expect(await invoicesOf(own.entityId)).toEqual([
      expect.objectContaining({
        subtotal: '116000.0000', tax_amount: '0.0000', total_amount: '116000.0000',
        lines: '0.00/-/116000.0000/0.0000/116000.0000',
      }),
    ]);
  });

  it('IVA above what the opening holds on the pending account blocks, naming the account and both figures', async () => {
    const { own } = await migrated('MNE-001-946 pending account short');
    // The source parks 15,000.00 only; the other 1,000.00 sits in capital so that it still foots.
    const short = trialBalance({
      '209-001': '15000.00', '209': '15000.00', '200': '15000.00', '301': '201000.00', '300': '201000.00',
    });
    const r = await load(own, [A123], short);
    expect(r.escrito).toBe(false);
    expect(r.findings.filter((x) => x.severidad === 'bloquea')).toEqual([
      expect.objectContaining({
        regla: 'APE-CXC-IVA-SIN-SALDO', numCta: '209-001',
        messageKey: {
          key: 'migration.opening.receivable_iva_not_parked',
          params: { tax: '16000.00', parked: '15000.00', account: '209-001', role: 'iva_trasladado_no_cobrado' },
        },
      }),
    ]);
    expect(await written(own.entityId)).toEqual(NOTHING);
  });

  it('a reload after voiding the opening (087) takes the invoice over with its rate: one invoice, one line', async () => {
    const { own } = await migrated('MNE-001-946 reload');
    await assumeZeroRate(own);
    const first = await load(own, [A123_WITHOUT_RATE]);
    const [before] = await invoicesOf(own.entityId);
    expect(before).toMatchObject({ tax_amount: '0.0000', lines: '0.00/-/116000.0000/0.0000/116000.0000' });

    await voidJournalEntry(first.asiento?.id ?? '', own.userId, 'the file did not say the rate');
    const second = await load(own);
    expect(second.escrito).toBe(true);
    expect(await invoicesOf(own.entityId)).toEqual([
      expect.objectContaining({
        id: before.id, subtotal: '100000.0000', tax_amount: '16000.0000', total_amount: '116000.0000',
        je: second.asiento?.id, lines: '16.00/-/100000.0000/16000.0000/116000.0000',
      }),
    ]);
    expect((await arReconcile(own.entityId)).delta).toBe('0.00');
  });
});

// ============================================================
// PART 2 · COLLECTING IT CAUSES ITS IVA (LIVA art. 1-B)
//
// 116,000.00 collected is the whole invoice: 16,000.00 leaves 209-001 for
// 2120. Half, 58,000.00, is 16,000 × 58,000 / 116,000 = 8,000.00.
// ============================================================

describe('MNE-001-946, part 2: collecting a migrated invoice releases its IVA as a native PPD invoice does', () => {
  type Codes = '209-001' | '2120' | '2150' | '105-001';
  /** Credit balances of the posted ledger on the pending-IVA, IVA-due and customer-advance accounts; debit on customers. */
  async function balances(own: Fixture): Promise<Record<Codes, string>> {
    const r = await query<{ code: Codes; b: string }>(
      `SELECT a.code, COALESCE(SUM(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)), 0)::numeric(19,2)::text AS b
         FROM accounts a
         LEFT JOIN journal_entry_lines l ON l.account_id = a.id
          AND l.journal_entry_id IN (SELECT id FROM journal_entries WHERE entity_id = $1 AND status = 'posted')
        WHERE a.entity_id = $1 AND a.code = ANY($2::text[]) GROUP BY a.code`,
      [own.entityId, ['209-001', '2120', '2150', '105-001']]
    );
    const of = (c: Codes) => r.rows.find((x) => x.code === c)?.b ?? '0.00';
    return { '209-001': of('209-001'), '2120': of('2120'), '2150': of('2150'), '105-001': of('105-001').replace(/^-/, '') };
  }
  /** What each allocation of the invoice stored as released, oldest first; `live` says whether it still applies. */
  const stored = async (own: Fixture, invoiceId: string) =>
    (await query<{ iva: string | null; live: boolean }>(
      `SELECT pa.iva_reclass_amount::text AS iva, pa.unapplied_at IS NULL AS live
         FROM payment_allocations pa JOIN invoices i ON i.id = pa.invoice_id
        WHERE i.entity_id = $1 AND pa.invoice_id = $2 ORDER BY pa.created_at`,
      [own.entityId, invoiceId]
    )).rows;
  const collect = (own: Fixture, invoice: InvoiceRow, amount: string, date = '2026-01-15') =>
    recordCustomerPayment(
      { entityId: own.entityId, counterpartyId: invoice.customer_id, paymentAmount: amount, paymentDate: date,
        paymentMethod: 'spei', applications: [{ documentId: invoice.id, amountApplied: amount }] },
      own.userId
    );
  /** The month's IVA paper: what it charges at 16 %, what it counts for one document, and its tie-out findings. */
  async function paper(own: Fixture, year: number, month: number, documentId: string) {
    const wp = await buildIvaWorkpaper({ tenantId: own.tenantId, entityId: own.entityId, year, month });
    return {
      at16: [Number(wp.figures.charged.tasa16.base).toFixed(2), Number(wp.figures.charged.tasa16.iva).toFixed(2)],
      document: wp.contributions.charged.find((c) => c.documentId === documentId)?.breakdown.tasa16 ?? null,
      untied: wp.findings.map((h) => h.codigo).filter((c) => c === 'IVA-WP-CHARGED-VS-LEDGER'),
    };
  }
  async function loaded(name: string, documents: OpeningDocument[] = [A123], xml = trialBalance()) {
    const { own } = await migrated(name);
    const r = await load(own, documents, xml);
    expect(r.escrito).toBe(true);
    const [invoice] = await invoicesOf(own.entityId);
    return { own, invoice, opening: r };
  }

  it('collected in full: 16,000.0000 goes from 209-001 to 2120, the allocation stores it, and January counts 100,000.00 / 16,000.00', async () => {
    const { own, invoice } = await loaded('MNE-001-946 collected in full');
    const receipt = await collect(own, invoice, '116000.00');
    expect(receipt.documentos).toEqual([expect.objectContaining({ numero: 'A-123', saldoNuevo: '0.00', estado: 'paid' })]);
    expect(await balances(own)).toEqual({ '209-001': '0.00', '2120': '16000.00', '2150': '0.00', '105-001': '0.00' });
    expect(await stored(own, invoice.id)).toEqual([{ iva: '16000.0000', live: true }]);

    expect(await paper(own, 2026, 1, invoice.id)).toEqual({
      at16: ['100000.00', '16000.00'], document: { base: '100000.0000', iva: '16000.0000' }, untied: [],
    });
    // The month of its own date, before go-live: a PPD invoice is never counted when issued.
    expect((await paper(own, 2025, 11, invoice.id)).document).toBeNull();
  });

  it('collected in halves: each 58,000.00 moves 8,000.0000, and nothing is left parked', async () => {
    const { own, invoice } = await loaded('MNE-001-946 collected in halves');
    await collect(own, invoice, '58000.00', '2026-01-15');
    expect(await balances(own)).toMatchObject({ '209-001': '8000.00', '2120': '8000.00', '105-001': '58000.00' });
    await collect(own, invoice, '58000.00', '2026-02-10');
    expect(await balances(own)).toMatchObject({ '209-001': '0.00', '2120': '16000.00', '105-001': '0.00' });
    expect(await stored(own, invoice.id)).toEqual([{ iva: '8000.0000', live: true }, { iva: '8000.0000', live: true }]);
    expect((await paper(own, 2026, 2, invoice.id)).document).toEqual({ base: '50000.0000', iva: '8000.0000' });
  });

  it('unapplied, the IVA stays caused and the cash goes on account with it (MNE-001-574); applied again, 2120 does not move', async () => {
    const { own, invoice } = await loaded('MNE-001-946 unapplied');
    const receipt = await collect(own, invoice, '116000.00');
    await unapplyCustomerPayment(
      own.entityId, receipt.paymentId, { invoiceId: invoice.id, reason: 'applied to the wrong sale', date: '2026-01-20' }, own.userId
    );
    // DR customers 116,000 / CR advances 100,000 / CR pending IVA 16,000: the receivable is owed again, with its IVA parked.
    expect(await balances(own)).toEqual({ '209-001': '16000.00', '2120': '16000.00', '2150': '100000.00', '105-001': '116000.00' });
    await applyCustomerPayment(
      own.entityId, receipt.paymentId, [{ documentId: invoice.id, amountApplied: '116000.00' }], own.userId, { date: '2026-01-25' }
    );
    expect(await balances(own)).toEqual({ '209-001': '0.00', '2120': '16000.00', '2150': '0.00', '105-001': '0.00' });
    expect((await stored(own, invoice.id)).map((x) => x.live)).toEqual([false, true]);
  });

  it('reversed, the mirror parks the 16,000.00 again; collected again, it is caused once, not twice', async () => {
    const { own, invoice } = await loaded('MNE-001-946 reversed');
    const receipt = await collect(own, invoice, '116000.00');
    await reverseCustomerPayment(own.entityId, receipt.paymentId, { reason: 'chargeback 4853', cause: 'taken_back' }, own.userId);
    expect(await balances(own)).toEqual({ '209-001': '16000.00', '2120': '0.00', '2150': '0.00', '105-001': '116000.00' });
    await collect(own, invoice, '116000.00', '2026-01-28');
    expect(await balances(own)).toEqual({ '209-001': '0.00', '2120': '16000.00', '2150': '0.00', '105-001': '0.00' });
  });

  it('a credit note before the collection takes its IVA from 209-001, and the collection releases only the rest', async () => {
    const { own, invoice } = await loaded('MNE-001-946 credit note');
    // A return of 10,000.00 + 1,600.00: the invoice has collected nothing, so all its IVA is still parked.
    const note = await createCreditNote({
      entity_id: own.entityId, customer_id: invoice.customer_id, invoice_id: invoice.id, type: 'devolucion',
      credit_date: '2026-01-10', subtotal: '10000.00', tax_amount: '1600.00',
    }, own.userId);
    await issueCreditNote(own.entityId, note.id, own.userId);
    await applyCreditNote(own.entityId, note.id, [{ invoiceId: invoice.id, amount: '11600.00' }], own.userId);
    expect(await balances(own)).toMatchObject({ '209-001': '14400.00', '2120': '0.00', '105-001': '104400.00' });
    // 16,000 × 104,400 / 116,000 = 14,400.00.
    await collect(own, invoice, '104400.00');
    expect(await balances(own)).toMatchObject({ '209-001': '0.00', '2120': '14400.00', '105-001': '0.00' });
    expect(await stored(own, invoice.id)).toEqual([{ iva: '14400.0000', live: true }]);
  });

  it('after a void and a reload (087) the invoice is collected against the standing opening: released once', async () => {
    const { own, opening } = await loaded('MNE-001-946 reload and collect');
    await voidJournalEntry(opening.asiento?.id ?? '', own.userId, 'wrong source file');
    expect((await load(own)).escrito).toBe(true);
    const [invoice] = await invoicesOf(own.entityId);
    // 209-001: +16,000 the first opening, -16,000 its reversal, +16,000 the second, -16,000 the collection.
    await collect(own, invoice, '116000.00');
    expect(await balances(own)).toEqual({ '209-001': '0.00', '2120': '16000.00', '2150': '0.00', '105-001': '0.00' });
    expect(await stored(own, invoice.id)).toEqual([{ iva: '16000.0000', live: true }]);
  });

  it('migration 348 adds one nullable boolean, with no default, and nothing else', async () => {
    const column = await query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = 'opening_iva_pending'`
    );
    expect(column.rows).toEqual([{ data_type: 'boolean', is_nullable: 'YES', column_default: null }]);
  });

  it('an invoice an opening loaded before the column existed (NULL, with IVA) is read as pending, the default the file has', async () => {
    const { own, invoice } = await loaded('MNE-001-946 loaded before the column');
    // What the load of part 1 left: base, IVA and line, and nothing in the column.
    await query(`UPDATE invoices SET opening_iva_pending = NULL WHERE id = $1 AND entity_id = $2`, [invoice.id, own.entityId]);
    await collect(own, invoice, '58000.00');
    expect(await balances(own)).toMatchObject({ '209-001': '8000.00', '2120': '8000.00' });
    expect(await stored(own, invoice.id)).toEqual([{ iva: '8000.0000', live: true }]);
    expect((await paper(own, 2026, 1, invoice.id)).document).toEqual({ base: '50000.0000', iva: '8000.0000' });
  });

  it('a cheque holds the IVA until the bank cashes it: nothing moves on the day it is received, 16,000.0000 on the day it is cashed', async () => {
    const { own, invoice } = await loaded('MNE-001-946 cheque');
    const account = uuidv4();
    const gl = (await query<{ id: string }>(`SELECT id FROM accounts WHERE entity_id = $1 AND code = '102-001'`, [own.entityId])).rows[0].id;
    await query(
      `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
       VALUES ($1, $2, 'Operating 946', 'Bank', $3, 'MXN', 'checking')`,
      [account, own.entityId, gl]
    );
    const held = await recordCustomerPayment(
      { entityId: own.entityId, counterpartyId: invoice.customer_id, paymentAmount: '116000.00', paymentDate: '2026-01-15',
        paymentMethod: 'check', bankAccountId: account, checkNumber: 'CHQ-946',
        applications: [{ documentId: invoice.id, amountApplied: '116000.00' }] },
      own.userId
    );
    // Received, not paid (LIVA art. 1-B, second paragraph): the receivable is settled and its IVA stays parked.
    expect(await balances(own)).toEqual({ '209-001': '16000.00', '2120': '0.00', '2150': '0.00', '105-001': '0.00' });
    expect(await stored(own, invoice.id)).toEqual([{ iva: '0.0000', live: true }]);

    const credit = uuidv4();
    await query(
      `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type, description, is_matched)
       VALUES ($1, $2, '2026-02-03', '116000.00', 'credit', 'synthetic deposit', false)`,
      [credit, account]
    );
    await recordCustomerCheckCashing(own.entityId, held.paymentId, { transactionId: credit, userId: own.userId });
    expect(await balances(own)).toEqual({ '209-001': '0.00', '2120': '16000.00', '2150': '0.00', '105-001': '0.00' });
    expect(await stored(own, invoice.id)).toEqual([{ iva: '16000.0000', live: true }]);
    // The paper follows the cashing: February, not January.
    expect((await paper(own, 2026, 1, invoice.id)).document).toBeNull();
    expect((await paper(own, 2026, 2, invoice.id)).document).toEqual({ base: '100000.0000', iva: '16000.0000' });
  });

  it('`ivaPending: false`: IVA the previous system already caused keeps its rate, needs nothing parked and releases nothing', async () => {
    // The source holds nothing as not yet collected: the 16,000.00 sit in capital, already declared.
    const caused = trialBalance({ '209-001': '0.00', '209': '0.00', '200': '0.00', '301': '216000.00', '300': '216000.00' });
    const { own, invoice, opening } = await loaded('MNE-001-946 already caused', [{ ...A123, ivaPending: false }], caused);
    expect(opening.findings.filter((x) => x.regla.startsWith('APE-CXC-'))).toEqual([
      expect.objectContaining({
        regla: 'APE-CXC-IVA-YA-CAUSADO', severidad: 'aviso',
        messageKey: { key: 'migration.opening.receivable_iva_settled', params: { count: 1, tax: '16000.00', documents: 'A-123' } },
      }),
    ]);
    expect(invoice).toMatchObject({
      subtotal: '100000.0000', tax_amount: '16000.0000', lines: '16.00/-/100000.0000/16000.0000/116000.0000',
      pending: false, terms: null,
    });
    await collect(own, invoice, '116000.00');
    expect(await balances(own)).toEqual({ '209-001': '0.00', '2120': '0.00', '2150': '0.00', '105-001': '0.00' });
    expect(await stored(own, invoice.id)).toEqual([{ iva: '0.0000', live: true }]);
    // The month it is collected counts nothing for it: its IVA was caused before the opening.
    expect(await paper(own, 2026, 1, invoice.id)).toEqual({ at16: ['0.00', '0.00'], document: null, untied: [] });
    // The month of its own date, before go-live, reads it as caused then, whole.
    expect((await paper(own, 2025, 11, invoice.id)).document).toEqual({ base: '100000.0000', iva: '16000.0000' });
  });
});
